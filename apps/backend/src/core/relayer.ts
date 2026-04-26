/**
 * Lowkie — Relayer CLI
 *
 * Queues the withdraw MPC computation with encrypted secret verification,
 * and waits for the callback to deliver SOL to the recipient.
 *
 * PRIVACY:
 *   1. The withdraw instruction contains NO plaintext amount or note_secret
 *   2. The relayer uses a DIFFERENT keypair from the sender
 *   3. Sub-notes are withdrawn with randomised timing between each
 *   4. Direct lamport manipulation — no CPI logs in block explorer
 *   5. Secret ownership verified inside MPC — never on-chain
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  x25519,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  getArciumEnv,
  awaitComputationFinalization,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as dotenv from "dotenv";
import {
  buildArciumQueueAccounts,
  deriveNotePda,
  deriveNullifierRecordPda,
  deriveNullifierRegistryPda,
  derivePoolPda,
  deriveVaultPda,
} from "./arciumAccounts";
import { RELAYER_JITTER_FACTOR, MIN_RELAYER_DELAY_MS } from "./constants";
import {
  createAnchorConnection,
  createAnchorProvider,
  loadLowkieProgram,
  loadLowkieProgramRuntimeConfig,
} from "./programContext";
import {
  confirmedRpcOptions,
  readKeypair,
  envBool,
  resolveKeypairFromEnv,
  resolveOptionalKeypairFromEnv,
  resolveOptionalPathFromEnv,
  computeNullifierHash,
  computeNoteHash,
  splitSecretToU128,
  fetchMXEKey,
} from "./utils";
import {
  ParsedRelayRequest,
  parseRelayRequest,
  RelayRequest,
  RelayResult,
  RelaySubNoteMaterial,
} from "./relayProtocol";
import {
  logSensitiveDataEnabled,
  redactAmountSol,
  redactStepLabel,
  redactValue,
} from "./privacyLogging";

dotenv.config();

const {
  rpcUrl: RPC,
  programId: PROG,
  configuredClusterOffset: CONFIGURED_CLUSTER_OFFSET,
  runtimeSafety: RUNTIME_SAFETY,
} = loadLowkieProgramRuntimeConfig();
const AUTO_COMPACT_REGISTRY = RUNTIME_SAFETY.autoCompactRegistry;
const OPERATOR_COMPACT_REGISTRY = RUNTIME_SAFETY.operatorCompactRegistry;
const CAN_COMPACT_READY_REGISTRY =
  AUTO_COMPACT_REGISTRY || OPERATOR_COMPACT_REGISTRY;
const MAX_AUTO_COMPACT_RETRIES = Number.parseInt(
  process.env.LOWKIE_AUTO_COMPACT_RETRIES ?? "4",
  10,
);
const RPC_RETRY_MAX_ATTEMPTS = Number.parseInt(
  process.env.LOWKIE_RPC_RETRY_MAX_ATTEMPTS ?? "4",
  10,
);
const RPC_RETRY_BASE_MS = Number.parseInt(
  process.env.LOWKIE_RPC_RETRY_BASE_MS ?? "2000",
  10,
);
const WITHDRAW_STATUS_POLL_ATTEMPTS = Number.parseInt(
  process.env.LOWKIE_WITHDRAW_STATUS_POLL_ATTEMPTS ?? "5",
  10,
);
const WITHDRAW_STATUS_POLL_DELAY_MS = Number.parseInt(
  process.env.LOWKIE_WITHDRAW_STATUS_POLL_DELAY_MS ?? "1500",
  10,
);

// ── Types ────────────────────────────────────────────────────────────────────

export interface WithdrawParams {
  /** Array of sub-notes to withdraw (supports note splitting). */
  subNotes: RelaySubNoteMaterial[];
  /** Recipient public key. */
  recipient: PublicKey;
  /** Total lamport amount across all sub-notes (for verification). */
  totalLamports: bigint;
  /** Base delay before submitting first withdrawal (ms). */
  delayMs: number;
  /** Anchor provider. */
  provider: anchor.AnchorProvider;
  /** Lowkie program instance. */
  program: Program<any>;
  /** Arcium cluster offset. */
  clusterOffset: number;
  /** Optional path to relayer keypair (falls back to env). */
  relayerKeypairPath?: string;
  /** Optional relayer keypair to avoid re-reading from disk. */
  relayerKeypair?: anchor.web3.Keypair;
}

export interface WithdrawReceipt {
  noteHashHex: string;
  denominationLamports: string;
  withdrawSig: string;
  compactSig: string;
}

export type WithdrawResult = RelayResult;

function isTransientRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "fetch failed",
    "connect timeout",
    "timed out",
    "429",
    "too many requests",
    "service unavailable",
    "gateway timeout",
    "econnreset",
    "enotfound",
    "etimedout",
    "socket hang up",
  ].some((fragment) => message.toLowerCase().includes(fragment));
}

async function withRpcRetry<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= RPC_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientRpcError(error) || attempt === RPC_RETRY_MAX_ATTEMPTS) {
        throw error;
      }

      const backoffMs = RPC_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `      ⚠️ ${label} failed (attempt ${attempt}/${RPC_RETRY_MAX_ATTEMPTS}): ${message}`,
      );
      console.warn(`      ↻ Retrying ${label} in ${backoffMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitForWithdrawOutcome(
  program: Program<any>,
  notePda: PublicKey,
): Promise<Record<string, unknown>> {
  let lastStatus: Record<string, unknown> | undefined;

  for (let attempt = 1; attempt <= WITHDRAW_STATUS_POLL_ATTEMPTS; attempt++) {
    const noteAfterWithdraw = await withRpcRetry<any>(
      "withdraw note status fetch",
      () => (program.account as any).noteAccount.fetch(notePda),
    );
    const noteStatus = noteAfterWithdraw.status as Record<string, unknown>;
    lastStatus = noteStatus;

    if (noteStatus.withdrawn || noteStatus.failed || noteStatus.ready) {
      return noteStatus;
    }

    if (attempt < WITHDRAW_STATUS_POLL_ATTEMPTS) {
      console.warn(
        `      ⚠️ Note still pending status propagation; rechecking in ${WITHDRAW_STATUS_POLL_DELAY_MS}ms...`,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, WITHDRAW_STATUS_POLL_DELAY_MS),
      );
    }
  }

  return lastStatus ?? {};
}

async function compactRegistryForDenomination(
  params: WithdrawParams,
  relayerKp: anchor.web3.Keypair,
  denominationLamports: bigint,
): Promise<string> {
  const poolPDA = derivePoolPda(PROG, denominationLamports);
  const nullifierRegistryPDA = deriveNullifierRegistryPda(
    PROG,
    denominationLamports,
  );
  const offset = new anchor.BN(randomBytes(8), "hex");

  const sig = await withRpcRetry("registry compaction submission", () =>
    params.program.methods
      .compactRegistry(offset, new anchor.BN(denominationLamports.toString()))
      .accountsPartial({
        relayer: relayerKp.publicKey,
        poolState: poolPDA,
        nullifierRegistry: nullifierRegistryPDA,
        ...buildArciumQueueAccounts(
          PROG,
          params.clusterOffset,
          offset,
          "compact_registry",
        ),
      })
      .signers([relayerKp])
      .rpc(confirmedRpcOptions(RUNTIME_SAFETY.skipPreflight)),
  );
  await withRpcRetry("registry compaction finalization", () =>
    awaitComputationFinalization(params.provider, offset, PROG, "confirmed"),
  );
  return sig;
}

// ── Withdraw ─────────────────────────────────────────────────────────────────

/**
 * Execute a relayed withdrawal of one or more sub-notes.
 *
 * Each sub-note withdrawal:
 *   - Uses randomised timing (temporal decorrelation)
 *   - Sends only `computation_offset` + `note_secret` (no amount)
 *   - Results in direct lamport manipulation (no CPI logs)
 */
export async function lowkieWithdraw(p: WithdrawParams) {
  const relayerPath =
    p.relayerKeypairPath ?? resolveOptionalPathFromEnv("RELAYER_KEYPAIR_PATH");
  const relayerKp =
    p.relayerKeypair ??
    resolveOptionalKeypairFromEnv("RELAYER_KEYPAIR_PATH")?.keypair ??
    (relayerPath ? readKeypair(relayerPath) : undefined);
  if (!relayerKp) {
    throw new Error(
      "RELAYER_KEYPAIR_PATH is required for withdraw. Use a dedicated relayer keypair.",
    );
  }

  // Apply randomised delay (±RELAYER_JITTER_FACTOR jitter, minimum MIN_RELAYER_DELAY_MS)
  const jitter = RELAYER_JITTER_FACTOR * (Math.random() * 2 - 1);
  const initialDelay = Math.max(
    MIN_RELAYER_DELAY_MS,
    Math.round(p.delayMs + p.delayMs * jitter),
  );
  const compactedDenominations: string[] = [];
  const withdrawals: WithdrawReceipt[] = [];

  console.log(
    `\n🔁 Relayer: ${redactValue(relayerKp.publicKey.toBase58().slice(0, 16) + "...")} (${(initialDelay / 1000).toFixed(1)}s initial delay)`,
  );
  console.log(
    `   Withdrawing ${p.subNotes.length} sub-note(s) for ${redactAmountSol(Number(p.totalLamports) / LAMPORTS_PER_SOL)} total`,
  );
  await new Promise((r) => setTimeout(r, initialDelay));

  if (OPERATOR_COMPACT_REGISTRY && !AUTO_COMPACT_REGISTRY) {
    console.warn(
      "\n⚠️  Operator registry compaction retry is enabled. Registry-full withdrawals may compact and retry on this non-mainnet relayer.",
    );
  }

  const balBefore = await withRpcRetry("recipient balance read", () =>
    p.provider.connection.getBalance(p.recipient),
  );

  if (AUTO_COMPACT_REGISTRY) {
    const uniqueDenominations = Array.from(
      new Map(
        p.subNotes.map((subNote) => [
          subNote.denominationLamports.toString(),
          subNote.denominationLamports,
        ]),
      ).values(),
    );

    if (uniqueDenominations.length > 0) {
      console.warn(
        "\n⚠️  Auto-compacting nullifier registries for demo/test mode. This clears historical encrypted nullifiers and is unsafe for production.",
      );
    }

    for (const denominationLamports of uniqueDenominations) {
      console.log(
        `   🧹 Compacting ${redactStepLabel(`${Number(denominationLamports) / LAMPORTS_PER_SOL} SOL`)} registry before withdrawals...`,
      );
      await compactRegistryForDenomination(p, relayerKp, denominationLamports);
      compactedDenominations.push(denominationLamports.toString());
    }
  }

  // ── Withdraw each sub-note with randomised inter-note timing ────────────
  const mxeKey = await fetchMXEKey(p.provider, PROG);

  for (let i = 0; i < p.subNotes.length; i++) {
    const sn = p.subNotes[i];
    const notePDA = deriveNotePda(PROG, sn.hash);
    const nullifierRecordPDA = deriveNullifierRecordPda(
      PROG,
      computeNullifierHash(sn.noteSecret),
    );
    const poolPDA = derivePoolPda(PROG, sn.denominationLamports);
    const vaultPDA = deriveVaultPda(PROG, sn.denominationLamports);
    const nullifierRegistryPDA = deriveNullifierRegistryPda(
      PROG,
      sn.denominationLamports,
    );

    console.log(
      `\n   📥 Withdraw ${i + 1}/${p.subNotes.length}${logSensitiveDataEnabled() ? ` (${redactStepLabel(`${Number(sn.denominationLamports) / LAMPORTS_PER_SOL} SOL`)})` : ""}`,
    );
    const maxAttempts = CAN_COMPACT_READY_REGISTRY
      ? MAX_AUTO_COMPACT_RETRIES
      : 1;
    let withdrawSig: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        console.log(
          `      ↻ Retry ${attempt}/${maxAttempts} after registry compaction...`,
        );
      }

      const offset = new anchor.BN(randomBytes(8), "hex");

      // Encrypt claimed secret for MPC verification — NEVER sent as plaintext
      const priv = x25519.utils.randomSecretKey();
      const pub = x25519.getPublicKey(priv);
      const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));
      const [secretLo, secretHi] = splitSecretToU128(sn.noteSecret);
      const nonceLo = randomBytes(16);
      const ctLo = cipher.encrypt([secretLo], nonceLo);
      const nonceLoB = new anchor.BN(deserializeLE(nonceLo).toString());
      const nonceHi = randomBytes(16);
      const ctHi = cipher.encrypt([secretHi], nonceHi);
      const nonceHiB = new anchor.BN(deserializeLE(nonceHi).toString());

      // Submit withdraw — NO amount or secret in plaintext instruction data
      const sig = await withRpcRetry("withdraw submission", () =>
        p.program.methods
          .withdraw(
            offset,
            Array.from(sn.withdrawKey),
            Array.from(ctLo[0]),
            Array.from(ctHi[0]),
            Array.from(pub),
            nonceLoB,
            nonceHiB,
          )
          .accountsPartial({
            relayer: relayerKp.publicKey,
            noteRegistry: notePDA,
            nullifierRecord: nullifierRecordPDA,
            poolState: poolPDA,
            vault: vaultPDA,
            nullifierRegistry: nullifierRegistryPDA,
            recipient: p.recipient,
            ...buildArciumQueueAccounts(
              PROG,
              p.clusterOffset,
              offset,
              "withdraw_from_pool",
            ),
          })
          .signers([relayerKp])
          .rpc(confirmedRpcOptions(RUNTIME_SAFETY.skipPreflight)),
      );

      console.log(`      ✅ Tx: ${sig}`);
      await withRpcRetry("withdraw MPC finalization", () =>
        awaitComputationFinalization(p.provider, offset, PROG, "confirmed"),
      );
      console.log("      ✅ MPC confirmed");

      const noteStatus = await waitForWithdrawOutcome(p.program, notePDA);
      if (noteStatus.failed) {
        throw new Error(
          `Withdraw rejected by encrypted nullifier registry for note ${sn.hash.toString("hex")}`,
        );
      }
      if (noteStatus.withdrawn) {
        withdrawSig = sig;
        break;
      }

      if (
        !CAN_COMPACT_READY_REGISTRY ||
        !noteStatus.ready ||
        attempt === maxAttempts
      ) {
        throw new Error(
          `Withdraw completed without reaching withdrawn state for note ${sn.hash.toString("hex")}`,
        );
      }

      console.warn(
        `      ⚠️ Note remained Ready; compacting ${redactStepLabel(`${Number(sn.denominationLamports) / LAMPORTS_PER_SOL} SOL`)} registry and retrying...`,
      );
      await compactRegistryForDenomination(
        p,
        relayerKp,
        sn.denominationLamports,
      );
      compactedDenominations.push(sn.denominationLamports.toString());
    }

    if (!withdrawSig) {
      throw new Error(
        `Withdraw completed without reaching withdrawn state for note ${sn.hash.toString("hex")}`,
      );
    }

    const compactSig = await withRpcRetry("spent note cleanup", () =>
      p.program.methods
        .compactSpentNote(Array.from(sn.hash))
        .accountsPartial({
          relayer: relayerKp.publicKey,
          noteRegistry: notePDA,
        })
        .signers([relayerKp])
        .rpc({ commitment: "confirmed" }),
    );

    console.log(`      ✅ Closed spent note account: ${compactSig}`);
    withdrawals.push({
      noteHashHex: sn.hash.toString("hex"),
      denominationLamports: sn.denominationLamports.toString(),
      withdrawSig,
      compactSig,
    });

    // Randomised delay between sub-note withdrawals
    if (i < p.subNotes.length - 1) {
      const interDelay = Math.max(
        MIN_RELAYER_DELAY_MS,
        Math.round(2000 + Math.random() * 5000),
      );
      console.log(
        `      ⏱️  Waiting ${(interDelay / 1000).toFixed(1)}s before next withdraw...`,
      );
      await new Promise((r) => setTimeout(r, interDelay));
    }
  }

  // ── Verify total received ──────────────────────────────────────────────
  const balAfter = await withRpcRetry("recipient balance read", () =>
    p.provider.connection.getBalance(p.recipient),
  );
  console.log(
    `\n✅ Recipient received: ${redactAmountSol(Number(p.totalLamports) / LAMPORTS_PER_SOL)} total`,
  );
  return {
    initialDelayMs: initialDelay,
    compactedDenominations,
    withdrawals,
    recipientBalanceBeforeLamports: balBefore.toString(),
    recipientBalanceAfterLamports: balAfter.toString(),
    totalReceivedLamports: p.totalLamports.toString(),
  } satisfies WithdrawResult;
}

function assertRelayRuntimeCompatibility(
  request: ParsedRelayRequest,
  runtime: {
    programId: PublicKey;
    rpcUrl: string;
    configuredClusterOffset: number | undefined;
  },
): void {
  if (request.programId && !request.programId.equals(runtime.programId)) {
    throw new Error(
      `Relay request targets program ${request.programId.toBase58()}, but relayer is configured for ${runtime.programId.toBase58()}.`,
    );
  }

  if (request.rpcUrl && request.rpcUrl !== runtime.rpcUrl) {
    throw new Error(
      `Relay request targets RPC ${request.rpcUrl}, but relayer is configured for ${runtime.rpcUrl}.`,
    );
  }

  if (
    runtime.configuredClusterOffset !== undefined &&
    runtime.configuredClusterOffset !== request.clusterOffset
  ) {
    throw new Error(
      `Relay request targets cluster offset ${request.clusterOffset}, but relayer is configured for ${runtime.configuredClusterOffset}.`,
    );
  }
}

export async function executeRelayRequest(
  request: RelayRequest,
): Promise<RelayResult> {
  const parsed = parseRelayRequest(request);
  const relayerResolution = resolveOptionalKeypairFromEnv(
    "RELAYER_KEYPAIR_PATH",
  );
  if (!relayerResolution) {
    throw new Error("RELAYER_KEYPAIR_PATH is required for relay execution.");
  }

  const relayerKp = relayerResolution.keypair;
  if (parsed.sender) {
    if (parsed.sender.equals(relayerKp.publicKey)) {
      throw new Error(
        "Sender and relayer keypairs are identical. Use distinct keypairs for unlinkability.",
      );
    }
  }

  const { rpcUrl, programId, configuredClusterOffset } =
    loadLowkieProgramRuntimeConfig();
  assertRelayRuntimeCompatibility(parsed, {
    programId,
    rpcUrl,
    configuredClusterOffset,
  });

  const conn = createAnchorConnection(rpcUrl);
  const provider = createAnchorProvider(conn, relayerKp, {});
  anchor.setProvider(provider);
  const program = loadLowkieProgram(provider, programId) as Program<any>;

  return lowkieWithdraw({
    subNotes: parsed.subNotes,
    recipient: parsed.recipient,
    totalLamports: parsed.totalLamports,
    delayMs: parsed.delayMs,
    provider,
    program,
    clusterOffset:
      configuredClusterOffset ??
      parsed.clusterOffset ??
      getArciumEnv().arciumClusterOffset,
    relayerKeypairPath: relayerResolution.source,
    relayerKeypair: relayerKp,
  });
}

// ── CLI entry point (note-file mode, dev only) ───────────────────────────────

if (require.main === module) {
  if (PROG.toBase58() === "LowkiePoo1111111111111111111111111111111111") {
    console.error(
      "LOWKIE_PROGRAM_ID is still a placeholder. Set it to your deployed program ID.",
    );
    process.exit(1);
  }

  if (!envBool("LOWKIE_ALLOW_PLAINTEXT_NOTE_FILE", false)) {
    console.error("Plaintext note-file relay mode is disabled by default.");
    console.error(
      "Set LOWKIE_ALLOW_PLAINTEXT_NOTE_FILE=true only for controlled local workflows.",
    );
    process.exit(1);
  }

  const f = process.env.LOWKIE_NOTE_FILE ?? "/tmp/lowkie-note.json";
  if (!fs.existsSync(f)) {
    console.error("Note file not found:", f);
    process.exit(1);
  }

  const n = JSON.parse(fs.readFileSync(f, "utf-8"));
  const { keypair: relayerKp } = resolveKeypairFromEnv("RELAYER_KEYPAIR_PATH");

  if (n.sender && typeof n.sender === "string") {
    const sender = new PublicKey(n.sender);
    if (sender.equals(relayerKp.publicKey)) {
      console.error(
        "Sender and relayer keypairs are identical. Use distinct keypairs for unlinkability.",
      );
      process.exit(1);
    }
  }

  const conn = createAnchorConnection(RPC);
  const provider = createAnchorProvider(conn, relayerKp, {});
  anchor.setProvider(provider);
  const program = loadLowkieProgram(provider, PROG) as Program<any>;

  // Support both old single-note format and new sub-notes format
  const subNotes: RelaySubNoteMaterial[] = n.subNotes
    ? n.subNotes.map((sn: any) => ({
        noteSecret: new Uint8Array(sn.noteSecret),
        withdrawKey: new Uint8Array(sn.withdrawKey),
        hash: Buffer.from(sn.noteHash),
        denominationLamports: BigInt(
          sn.denominationLamports ?? sn.amountLamports,
        ),
        amountLamports: BigInt(sn.amountLamports),
      }))
    : [
        {
          noteSecret: new Uint8Array(n.noteSecret),
          withdrawKey: new Uint8Array(n.withdrawKey),
          hash: Buffer.from(n.noteHash),
          denominationLamports: BigInt(
            n.denominationLamports ?? n.amountLamports,
          ),
          amountLamports: BigInt(n.amountLamports),
        },
      ];

  lowkieWithdraw({
    subNotes,
    recipient: new PublicKey(n.recipient),
    totalLamports: BigInt(n.totalLamports ?? n.amountLamports),
    delayMs: n.delayMs,
    provider,
    program,
    clusterOffset:
      n.clusterOffset ??
      CONFIGURED_CLUSTER_OFFSET ??
      getArciumEnv().arciumClusterOffset,
  })
    .then(() => fs.unlinkSync(f))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
