import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  awaitComputationFinalization,
  deserializeLE,
  RescueCipher,
  x25519,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import {
  buildArciumQueueAccounts,
  deriveNotePda,
  deriveNullifierRecordPda,
  derivePoolPda,
  deriveVaultPda,
} from "./arciumAccounts";
import { RuntimeSafetyConfig } from "./runtimeSafety";
import {
  confirmedRpcOptions,
  computeNullifierHash,
  computeNoteHash,
  computeRecipientHash,
  fetchMXEKey,
  splitSecretToU128,
  formatSol,
} from "./utils";
import { logSensitiveDataEnabled, redactStepLabel } from "./privacyLogging";
import {
  RecoveryFile,
  recoveryFilePath,
  writeRecoveryFile,
  loadRecoveryFile,
  deleteRecoveryFile,
} from "./recoveryStore";

const DEPOSIT_SPREAD_DELAY_MS = parseInt(
  process.env.DEPOSIT_SPREAD_DELAY_MS ?? process.env.SPLIT_DELAY_MS ?? "0",
);
const DEPOSIT_MAX_RETRIES = parseInt(process.env.DEPOSIT_MAX_RETRIES ?? "3");
const DEPOSIT_RETRY_BASE_MS = parseInt(
  process.env.DEPOSIT_RETRY_BASE_MS ?? "5000",
);

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEPOSIT_MAX_INSTRUCTIONS_PER_TX = parsePositiveIntegerEnv(
  "DEPOSIT_MAX_INSTRUCTIONS_PER_TX",
  2,
);
const DEPOSIT_TARGET_TX_BYTES = parsePositiveIntegerEnv(
  "DEPOSIT_TARGET_TX_BYTES",
  1100,
);

export interface DepositedSubNote {
  noteSecret: Uint8Array;
  withdrawKey: Uint8Array;
  noteHash: Buffer;
  nullifierHash: Buffer;
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

export interface BuildDepositTransactionsParams {
  provider: anchor.AnchorProvider;
  program: Program<any>;
  senderPubkey: PublicKey;
  recipient: PublicKey;
  totalLamports: bigint;
  denominationNotes: readonly bigint[];
  delayMs: number;
  clusterOffset: number;
  programId: PublicKey;
  rpcUrl: string;
  runtimeSafety: RuntimeSafetyConfig;
}

export interface BuildDepositTransactionsResult {
  recoveryId: string;
  subNotes: DepositedSubNote[];
  transactionsBase64: string[];
  noteCount: number;
}

export interface ExecuteSignedDepositsParams {
  provider: anchor.AnchorProvider;
  program: Program<any>;
  senderKp: anchor.web3.Keypair; // needed for refunds if any fail
  recoveryId: string;
  signedTransactionsBase64: string[];
  runtimeSafety: RuntimeSafetyConfig;
}

export interface DepositPhaseResult {
  recoveryId: string;
  subNotes: DepositedSubNote[];
  depositReceipts: DepositReceipt[];
  depositFailure: Error | null;
}

function extractSignedTransactionSignature(txBuffer: Buffer): string | null {
  try {
    try {
      const tx = anchor.web3.VersionedTransaction.deserialize(txBuffer);
      const [signature] = tx.signatures;
      if (!signature || signature.every((byte) => byte === 0)) {
        return null;
      }
      return bs58.encode(signature);
    } catch {
      const tx = anchor.web3.Transaction.from(txBuffer);
      if (!tx.signature || tx.signature.every((byte) => byte === 0)) {
        return null;
      }
      return bs58.encode(tx.signature);
    }
  } catch {
    return null;
  }
}

async function refundFailedDeposit(
  program: Program<any>,
  sender: anchor.web3.Keypair,
  notePDA: PublicKey,
  nullifierRecordPDA: PublicKey,
  poolPDA: PublicKey,
  vaultPDA: PublicKey,
  noteHash: Buffer,
): Promise<string> {
  return program.methods
    .refundFailedDeposit(Array.from(noteHash))
    .accountsPartial({
      sender: sender.publicKey,
      noteRegistry: notePDA,
      nullifierRecord: nullifierRecordPDA,
      poolState: poolPDA,
      vault: vaultPDA,
    })
    .signers([sender])
    .rpc({ commitment: "confirmed" });
}

export async function buildDepositTransactions(
  params: BuildDepositTransactionsParams,
): Promise<BuildDepositTransactionsResult> {
  const {
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
  } = params;

  const mxeKey = await fetchMXEKey(provider, programId);
  const subNotes: DepositedSubNote[] = [];
  const transactionsBase64: string[] = [];
  const transactionNoteGroups: number[][] = [];
  const poolCache = new Map<
    string,
    { poolPDA: PublicKey; vaultPDA: PublicKey }
  >();

  const recoveryId = `lowkie-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const recoveryData: RecoveryFile = {
    id: recoveryId,
    createdAt: new Date().toISOString(),
    recipient: recipient.toBase58(),
    sender: senderPubkey.toBase58(),
    totalLamports: totalLamports.toString(),
    delayMs,
    clusterOffset,
    programId: programId.toBase58(),
    rpcUrl,
    notes: [],
  };

  async function resolvePoolAccounts(denominationLamports: bigint) {
    const key = denominationLamports.toString();
    const cached = poolCache.get(key);
    if (cached) return cached;

    const poolPDA = derivePoolPda(programId, denominationLamports);
    const vaultPDA = deriveVaultPda(programId, denominationLamports);
    const pool = await (program.account as any).poolState.fetch(poolPDA);
    if (!pool.isInitialized) {
      throw new Error(
        `Pool ${formatSol(denominationLamports)} is not initialised`,
      );
    }

    const resolved = { poolPDA, vaultPDA };
    poolCache.set(key, resolved);
    return resolved;
  }

  const latestBlockhash = await provider.connection.getLatestBlockhash(
    "confirmed",
  );
  const compileDepositTransaction = (
    instructions: anchor.web3.TransactionInstruction[],
  ) => {
    const tx = new anchor.web3.Transaction({
      feePayer: senderPubkey,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });
    tx.add(...instructions);
    return tx;
  };
  const getSerializedDepositTransactionSize = (
    instructions: anchor.web3.TransactionInstruction[],
  ): number | null => {
    try {
      return compileDepositTransaction(instructions).serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      }).length;
    } catch (error) {
      if (
        error instanceof RangeError ||
        (error instanceof Error &&
          error.message.toLowerCase().includes("transaction too large"))
      ) {
        return null;
      }
      throw error;
    }
  };
  let pendingInstructions: anchor.web3.TransactionInstruction[] = [];
  let pendingNoteIndexes: number[] = [];

  const flushPendingTransaction = () => {
    if (pendingInstructions.length === 0) {
      return;
    }

    const tx = compileDepositTransaction(pendingInstructions);
    transactionsBase64.push(
      Buffer.from(
        tx.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }),
      ).toString("base64"),
    );
    transactionNoteGroups.push([...pendingNoteIndexes]);
    pendingInstructions = [];
    pendingNoteIndexes = [];
  };

  for (let index = 0; index < denominationNotes.length; index++) {
    const subAmount = denominationNotes[index];
    const { poolPDA, vaultPDA } = await resolvePoolAccounts(subAmount);
    const noteSecret = new Uint8Array(randomBytes(32));
    const withdrawKey = new Uint8Array(randomBytes(32));
    const nullifierHash = computeNullifierHash(noteSecret);
    const recipientHash = computeRecipientHash(withdrawKey, recipient);
    const noteHash = computeNoteHash(noteSecret, recipient, subAmount);
    const notePDA = deriveNotePda(programId, noteHash);
    const nullifierRecordPDA = deriveNullifierRecordPda(
      programId,
      nullifierHash,
    );

    const priv = x25519.utils.randomSecretKey();
    const pub = x25519.getPublicKey(priv);
    const cipher = new RescueCipher(x25519.getSharedSecret(priv, mxeKey));
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([subAmount], nonce);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

    const [secretLo, secretHi] = splitSecretToU128(noteSecret);
    const nonceSecLo = randomBytes(16);
    const ctSecLo = cipher.encrypt([secretLo], nonceSecLo);
    const nonceSecLoB = new anchor.BN(deserializeLE(nonceSecLo).toString());
    const nonceSecHi = randomBytes(16);
    const ctSecHi = cipher.encrypt([secretHi], nonceSecHi);
    const nonceSecHiB = new anchor.BN(deserializeLE(nonceSecHi).toString());

    const offset = new anchor.BN(randomBytes(8), "hex");

    const ix = await program.methods
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
        Array.from(nullifierHash),
        new anchor.BN(subAmount.toString()),
        Array.from(noteHash),
      )
      .accountsPartial({
        sender: senderPubkey,
        poolState: poolPDA,
        noteRegistry: notePDA,
        nullifierRecord: nullifierRecordPDA,
        vault: vaultPDA,
        ...buildArciumQueueAccounts(
          programId,
          clusterOffset,
          offset,
          "deposit_to_pool",
        ),
      })
      .instruction();

    subNotes.push({
      noteSecret,
      withdrawKey,
      noteHash,
      nullifierHash,
      recipientHash,
      denominationLamports: subAmount,
      amountLamports: subAmount,
      notePDA,
    });

    recoveryData.notes.push({
      noteSecret: Array.from(noteSecret),
      withdrawKey: Array.from(withdrawKey),
      noteHash: Array.from(noteHash),
      nullifierHash: Array.from(nullifierHash),
      denominationLamports: subAmount.toString(),
      amountLamports: subAmount.toString(),
      notePda: notePDA.toBase58(),
      offsetHex: offset.toString("hex"),
    });

    const noteIndex = recoveryData.notes.length - 1;
    const nextInstructions = [...pendingInstructions, ix];
    const nextTxSize = getSerializedDepositTransactionSize(nextInstructions);
    const shouldFlushPendingFirst =
      pendingInstructions.length > 0 &&
      (nextInstructions.length > DEPOSIT_MAX_INSTRUCTIONS_PER_TX ||
        nextTxSize === null ||
        nextTxSize > DEPOSIT_TARGET_TX_BYTES);

    if (shouldFlushPendingFirst) {
      flushPendingTransaction();
    }

    if (pendingInstructions.length === 0) {
      const singleInstructionTxSize = getSerializedDepositTransactionSize([ix]);
      if (singleInstructionTxSize === null) {
        throw new Error(
          `Single deposit transaction for ${formatSol(subAmount)} exceeds the maximum transaction size.`,
        );
      }
    }

    pendingInstructions.push(ix);
    pendingNoteIndexes.push(noteIndex);
  }

  flushPendingTransaction();
  recoveryData.transactionNoteGroups = transactionNoteGroups;

  writeRecoveryFile(recoveryData);
  console.log(`\n💾 Recovery file created: ${recoveryFilePath(recoveryId)}`);

  if (runtimeSafety.writePlaintextNoteFile) {
    const noteFile =
      process.env.LOWKIE_NOTE_FILE ?? "./recovery/lowkie-note.json";
    fs.writeFileSync(
      noteFile,
      JSON.stringify({
        subNotes: subNotes.map((subNote) => ({
          noteSecret: Array.from(subNote.noteSecret),
          withdrawKey: Array.from(subNote.withdrawKey),
          noteHash: Array.from(subNote.noteHash),
          nullifierHash: Array.from(subNote.nullifierHash),
          denominationLamports: subNote.denominationLamports.toString(),
          amountLamports: subNote.amountLamports.toString(),
        })),
        recipient: recipient.toBase58(),
        totalLamports: totalLamports.toString(),
        sender: senderPubkey.toBase58(),
        delayMs,
        clusterOffset,
      }),
    );
    console.warn(
      `⚠️  Wrote plaintext note material to ${noteFile}. This should only be used in controlled environments.`,
    );
  }

  return {
    recoveryId,
    subNotes,
    transactionsBase64,
    noteCount: subNotes.length,
  };
}

export async function executeSignedDeposits(
  params: ExecuteSignedDepositsParams,
): Promise<DepositPhaseResult> {
  const {
    provider,
    program,
    senderKp,
    recoveryId,
    signedTransactionsBase64,
    runtimeSafety,
  } = params;

  const recoveryData = loadRecoveryFile(recoveryId);
  if (!recoveryData) {
    throw new Error(`Recovery file ${recoveryId} not found`);
  }

  const depositReceipts: DepositReceipt[] = [];
  let depositFailure: Error | null = null;
  const programId = new PublicKey(recoveryData.programId);
  const transactionNoteGroups =
    recoveryData.transactionNoteGroups &&
    recoveryData.transactionNoteGroups.length > 0
      ? recoveryData.transactionNoteGroups
      : recoveryData.notes.map((_, index) => [index]);

  if (transactionNoteGroups.length !== signedTransactionsBase64.length) {
    throw new Error(
      `Expected ${transactionNoteGroups.length} signed transactions but received ${signedTransactionsBase64.length}.`,
    );
  }

  const subNotes: DepositedSubNote[] = recoveryData.notes.map((note) => ({
    noteSecret: new Uint8Array(note.noteSecret),
    withdrawKey: new Uint8Array(note.withdrawKey),
    noteHash: Buffer.from(note.noteHash),
    nullifierHash: Buffer.from(note.nullifierHash),
    recipientHash: computeRecipientHash(
      new Uint8Array(note.withdrawKey),
      new PublicKey(recoveryData.recipient),
    ),
    denominationLamports: BigInt(note.denominationLamports),
    amountLamports: BigInt(note.amountLamports),
    notePDA: new PublicKey(note.notePda),
  }));

  const submittedTransactionIndexes: number[] = [];

  for (let index = 0; index < signedTransactionsBase64.length; index++) {
    const txBase64 = signedTransactionsBase64[index];
    let txBuffer = Buffer.from(txBase64, "base64");
    const noteIndexes = transactionNoteGroups[index];

    if (!noteIndexes || noteIndexes.length === 0) {
      throw new Error(`Transaction group ${index} does not contain any notes.`);
    }

    const primaryNote = recoveryData.notes[noteIndexes[0]];
    const notePDA = new PublicKey(primaryNote.notePda);

    console.log(
      `\n📤 Deposit ${index + 1}/${signedTransactionsBase64.length} (${noteIndexes.length} note(s))${logSensitiveDataEnabled() ? `: ${redactStepLabel(formatSol(BigInt(primaryNote.denominationLamports)))} pool` : ""}`,
    );

    let depositSig = primaryNote.depositSig;

    for (let attempt = 0; attempt <= DEPOSIT_MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const backoffMs = DEPOSIT_RETRY_BASE_MS * Math.pow(2, attempt - 1);
          console.log(
            `   🔄 Retry ${attempt}/${DEPOSIT_MAX_RETRIES} after ${backoffMs}ms backoff...`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }

        if (!depositSig) {
          depositSig = await provider.connection.sendRawTransaction(
            txBuffer,
            confirmedRpcOptions(runtimeSafety.skipPreflight),
          );

          for (const noteIndex of noteIndexes) {
            recoveryData.notes[noteIndex].depositSig = depositSig;
          }
          writeRecoveryFile(recoveryData);
          console.log(`   ✅ Tx: ${depositSig}`);
        }
        break;
      } catch (retryError) {
        const isLastAttempt = attempt === DEPOSIT_MAX_RETRIES;
        const errorMessage =
          retryError instanceof Error ? retryError.message : String(retryError);

        if (/blockhash not found/i.test(errorMessage)) {
          if (senderKp.publicKey.toBase58() === recoveryData.sender) {
            // Sender keypair available: refresh blockhash and re-sign
            const latestBlockhash =
              await provider.connection.getLatestBlockhash("confirmed");
            try {
              const refreshedTx =
                anchor.web3.VersionedTransaction.deserialize(txBuffer);
              refreshedTx.message.recentBlockhash = latestBlockhash.blockhash;
              refreshedTx.sign([senderKp]);
              txBuffer = Buffer.from(refreshedTx.serialize());
            } catch {
              const refreshedTx = anchor.web3.Transaction.from(txBuffer);
              refreshedTx.recentBlockhash = latestBlockhash.blockhash;
              refreshedTx.lastValidBlockHeight =
                latestBlockhash.lastValidBlockHeight;
              refreshedTx.sign(senderKp);
              txBuffer = Buffer.from(refreshedTx.serialize());
            }
            signedTransactionsBase64[index] = txBuffer.toString("base64");
            for (const noteIndex of noteIndexes) {
              recoveryData.notes[noteIndex].depositSig = undefined;
              delete recoveryData.notes[noteIndex].depositSig;
            }
            writeRecoveryFile(recoveryData);
            console.warn(
              "   ⚠️ Transaction blockhash expired; refreshed and re-signed with a new blockhash.",
            );
          } else {
            // Sender keypair not available (e.g., Render backend): cannot recover from expired blockhash
            // This typically means the transaction was built too far in advance.
            // Recommend to reduce DEPOSIT_SPREAD_DELAY_MS or rebuild transactions more frequently.
            console.error(
              "   ❌ Blockhash expired and sender keypair not available for re-signing.",
            );
            console.error(
              "   💡 Set DEPOSIT_SPREAD_DELAY_MS=0 or rebuild deposits individually to avoid this issue.",
            );
            depositFailure = new Error(
              "Blockhash expired and sender keypair is unavailable for re-signing. Rebuild and re-sign the remaining deposits.",
            );
            break;
          }
        }

        if (/already been processed/i.test(errorMessage) && !depositSig) {
          const existingSig = extractSignedTransactionSignature(txBuffer);
          if (existingSig) {
            depositSig = existingSig;
            for (const noteIndex of noteIndexes) {
              recoveryData.notes[noteIndex].depositSig = existingSig;
            }
            writeRecoveryFile(recoveryData);
            console.warn(
              "   ⚠️ Transaction was already processed on-chain; resuming from the signed transaction signature.",
            );
          }
        }

        if (depositSig && /unknown action/i.test(errorMessage)) {
          try {
            await (program.account as any).noteAccount.fetch(notePDA);
            console.warn(
              `   ⚠️ Note account exists on-chain; MPC may still be processing.`,
            );
          } catch {
            console.warn(
              `   ⚠️ Deposit tx did not land (note account missing). Will resubmit.`,
            );
            depositSig = undefined;
            for (const noteIndex of noteIndexes) {
              recoveryData.notes[noteIndex].depositSig = undefined;
              delete recoveryData.notes[noteIndex].depositSig;
            }
            writeRecoveryFile(recoveryData);
          }
        }

        if (isLastAttempt || depositFailure) {
          console.error(
            `   ❌ Deposit ${index + 1} failed after ${DEPOSIT_MAX_RETRIES + 1} attempts: ${errorMessage}`,
          );
          if (!depositFailure) {
            depositFailure =
              retryError instanceof Error
                ? retryError
                : new Error(errorMessage);
          }
          break;
        }

        console.warn(`   ⚠️ Attempt ${attempt + 1} failed: ${errorMessage}`);
      }
    }

    if (depositFailure) {
      break;
    }

    submittedTransactionIndexes.push(index);

    if (
      index < signedTransactionsBase64.length - 1 &&
      DEPOSIT_SPREAD_DELAY_MS > 0
    ) {
      console.log(
        `   ⏱️  Waiting ${DEPOSIT_SPREAD_DELAY_MS}ms before next deposit...`,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, DEPOSIT_SPREAD_DELAY_MS),
      );
    }
  }

  finalizationLoop: for (const txIndex of submittedTransactionIndexes) {
    const noteIndexes = transactionNoteGroups[txIndex]!;

    console.log(
      `   ⏳ Waiting for MPC result for deposit ${txIndex + 1}/${signedTransactionsBase64.length} (${noteIndexes.length} note(s))...`,
    );

    for (const noteIndex of noteIndexes) {
      const note = recoveryData.notes[noteIndex];
      const notePDA = new PublicKey(note.notePda);
      const subAmount = BigInt(note.denominationLamports);
      const depositSig = note.depositSig;

      await awaitComputationFinalization(
        provider,
        new anchor.BN(note.offsetHex, "hex"),
        programId,
        "confirmed",
      );

      const noteAfterDeposit = await (program.account as any).noteAccount.fetch(
        notePDA,
      );

      const noteStatus = noteAfterDeposit.status as Record<string, unknown>;
      if (noteStatus.failed) {
        if (!noteAfterDeposit.poolCreditApplied) {
          console.warn(
            "   ⚠️ Deposit callback failed before encrypted pool credit; refunding sender...",
          );
          const poolPDA = derivePoolPda(programId, subAmount);
          const vaultPDA = deriveVaultPda(programId, subAmount);
          const nullifierRecordPDA = deriveNullifierRecordPda(
            programId,
            Buffer.from(note.nullifierHash),
          );
          const refundSig = await refundFailedDeposit(
            program,
            senderKp,
            notePDA,
            nullifierRecordPDA,
            poolPDA,
            vaultPDA,
            Buffer.from(note.noteHash),
          );
          console.warn(`   ✅ Refunded failed deposit: ${refundSig}`);
        }

        depositFailure = new Error(
          noteAfterDeposit.poolCreditApplied
            ? `Deposit for note ${note.noteHash} failed after pool credit and requires operator attention.`
            : `Deposit for note ${note.noteHash} failed before pool credit and was refunded.`,
        );
        break finalizationLoop;
      }

      if (!noteStatus.ready) {
        depositFailure = new Error(
          `Deposit for note ${note.noteHash} did not reach the Ready state.`,
        );
        break finalizationLoop;
      }

      console.log("   ✅ MPC confirmed");
      depositReceipts.push({
        noteHashHex: Buffer.from(note.noteHash).toString("hex"),
        notePda: notePDA.toBase58(),
        denominationLamports: subAmount.toString(),
        depositSig: depositSig!,
      });
    }
  }

  if (depositReceipts.length === 0 && depositFailure) {
    throw depositFailure;
  }

  // All deposits landed — recovery file is no longer needed
  if (!depositFailure) {
    try {
      deleteRecoveryFile(recoveryId);
    } catch {
      // non-fatal: file may already be gone
    }
  }

  return {
    recoveryId,
    subNotes,
    depositReceipts,
    depositFailure,
  };
}
