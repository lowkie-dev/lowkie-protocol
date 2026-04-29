/**
 * Lowkie — Sender CLI & Core Send APIs
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getArciumEnv } from "@arcium-hq/client";
import * as dotenv from "dotenv";
import {
  DEFAULT_RELAYER_DELAY_MS,
  SUPPORTED_DENOMINATION_LAMPORTS,
} from "./constants";
import {
  createAnchorConnection,
  createAnchorProvider,
  loadLowkieProgram,
  loadLowkieProgramRuntimeConfig,
} from "./programContext";
import { assertLowkieReadiness } from "./readiness";
import {
  assertDistinctKeypairs,
  resolveKeypairFromEnv,
  resolveOptionalKeypairFromEnv,
  resolveOptionalPathFromEnv,
  decomposeIntoDenominations,
} from "./utils";
import {
  redactAmountSol,
  redactDenominationSummary,
  redactValue,
} from "./privacyLogging";
import { resolveRemoteRelayerConfig, submitRelayRequest } from "./relayClient";
import { executeRelayRequest } from "./relayer";
import { buildRelayRequest } from "./relayProtocol";
import {
  buildDepositTransactions,
  executeSignedDeposits,
  DepositReceipt,
} from "./deposit";
import {
  deleteRecoveryFile,
  recoveryFilePath,
  loadRecoveryFile,
  listRecoveryFiles,
  RecoveryFile,
  RecoverableNote,
} from "./recoveryStore";

export {
  deleteRecoveryFile,
  loadRecoveryFile,
  listRecoveryFiles,
  recoveryFilePath,
};
export type { RecoverableNote, RecoveryFile };

dotenv.config();

const MIN_RELAYER_BALANCE_LAMPORTS = Math.floor(0.05 * LAMPORTS_PER_SOL);
const LOCALNET_RELAYER_AIRDROP_LAMPORTS = Math.floor(0.5 * LAMPORTS_PER_SOL);
const BUILD_RPC_RETRY_MAX_ATTEMPTS = parseInt(
  process.env.BUILD_RPC_RETRY_MAX_ATTEMPTS ?? "3",
);
const BUILD_RPC_RETRY_BASE_MS = parseInt(
  process.env.BUILD_RPC_RETRY_BASE_MS ?? "500",
);

export interface SendResult {
  recipient: string;
  totalLamports: string;
  delayMs: number;
  clusterOffset: number;
  partialFailure?: string;
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

export class WithdrawalFailedError extends Error {
  constructor(
    message: string,
    public readonly recoveryId: string,
    public readonly depositReceipts: DepositReceipt[],
  ) {
    super(message);
    this.name = "WithdrawalFailedError";
  }
}

export function isTransientBuildRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "429",
    "too many requests",
    "fetch failed",
    "connect timeout",
    "timed out",
    "service unavailable",
    "gateway timeout",
    "econnreset",
    "enotfound",
    "etimedout",
    "socket hang up",
  ].some((fragment) => message.toLowerCase().includes(fragment));
}

async function withBuildRpcRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= BUILD_RPC_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (
        !isTransientBuildRpcError(error) ||
        attempt === BUILD_RPC_RETRY_MAX_ATTEMPTS
      ) {
        throw error;
      }

      const backoffMs = BUILD_RPC_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `   ⚠️ Build deposits RPC attempt ${attempt}/${BUILD_RPC_RETRY_MAX_ATTEMPTS} failed: ${message}`,
      );
      console.warn(`   ↻ Retrying build deposits in ${backoffMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

function resolveRecoverySenderKeypair(
  expectedSender: string,
): anchor.web3.Keypair | undefined {
  try {
    const senderKp = resolveKeypairFromEnv("SENDER_WALLET").keypair;
    if (senderKp.publicKey.toBase58() === expectedSender) {
      return senderKp;
    }
  } catch {
    // Fall back to pre-signed transactions only when the configured sender
    // cannot be resolved locally.
  }

  return undefined;
}

export async function lowkieBuildDeposits(
  senderStr: string,
  recipientStr: string,
  amountSol: number,
  delayMs = DEFAULT_RELAYER_DELAY_MS,
) {
  return await withBuildRpcRetry(async () => {
    const {
      rpcUrl,
      network,
      programId,
      configuredClusterOffset,
      runtimeSafety,
    } = loadLowkieProgramRuntimeConfig();
    const conn = createAnchorConnection(rpcUrl);
    const provider = createAnchorProvider(conn, anchor.web3.Keypair.generate());
    anchor.setProvider(provider);
    const program = loadLowkieProgram(provider, programId) as Program<any>;

    const arciumEnv = getArciumEnv();
    const clusterOffset =
      configuredClusterOffset ?? arciumEnv.arciumClusterOffset;

    await assertLowkieReadiness(provider, program, clusterOffset);

    const senderPubkey = new PublicKey(senderStr);
    const recipient = new PublicKey(recipientStr);
    const totalLamports = BigInt(Math.round(amountSol * LAMPORTS_PER_SOL));
    const denominationNotes = decomposeIntoDenominations(totalLamports);

    console.log(`\n━━━ Splitting ${formatSol(totalLamports)} ━━━`);
    console.log(`  Recipient: ${redactValue(recipient.toBase58())}`);
    console.log(
      `  Notes:     ${redactDenominationSummary(summarizeDenominationNotes(denominationNotes), denominationNotes.length)}`,
    );

    const { recoveryId, transactionsBase64 } = await buildDepositTransactions({
      provider,
      program,
      senderPubkey,
      recipient,
      totalLamports,
      denominationNotes,
      delayMs,
      clusterOffset,
      programId,
      rpcUrl,
      runtimeSafety,
    });

    return { recoveryId, transactionsBase64 };
  });
}

export async function lowkieSubmitDeposits(
  recoveryId: string,
  signedTransactionsBase64: string[],
) {
  const { rpcUrl, programId, runtimeSafety } = loadLowkieProgramRuntimeConfig();
  const conn = createAnchorConnection(rpcUrl);
  // We use a dummy keypair for the provider since the transactions are already signed.
  const dummyKp = anchor.web3.Keypair.generate();
  const provider = createAnchorProvider(conn, dummyKp);
  anchor.setProvider(provider);
  const program = loadLowkieProgram(provider, programId) as Program<any>;

  const recoveryData = loadRecoveryFile(recoveryId);
  if (!recoveryData) {
    throw new Error(`Recovery file ${recoveryId} not found`);
  }

  const senderKp = resolveRecoverySenderKeypair(recoveryData.sender) ?? dummyKp;

  const { depositReceipts, depositFailure, subNotes } =
    await executeSignedDeposits({
      provider,
      program,
      senderKp,
      recoveryId,
      signedTransactionsBase64,
      runtimeSafety,
    });

  if (depositFailure) {
    throw new WithdrawalFailedError(
      depositFailure.message,
      recoveryId,
      depositReceipts,
    );
  }

  const remoteRelayerConfig = resolveRemoteRelayerConfig();
  const relayRequest = buildRelayRequest({
    sender: recoveryData.sender,
    recipient: recoveryData.recipient,
    totalLamports: BigInt(recoveryData.totalLamports),
    delayMs: recoveryData.delayMs,
    clusterOffset: recoveryData.clusterOffset,
    programId: recoveryData.programId,
    rpcUrl: recoveryData.rpcUrl,
    subNotes: subNotes.map((subNote) => ({
      noteSecret: subNote.noteSecret,
      withdrawKey: subNote.withdrawKey,
      hash: subNote.noteHash,
      denominationLamports: subNote.denominationLamports,
      amountLamports: subNote.amountLamports,
    })),
  });

  const relayResponse = remoteRelayerConfig
    ? await submitRelayRequest(relayRequest, remoteRelayerConfig)
    : await executeRelayRequest(relayRequest);

  return {
    recipient: relayRequest.recipient,
    totalLamports: relayRequest.totalLamports,
    delayMs: relayRequest.delayMs,
    clusterOffset: relayRequest.clusterOffset,
    depositReceipts,
    ...relayResponse,
  };
}

export async function lowkieSend(
  recipientStr: string,
  amountSol: number,
  delayMs = DEFAULT_RELAYER_DELAY_MS,
): Promise<SendResult> {
  const senderKp = resolveKeypairFromEnv("SENDER_WALLET").keypair;

  const relayerResolution = resolveOptionalKeypairFromEnv(
    "RELAYER_KEYPAIR_PATH",
  );
  if (!resolveRemoteRelayerConfig() && !relayerResolution) {
    throw new Error(
      "RELAYER_KEYPAIR_PATH is required when LOWKIE_RELAYER_URL is not configured.",
    );
  }

  if (relayerResolution) {
    const relayerKp = relayerResolution.keypair;
    assertDistinctKeypairs(senderKp, relayerKp);
  }

  // 1. Build deposits
  const { recoveryId, transactionsBase64 } = await lowkieBuildDeposits(
    senderKp.publicKey.toBase58(),
    recipientStr,
    amountSol,
    delayMs,
  );

  // 2. Sign transactions (Mocking frontend signing here on backend)
  const signedTxs = transactionsBase64.map((txB64) => {
    const tx = anchor.web3.VersionedTransaction.deserialize(
      Buffer.from(txB64, "base64"),
    );
    tx.sign([senderKp]);
    return Buffer.from(tx.serialize()).toString("base64");
  });

  // 3. Submit
  return await lowkieSubmitDeposits(recoveryId, signedTxs);
}
