/**
 * Lowkie — Recovery Module
 *
 * Retries stuck withdrawals and refunds failed deposits using persisted
 * recovery files from `send.ts`.
 *
 * Usage (CLI):
 *   npx ts-node client/recover.ts <recoveryId>
 *   npx ts-node client/recover.ts --list
 *   npx ts-node client/recover.ts --refund <recoveryId>
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as dotenv from "dotenv";
import {
  RecoverableNote,
  loadRecoveryFile,
  listRecoveryFiles,
  deleteRecoveryFile,
} from "./recoveryStore";
import { lowkieWithdraw } from "./relayer";
import {
  deriveNotePda,
  deriveNullifierRecordPda,
  derivePoolPda,
  deriveVaultPda,
} from "./arciumAccounts";
import {
  createAnchorConnection,
  createAnchorProvider,
  loadLowkieProgram,
  loadLowkieProgramRuntimeConfig,
} from "./programContext";
import {
  resolveKeypairFromEnv,
  resolveOptionalKeypairFromEnv,
  resolveOptionalPathFromEnv,
  computeNullifierHash,
} from "./utils";
import { buildRelayRequest } from "./relayProtocol";
import { resolveRemoteRelayerConfig, submitRelayRequest } from "./relayClient";

dotenv.config();

// ── Types ────────────────────────────────────────────────────────────────────

export interface RecoveryResult {
  recoveryId: string;
  action: "withdraw" | "refund";
  succeeded: string[];
  failed: Array<{ noteHash: string; error: string }>;
  cleaned: boolean;
}

// ── Note Status Check ────────────────────────────────────────────────────────

interface NoteOnChainStatus {
  exists: boolean;
  status?: string;
  poolCreditApplied?: boolean;
  senderKey?: string;
  lamportsForTransfer?: string;
}

async function fetchNoteStatus(
  program: Program<any>,
  notePda: PublicKey,
): Promise<NoteOnChainStatus> {
  try {
    const note = await (program.account as any).noteAccount.fetch(notePda);
    const statusObj = note.status as Record<string, unknown>;
    let status = "unknown";
    if (statusObj.ready) status = "ready";
    else if (statusObj.withdrawn) status = "withdrawn";
    else if (statusObj.failed) status = "failed";
    else if (statusObj.pending) status = "pending";

    return {
      exists: true,
      status,
      poolCreditApplied: !!note.poolCreditApplied,
      senderKey: note.sender?.toBase58?.() ?? "",
      lamportsForTransfer: note.lamportsForTransfer?.toString() ?? "0",
    };
  } catch {
    return { exists: false };
  }
}

// ── Recover Withdrawal ───────────────────────────────────────────────────────

export async function recoverWithdrawal(
  recoveryId: string,
): Promise<RecoveryResult> {
  const data = loadRecoveryFile(recoveryId);
  if (!data) {
    throw new Error(`Recovery file not found: ${recoveryId}`);
  }

  const config = loadLowkieProgramRuntimeConfig();
  const conn = createAnchorConnection(data.rpcUrl || config.rpcUrl);
  const programId = new PublicKey(
    data.programId || config.programId.toBase58(),
  );
  const clusterOffset =
    data.clusterOffset ?? config.configuredClusterOffset ?? 0;

  const inspectorWalletPath =
    resolveOptionalPathFromEnv("ANCHOR_WALLET") ??
    resolveOptionalPathFromEnv("SENDER_WALLET");
  const inspectorWallet =
    resolveOptionalKeypairFromEnv("ANCHOR_WALLET")?.keypair ??
    resolveOptionalKeypairFromEnv("SENDER_WALLET")?.keypair ??
    (inspectorWalletPath
      ? resolveKeypairFromEnv("ANCHOR_WALLET").keypair
      : Keypair.generate());
  const inspectorProvider = createAnchorProvider(conn, inspectorWallet);
  const program = loadLowkieProgram(
    inspectorProvider,
    programId,
  ) as Program<any>;
  const remoteRelayerConfig = resolveRemoteRelayerConfig();
  const relayerResolution = remoteRelayerConfig
    ? undefined
    : resolveOptionalKeypairFromEnv("RELAYER_KEYPAIR_PATH");
  const relayerKp = relayerResolution?.keypair;
  const relayerProvider = relayerKp
    ? createAnchorProvider(conn, relayerKp)
    : undefined;
  const relayerProgram = relayerProvider
    ? (loadLowkieProgram(relayerProvider, programId) as Program<any>)
    : undefined;

  const recipient = new PublicKey(data.recipient);
  const succeeded: string[] = [];
  const failed: Array<{ noteHash: string; error: string }> = [];

  // Filter to only notes that are still in Ready state (not yet withdrawn)
  const pendingNotes: RecoverableNote[] = [];
  for (const note of data.notes) {
    const notePda = new PublicKey(note.notePda);
    const status = await fetchNoteStatus(program, notePda);

    const hashHex = Buffer.from(note.noteHash).toString("hex");
    if (!status.exists) {
      console.log(`   ✅ Note ${hashHex.slice(0, 12)}... already cleaned up`);
      succeeded.push(hashHex);
      continue;
    }
    if (status.status === "withdrawn") {
      console.log(`   ✅ Note ${hashHex.slice(0, 12)}... already withdrawn`);
      succeeded.push(hashHex);
      continue;
    }
    if (status.status === "ready") {
      pendingNotes.push(note);
      continue;
    }
    if (status.status === "failed") {
      failed.push({
        noteHash: hashHex,
        error: `Note is in Failed state. Use --refund to reclaim.`,
      });
      continue;
    }
    failed.push({
      noteHash: hashHex,
      error: `Unexpected status: ${status.status}`,
    });
  }

  if (pendingNotes.length === 0) {
    console.log(`\n✅ All notes resolved. Cleaning recovery file.`);
    deleteRecoveryFile(recoveryId);
    return { recoveryId, action: "withdraw", succeeded, failed, cleaned: true };
  }

  console.log(`\n🔁 Retrying withdrawal for ${pendingNotes.length} note(s)...`);

  for (const note of pendingNotes) {
    const noteHashHex = Buffer.from(note.noteHash).toString("hex");
    try {
      const subNote = {
        noteSecret: new Uint8Array(note.noteSecret),
        withdrawKey: new Uint8Array(note.withdrawKey),
        hash: Buffer.from(note.noteHash),
        denominationLamports: BigInt(note.denominationLamports),
        amountLamports: BigInt(note.amountLamports),
      };
      if (remoteRelayerConfig) {
        await submitRelayRequest(
          buildRelayRequest({
            sender: data.sender,
            recipient: recipient.toBase58(),
            totalLamports: BigInt(note.amountLamports),
            delayMs: data.delayMs,
            clusterOffset,
            programId: programId.toBase58(),
            rpcUrl: data.rpcUrl || config.rpcUrl,
            subNotes: [subNote],
          }),
          remoteRelayerConfig,
        );
      } else {
        if (
          !relayerProvider ||
          !relayerProgram ||
          !relayerKp ||
          !relayerResolution
        ) {
          throw new Error(
            "RELAYER_KEYPAIR_PATH is required for local recovery withdrawal.",
          );
        }
        await lowkieWithdraw({
          subNotes: [subNote],
          recipient,
          totalLamports: BigInt(note.amountLamports),
          delayMs: data.delayMs,
          provider: relayerProvider,
          program: relayerProgram,
          clusterOffset,
          relayerKeypairPath: relayerResolution.source,
          relayerKeypair: relayerKp,
        });
      }
      succeeded.push(noteHashHex);
    } catch (e) {
      failed.push({
        noteHash: noteHashHex,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (failed.length === 0) {
    deleteRecoveryFile(recoveryId);
    console.log(`\n✅ Recovery complete. File removed.`);
  }

  return {
    recoveryId,
    action: "withdraw",
    succeeded,
    failed,
    cleaned: failed.length === 0,
  };
}

// ── Refund Failed Deposits ───────────────────────────────────────────────────

export async function recoverRefund(
  recoveryId: string,
): Promise<RecoveryResult> {
  const data = loadRecoveryFile(recoveryId);
  if (!data) {
    throw new Error(`Recovery file not found: ${recoveryId}`);
  }

  const config = loadLowkieProgramRuntimeConfig();
  const conn = createAnchorConnection(data.rpcUrl || config.rpcUrl);
  const programId = new PublicKey(
    data.programId || config.programId.toBase58(),
  );
  const senderKp = resolveKeypairFromEnv("SENDER_WALLET").keypair;
  const provider = createAnchorProvider(conn, senderKp);
  const program = loadLowkieProgram(provider, programId) as Program<any>;

  const succeeded: string[] = [];
  const failed: Array<{ noteHash: string; error: string }> = [];

  for (const note of data.notes) {
    const hashHex = Buffer.from(note.noteHash).toString("hex");
    const notePda = new PublicKey(note.notePda);
    const status = await fetchNoteStatus(program, notePda);

    if (!status.exists) {
      console.log(`   ✅ Note ${hashHex.slice(0, 12)}... already cleaned up`);
      succeeded.push(hashHex);
      continue;
    }

    if (status.status === "withdrawn") {
      console.log(`   ✅ Note ${hashHex.slice(0, 12)}... already withdrawn`);
      succeeded.push(hashHex);
      continue;
    }

    if (status.status !== "failed") {
      failed.push({
        noteHash: hashHex,
        error: `Note status is '${status.status}', not 'failed'. Only failed deposits can be refunded on-chain. Use recovery (no --refund) to retry the withdrawal instead.`,
      });
      continue;
    }

    if (status.poolCreditApplied) {
      failed.push({
        noteHash: hashHex,
        error: `Deposit failed AFTER pool credit was applied. Requires operator intervention — cannot auto-refund.`,
      });
      continue;
    }

    // On-chain refund: close note + nullifier accounts, return SOL to sender
    const noteHash = Buffer.from(note.noteHash);
    const nullifierHash = computeNullifierHash(new Uint8Array(note.noteSecret));
    const nullifierRecordPda = deriveNullifierRecordPda(
      programId,
      nullifierHash,
    );
    const denominationLamports = BigInt(note.denominationLamports);
    const poolPda = derivePoolPda(programId, denominationLamports);
    const vaultPda = deriveVaultPda(programId, denominationLamports);

    try {
      const sig = await program.methods
        .refundFailedDeposit(Array.from(noteHash))
        .accountsPartial({
          sender: senderKp.publicKey,
          noteRegistry: notePda,
          nullifierRecord: nullifierRecordPda,
          poolState: poolPda,
          vault: vaultPda,
        })
        .signers([senderKp])
        .rpc({ commitment: "confirmed" });

      console.log(`   ✅ Refunded note ${hashHex.slice(0, 12)}...: ${sig}`);
      succeeded.push(hashHex);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `   ❌ Refund failed for ${hashHex.slice(0, 12)}...: ${msg}`,
      );
      failed.push({ noteHash: hashHex, error: msg });
    }
  }

  if (failed.length === 0) {
    deleteRecoveryFile(recoveryId);
    console.log(`\n✅ All refunds complete. Recovery file removed.`);
  }

  return {
    recoveryId,
    action: "refund",
    succeeded,
    failed,
    cleaned: failed.length === 0,
  };
}

// ── List recovery files ──────────────────────────────────────────────────────

export function listRecoverableTransfers(): Array<{
  id: string;
  createdAt: string;
  recipient: string;
  totalLamports: string;
  noteCount: number;
}> {
  const ids = listRecoveryFiles();
  return ids.map((id) => {
    const data = loadRecoveryFile(id);
    return {
      id,
      createdAt: data?.createdAt ?? "unknown",
      recipient: data?.recipient ?? "unknown",
      totalLamports: data?.totalLamports ?? "0",
      noteCount: data?.notes?.length ?? 0,
    };
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes("--list") || args.length === 0) {
    const transfers = listRecoverableTransfers();
    if (transfers.length === 0) {
      console.log("No recovery files found.");
    } else {
      console.log(`\n📦 ${transfers.length} recoverable transfer(s):\n`);
      for (const t of transfers) {
        console.log(
          `  ${t.id}  ${t.createdAt}  ${Number(t.totalLamports) / LAMPORTS_PER_SOL} SOL  ${t.noteCount} note(s)  → ${t.recipient.slice(0, 8)}...`,
        );
      }
      console.log(
        `\nRun: npx ts-node client/recover.ts <id>          to retry withdrawal`,
      );
      console.log(
        `     npx ts-node client/recover.ts --refund <id>  to refund failed deposits`,
      );
    }
    process.exit(0);
  }

  const isRefund = args.includes("--refund");
  const recoveryId = args.find((a) => !a.startsWith("--"));

  if (!recoveryId) {
    console.error(
      "Usage: npx ts-node client/recover.ts [--refund] <recoveryId>",
    );
    process.exit(1);
  }

  const action = isRefund ? recoverRefund : recoverWithdrawal;
  action(recoveryId)
    .then((result) => {
      console.log(
        `\nResult: ${result.succeeded.length} succeeded, ${result.failed.length} failed`,
      );
      if (result.failed.length > 0) {
        process.exit(1);
      }
    })
    .catch((e) => {
      console.error("Recovery failed:", e.message ?? e);
      process.exit(1);
    });
}
