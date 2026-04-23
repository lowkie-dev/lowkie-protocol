/**
 * Force-upload circuit artifacts on-chain, bypassing the Arcium SDK's
 * client-side "Offchain" state check.
 *
 * This is needed when comp defs were created with offchain URLs that have
 * since expired (e.g. tmpfiles.org links). The on-chain `uploadCircuit`
 * instruction does not enforce a circuit-source state check, so we can push
 * the raw circuit data on-chain and then finalize the comp def.
 *
 * Usage:
 *   npx ts-node scripts/force-upload-circuits.ts [circuit_name]
 *
 * If circuit_name is omitted, all four circuits are uploaded.
 */

import * as anchor from "@coral-xyz/anchor";
import {
  getArciumProgram,
  getArciumProgramId,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getCircuitState,
  getRawCircuitAccAddress,
} from "@arcium-hq/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ArciumProgram = anchor.Program<any>;
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  loadLowkieProgramContext,
} from "../src/core/programContext";
import { confirmedRpcOptions } from "../src/core/utils";

dotenv.config();

const CIRCUIT_ARTIFACTS: Record<string, string> = {
  init_pool_balance: "build/init_pool_balance.arcis",
  deposit_to_pool: "build/deposit_to_pool.arcis",
  withdraw_from_pool: "build/withdraw_from_pool.arcis",
  compact_registry: "build/compact_registry.arcis",
};

// Arcium SDK constants (from onchain.ts)
const MAX_ACCOUNT_SIZE = 10_485_760; // 10 MiB
const MAX_REALLOC_PER_IX = 10_240;
const MAX_EMBIGGEN_IX_PER_TX = 4;
const MAX_UPLOAD_PER_TX_BYTES = 814;

function compDefOffset(name: string): number {
  return Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
}

function loadCircuitArtifact(name: string): Uint8Array {
  const p = path.resolve(CIRCUIT_ARTIFACTS[name]);
  return new Uint8Array(fs.readFileSync(p));
}

async function signAndSendWithBlockhash(
  provider: anchor.AnchorProvider,
  tx: anchor.web3.Transaction,
  blockInfo: { blockhash: string; lastValidBlockHeight: number },
  opts?: anchor.web3.ConfirmOptions,
): Promise<string> {
  tx.recentBlockhash = blockInfo.blockhash;
  tx.lastValidBlockHeight = blockInfo.lastValidBlockHeight;
  tx.feePayer = provider.publicKey;
  const signed = await provider.wallet.signTransaction(tx);
  const sig = await provider.connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: opts?.skipPreflight ?? false,
  });
  await provider.connection.confirmTransaction(
    { signature: sig, ...blockInfo },
    opts?.commitment ?? "confirmed",
  );
  return sig;
}

async function forceUploadCircuit(
  provider: anchor.AnchorProvider,
  arcium: ArciumProgram,
  circuitName: string,
  mxeProgramId: anchor.web3.PublicKey,
  skipPreflight: boolean,
): Promise<void> {
  const offset = compDefOffset(circuitName);
  const compDefPubkey = getCompDefAccAddress(mxeProgramId, offset);
  const rawCircuit = loadCircuitArtifact(circuitName);

  // Check current state
  const compDef = await (
    arcium.account as any
  ).computationDefinitionAccount.fetch(compDefPubkey);
  const state = getCircuitState(compDef.circuitSource);
  console.log(`${circuitName}: current state = ${state}`);

  if (state === "OnchainFinalized") {
    console.log(`  Already finalized on-chain, skipping.`);
    return;
  }

  // Calculate how many raw circuit accounts we need
  const numAccs = Math.ceil(rawCircuit.length / (MAX_ACCOUNT_SIZE - 9));
  console.log(
    `  Circuit size: ${rawCircuit.length} bytes → ${numAccs} raw circuit account(s)`,
  );

  const confirmOpts = confirmedRpcOptions(skipPreflight);

  for (let i = 0; i < numAccs; i++) {
    const rawCircuitPart = rawCircuit.subarray(
      i * (MAX_ACCOUNT_SIZE - 9),
      (i + 1) * (MAX_ACCOUNT_SIZE - 9),
    );
    const rawCircuitPda = getRawCircuitAccAddress(compDefPubkey, i);
    const existingAcc = await provider.connection.getAccountInfo(rawCircuitPda);
    const requiredAccountSize = rawCircuitPart.length + 9;

    if (
      existingAcc !== null &&
      existingAcc.data.length >= requiredAccountSize
    ) {
      console.log(`  Raw circuit acc ${i} already exists with sufficient size, skipping init+resize.`);
    } else {
      // Step 1: Create raw circuit account
      if (existingAcc === null) {
        console.log(`  Creating raw circuit acc ${i}...`);
        const sig = await (arcium.methods as any)
          .initRawCircuitAcc(offset, mxeProgramId, i)
          .accounts({ signer: provider.publicKey })
          .rpc(confirmOpts);
        console.log(`  initRawCircuitAcc tx: ${sig}`);
      }

      // Step 2: Resize if needed
      if (rawCircuitPart.length > MAX_REALLOC_PER_IX) {
        const resizeTxCount = Math.ceil(
          rawCircuitPart.length /
            (MAX_REALLOC_PER_IX * MAX_EMBIGGEN_IX_PER_TX),
        );
        for (let r = 0; r < resizeTxCount; r++) {
          console.log(`  Resize tx ${r + 1}/${resizeTxCount}...`);
          const ix = await (arcium.methods as any)
            .embiggenRawCircuitAcc(offset, mxeProgramId, i)
            .accounts({ signer: provider.publicKey })
            .instruction();
          const currentSize =
            MAX_REALLOC_PER_IX +
            r * MAX_REALLOC_PER_IX * MAX_EMBIGGEN_IX_PER_TX;
          const remaining = Math.min(
            rawCircuitPart.length - currentSize,
            MAX_EMBIGGEN_IX_PER_TX * MAX_REALLOC_PER_IX,
          );
          const ixCount = Math.ceil(remaining / MAX_REALLOC_PER_IX);
          const tx = new anchor.web3.Transaction();
          for (let x = 0; x < ixCount; x++) tx.add(ix);
          const blockInfo = await provider.connection.getLatestBlockhash({
            commitment: "confirmed",
          });
          await signAndSendWithBlockhash(provider, tx, blockInfo, confirmOpts);
        }
      }
    }

    // Step 3: Upload circuit data in chunks
    const uploadTxCount = Math.ceil(
      rawCircuitPart.length / MAX_UPLOAD_PER_TX_BYTES,
    );
    console.log(`  Uploading ${uploadTxCount} chunks for acc ${i}...`);

    const CHUNK_SIZE = 8;
    for (let u = 0; u < uploadTxCount; u += CHUNK_SIZE) {
      const batchEnd = Math.min(u + CHUNK_SIZE, uploadTxCount);
      const blockInfo = await provider.connection.getLatestBlockhash({
        commitment: "confirmed",
      });
      const promises = [];
      for (let j = u; j < batchEnd; j++) {
        const byteOffset = MAX_UPLOAD_PER_TX_BYTES * j;
        let chunk = Buffer.from(
          rawCircuitPart.subarray(
            byteOffset,
            byteOffset + MAX_UPLOAD_PER_TX_BYTES,
          ),
        );
        if (chunk.length < MAX_UPLOAD_PER_TX_BYTES) {
          const padded = Buffer.allocUnsafe(MAX_UPLOAD_PER_TX_BYTES);
          padded.set(chunk);
          chunk = padded;
        }
        const tx = await (arcium.methods as any)
          .uploadCircuit(offset, mxeProgramId, i, Array.from(chunk), byteOffset)
          .accounts({ signer: provider.publicKey })
          .transaction();
        promises.push(
          signAndSendWithBlockhash(provider, tx, blockInfo, confirmOpts),
        );
      }
      await Promise.all(promises);
      process.stdout.write(
        `\r  Uploaded chunks ${u + 1}–${batchEnd} / ${uploadTxCount}`,
      );
    }
    console.log();
  }

  // Step 4: Finalize
  console.log(`  Finalizing comp def...`);
  const finalizeTx = await (arcium.methods as any)
    .finalizeComputationDefinition(offset, mxeProgramId)
    .accounts({ signer: provider.publicKey })
    .transaction();
  const blockInfo = await provider.connection.getLatestBlockhash({
    commitment: "confirmed",
  });
  const sig = await signAndSendWithBlockhash(
    provider,
    finalizeTx,
    blockInfo,
    confirmOpts,
  );
  console.log(`  finalizeComputationDefinition tx: ${sig}`);

  // Verify
  const updatedCompDef = await (
    arcium.account as any
  ).computationDefinitionAccount.fetch(compDefPubkey);
  const newState = getCircuitState(updatedCompDef.circuitSource);
  console.log(`  New state: ${newState}`);
  if (newState !== "OnchainFinalized") {
    throw new Error(
      `Expected OnchainFinalized after upload, got ${newState}`,
    );
  }
}

async function main(): Promise<void> {
  const targetCircuit = process.argv[2];
  const circuits = targetCircuit
    ? [targetCircuit]
    : Object.keys(CIRCUIT_ARTIFACTS);

  for (const name of circuits) {
    if (!(name in CIRCUIT_ARTIFACTS)) {
      throw new Error(
        `Unknown circuit: ${name}. Valid: ${Object.keys(CIRCUIT_ARTIFACTS).join(", ")}`,
      );
    }
  }

  const {
    rpcUrl,
    programId,
    runtimeSafety,
    walletKeypair: wallet,
    connection,
    provider,
  } = loadLowkieProgramContext();
  const arcium = getArciumProgram(provider) as ArciumProgram;
  const mxeProgramId = programId;

  const balance = await connection.getBalance(wallet.publicKey, "confirmed");
  console.log(
    `Wallet: ${wallet.publicKey.toBase58()} (${(balance / 1e9).toFixed(4)} SOL)`,
  );
  console.log(`Program: ${mxeProgramId.toBase58()}`);
  console.log(`RPC: ${rpcUrl}\n`);

  for (const name of circuits) {
    console.log(`=== ${name} ===`);
    try {
      await forceUploadCircuit(
        provider,
        arcium,
        name,
        mxeProgramId,
        runtimeSafety.skipPreflight,
      );
      console.log(`✓ ${name} uploaded successfully\n`);
    } catch (err) {
      console.error(`✗ ${name} FAILED:`, err);
      throw err;
    }
  }

  console.log("\nAll circuits uploaded on-chain.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
