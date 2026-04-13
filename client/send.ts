/**
 * Lowkie — Sender CLI
 *
 * Deposits SOL into the privacy pool and triggers a relayed withdrawal.
 *
 * Usage:
 *   RECIPIENT=<pubkey> AMOUNT_SOL=0.1 ts-node client/send.ts
 *
 * Privacy features:
 *   1. Recipient is stored as SHA256(secret || recipient) — hidden until withdrawal
 *   2. Amounts are decomposed into fixed denomination notes across pool tiers
 *   3. Withdraw instruction contains NO plaintext amount
 *   4. Withdraw uses direct lamport manipulation (no CPI logs)
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  x25519,
  RescueCipher,
  deserializeLE,
  getArciumEnv,
  awaitComputationFinalization,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as dotenv from "dotenv";
import {
  buildArciumQueueAccounts,
  deriveNotePda,
  derivePoolPda,
  deriveVaultPda,
} from "./arciumAccounts";
import {
  DEFAULT_RELAYER_DELAY_MS,
  DEFAULT_WALLET_PATH,
  SUPPORTED_DENOMINATION_LAMPORTS,
} from "./constants";
import {
  createAnchorConnection,
  createAnchorProvider,
  loadLowkieProgram,
  loadLowkieProgramRuntimeConfig,
} from "./programContext";
import {
  readKeypair,
  assertDistinctKeypairs,
  computeNoteHash,
  computeRecipientHash,
  decomposeIntoDenominations,
  fetchMXEKey,
  splitSecretToU128,
} from "./utils";
import {
  logSensitiveDataEnabled,
  redactAmountSol,
  redactDenominationSummary,
  redactStepLabel,
  redactValue,
} from "./privacyLogging";

dotenv.config();

/** Delay between denomination note deposits to add temporal decorrelation (ms). */
const DEPOSIT_SPREAD_DELAY_MS = parseInt(
  process.env.DEPOSIT_SPREAD_DELAY_MS ?? process.env.SPLIT_DELAY_MS ?? "2000",
);
const MIN_RELAYER_BALANCE_LAMPORTS = Math.floor(0.05 * LAMPORTS_PER_SOL);
const LOCALNET_RELAYER_AIRDROP_LAMPORTS = Math.floor(0.5 * LAMPORTS_PER_SOL);

// ── Types ────────────────────────────────────────────────────────────────────

interface SubNote {
  noteSecret: Uint8Array;
  withdrawKey: Uint8Array;
  noteHash: Buffer;
  recipientHash: Buffer;
  denominationLamports: bigint;
  amountLamports: bigint;
  notePDA: PublicKey;
}

export interface DepositReceipt {
  noteHashHex: string;
  notePda: string;
  denominationLamports: string;
  depositSig: string;
}

export interface SendResult {
  recipient: string;
  totalLamports: string;
  delayMs: number;
  clusterOffset: number;
  depositReceipts: DepositReceipt[];
  initialDelayMs: number;
  compactedDenominations: string[];
  withdrawals: Array<{
    noteHashHex: string;
    denominationLamports: string;
    withdrawSig: string;
    compactSig: string;
  }>;
  recipientBalanceBeforeLamports: string;
  recipientBalanceAfterLamports: string;
  totalReceivedLamports: string;
}

function formatSol(lamports: bigint): string {
  return `${Number(lamports) / LAMPORTS_PER_SOL} SOL`;
}

function summarizeDenominationNotes(notes: bigint[]): string {
  const counts = new Map<
    string,
    { denominationLamports: bigint; count: number }
  >();

  for (const denominationLamports of notes) {
    const key = denominationLamports.toString();
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    counts.set(key, { denominationLamports, count: 1 });
  }

  return Array.from(counts.values())
    .sort((left, right) =>
      Number(right.denominationLamports - left.denominationLamports),
    )
    .map(
      ({ denominationLamports, count }) =>
        `${formatSol(denominationLamports)} x${count}`,
    )
    .join(", ");
}

async function ensureRelayerBalance(
  connection: Connection,
  relayerKp: anchor.web3.Keypair,
  network: string,
): Promise<void> {
  const balanceLamports = await connection.getBalance(
    relayerKp.publicKey,
    "confirmed",
  );
  if (balanceLamports >= MIN_RELAYER_BALANCE_LAMPORTS) {
    return;
  }

  if (network !== "localnet") {
    throw new Error(
      `Relayer ${relayerKp.publicKey.toBase58()} has only ${balanceLamports / LAMPORTS_PER_SOL} SOL. Fund RELAYER_KEYPAIR_PATH before sending through the frontend bridge.`,
    );
  }

  console.log(
    `\n💧 Funding localnet relayer ${relayerKp.publicKey.toBase58()}...`,
  );
  const signature = await connection.requestAirdrop(
    relayerKp.publicKey,
    LOCALNET_RELAYER_AIRDROP_LAMPORTS,
  );
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    { signature, ...latestBlockhash },
    "confirmed",
  );
}

/**
 * Execute a full Lowkie send: deposit SOL → MPC → relayed withdrawal.
 *
 * @param recipientStr - Base58 public key of the recipient
 * @param amountSol    - Amount to transfer in SOL
 * @param delayMs      - Delay before relayer withdrawal (ms)
 */
export async function lowkieSend(
  recipientStr: string,
  amountSol: number,
  delayMs = DEFAULT_RELAYER_DELAY_MS,
): Promise<SendResult> {
  const {
    rpcUrl,
    network,
    programId,
    configuredClusterOffset,
    runtimeSafety,
  } = loadLowkieProgramRuntimeConfig();
  const conn = createAnchorConnection(rpcUrl);
  const senderKp = readKeypair(
    process.env.SENDER_WALLET ?? DEFAULT_WALLET_PATH,
  );

  const relayerPath = process.env.RELAYER_KEYPAIR_PATH;
  if (!relayerPath) {
    throw new Error(
      "RELAYER_KEYPAIR_PATH is required. Use a dedicated relayer keypair (must differ from ANCHOR_WALLET).",
    );
  }
  const relayerKp = readKeypair(relayerPath);
  assertDistinctKeypairs(senderKp, relayerKp);

  const provider = createAnchorProvider(conn, senderKp);
  anchor.setProvider(provider);
  const program = loadLowkieProgram(provider, programId) as Program<any>;

  const arciumEnv = getArciumEnv();
  const clusterOffset =
    configuredClusterOffset ?? arciumEnv.arciumClusterOffset;

  await ensureRelayerBalance(conn, relayerKp, network);

  const recipient = new PublicKey(recipientStr);
  const totalLamports = BigInt(Math.round(amountSol * LAMPORTS_PER_SOL));

  console.log(`\n🔒 Lowkie Send`);
  console.log(`   Sender:    ${redactValue(senderKp.publicKey.toBase58())}`);
  console.log(`   Relayer:   ${redactValue(relayerKp.publicKey.toBase58())}`);
  console.log(`   Recipient: ${redactValue(recipient.toBase58())}`);
  console.log(`   Amount:    ${redactAmountSol(amountSol)}`);
  console.log(
    `   Pools:     ${SUPPORTED_DENOMINATION_LAMPORTS.map((denominationLamports) => formatSol(denominationLamports)).join(", ")}`,
  );
  console.log(`   Network:   ${network}`);
  console.log(`   Cluster:   ${clusterOffset}`);

  // ── Decompose amount into fixed denomination notes ──────────────────────
  const denominationNotes = decomposeIntoDenominations(totalLamports);
  console.log(
    `\n🧩 Denomination notes: ${redactDenominationSummary(
      summarizeDenominationNotes(denominationNotes),
      denominationNotes.length,
    )}`,
  );

  const mxeKey = await fetchMXEKey(provider, programId);
  const subNotes: SubNote[] = [];
  const depositReceipts: DepositReceipt[] = [];
  const poolCache = new Map<
    string,
    { poolPDA: PublicKey; vaultPDA: PublicKey }
  >();

  async function resolvePoolAccounts(denominationLamports: bigint) {
    const key = denominationLamports.toString();
    const cached = poolCache.get(key);
    if (cached) {
      return cached;
    }

    const poolPDA = derivePoolPda(programId, denominationLamports);
    const vaultPDA = deriveVaultPda(programId, denominationLamports);
    const pool = await (program.account as any).poolState.fetch(poolPDA);
    if (!pool.isInitialized) {
      throw new Error(
        `Pool ${formatSol(denominationLamports)} is not initialised`,
      );
    }

    const configuredDenomination = BigInt(pool.denominationLamports.toString());
    if (configuredDenomination !== denominationLamports) {
      throw new Error(
        `Pool ${poolPDA.toBase58()} is configured for ${configuredDenomination.toString()} lamports, expected ${denominationLamports.toString()}`,
      );
    }

    const resolved = { poolPDA, vaultPDA };
    poolCache.set(key, resolved);
    return resolved;
  }

  // ── Submit each denomination note deposit ───────────────────────────────
  for (let i = 0; i < denominationNotes.length; i++) {
    const subAmount = denominationNotes[i];
    const { poolPDA, vaultPDA } = await resolvePoolAccounts(subAmount);
    const noteSecret = new Uint8Array(randomBytes(32));
    const withdrawKey = new Uint8Array(randomBytes(32));
    const recipientHash = computeRecipientHash(withdrawKey, recipient);
    const noteHash = computeNoteHash(noteSecret, recipient, subAmount);
    const notePDA = deriveNotePda(programId, noteHash);

    // Encrypt the transfer amount for MPC
    const priv = x25519.utils.randomSecretKey();
    const pub = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([subAmount], nonce);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

    // Encrypt note secret (split into two u128 limbs) — NEVER sent as plaintext
    const [secretLo, secretHi] = splitSecretToU128(noteSecret);
    const nonceSecLo = randomBytes(16);
    const ctSecLo = cipher.encrypt([secretLo], nonceSecLo);
    const nonceSecLoB = new anchor.BN(deserializeLE(nonceSecLo).toString());
    const nonceSecHi = randomBytes(16);
    const ctSecHi = cipher.encrypt([secretHi], nonceSecHi);
    const nonceSecHiB = new anchor.BN(deserializeLE(nonceSecHi).toString());

    const offset = new anchor.BN(randomBytes(8), "hex");

    console.log(
      `\n📤 Deposit ${i + 1}/${denominationNotes.length}${logSensitiveDataEnabled() ? `: ${redactStepLabel(formatSol(subAmount))} pool` : ""}`,
    );

    const sig = await program.methods
      .deposit(
        offset,
        Array.from(ct[0]),
        Array.from(pub),
        nonceBN,
        Array.from(ctSecLo[0]),
        Array.from(ctSecHi[0]),
        nonceSecLoB,
        nonceSecHiB,
        Array.from(recipientHash),
        new anchor.BN(subAmount.toString()),
        Array.from(noteHash),
      )
      .accountsPartial({
        sender: senderKp.publicKey,
        poolState: poolPDA,
        noteRegistry: notePDA,
        vault: vaultPDA,
        ...buildArciumQueueAccounts(
          programId,
          clusterOffset,
          offset,
          "deposit_to_pool",
        ),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    console.log(`   ✅ Tx: ${sig}`);
    console.log("   ⏳ Waiting for MPC...");
    await awaitComputationFinalization(
      provider,
      offset,
      programId,
      "confirmed",
    );
    console.log("   ✅ MPC confirmed");
    depositReceipts.push({
      noteHashHex: noteHash.toString("hex"),
      notePda: notePDA.toBase58(),
      denominationLamports: subAmount.toString(),
      depositSig: sig,
    });

    subNotes.push({
      noteSecret,
      withdrawKey,
      noteHash,
      recipientHash,
      denominationLamports: subAmount,
      amountLamports: subAmount,
      notePDA,
    });

    // Add delay between note deposits for temporal decorrelation
    if (i < denominationNotes.length - 1 && DEPOSIT_SPREAD_DELAY_MS > 0) {
      console.log(
        `   ⏱️  Waiting ${DEPOSIT_SPREAD_DELAY_MS}ms before next deposit...`,
      );
      await new Promise((r) => setTimeout(r, DEPOSIT_SPREAD_DELAY_MS));
    }
  }

  // ── Optionally export note file (dev/debug only) ─────────────────────────
  if (runtimeSafety.writePlaintextNoteFile) {
    const noteFile = process.env.LOWKIE_NOTE_FILE ?? "/tmp/lowkie-note.json";
    fs.writeFileSync(
      noteFile,
      JSON.stringify({
        subNotes: subNotes.map((sn) => ({
          noteSecret: Array.from(sn.noteSecret),
          withdrawKey: Array.from(sn.withdrawKey),
          noteHash: Array.from(sn.noteHash),
          denominationLamports: sn.denominationLamports.toString(),
          amountLamports: sn.amountLamports.toString(),
        })),
        recipient: recipient.toBase58(),
        totalLamports: totalLamports.toString(),
        sender: senderKp.publicKey.toBase58(),
        delayMs,
        clusterOffset,
      }),
    );
    console.warn(
      `⚠️  Wrote plaintext note material to ${noteFile}. This should only be used in controlled environments.`,
    );
  }

  // ── Trigger relayer withdrawal for all sub-notes ────────────────────────
  const { lowkieWithdraw } = await import("./relayer.js");
  const relayerProvider = createAnchorProvider(conn, relayerKp);
  const relayerProgram = loadLowkieProgram(
    relayerProvider,
    programId,
  ) as Program<any>;

  const withdrawResult = await lowkieWithdraw({
    subNotes: subNotes.map((sn) => ({
      noteSecret: sn.noteSecret,
      withdrawKey: sn.withdrawKey,
      hash: sn.noteHash,
      denominationLamports: sn.denominationLamports,
      amountLamports: sn.amountLamports,
    })),
    recipient,
    totalLamports,
    delayMs,
    provider: relayerProvider,
    program: relayerProgram,
    clusterOffset,
    relayerKeypairPath: relayerPath,
  });

  return {
    recipient: recipient.toBase58(),
    totalLamports: totalLamports.toString(),
    delayMs,
    clusterOffset,
    depositReceipts,
    ...withdrawResult,
  };
}

// ── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const r = process.env.RECIPIENT;
  if (!r) {
    console.error("RECIPIENT=<pubkey> AMOUNT_SOL=0.1 ts-node client/send.ts");
    process.exit(1);
  }

  const delayMs = Number(
    process.env.RELAYER_DELAY_MS ?? DEFAULT_RELAYER_DELAY_MS,
  );
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    console.error("RELAYER_DELAY_MS must be a positive number");
    process.exit(1);
  }

  lowkieSend(r, parseFloat(process.env.AMOUNT_SOL ?? "0.1"), delayMs).catch(
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
