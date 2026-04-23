/**
 * Inspect a pool PDA for a configured denomination.
 *
 * Usage:
 *   npx ts-node scripts/check-pool.ts [denomination_lamports]
 *
 * Defaults to the 1 SOL pool on the current configured cluster.
 */
import dotenv from "dotenv";
import { derivePoolPda } from "../src/core/arciumAccounts";
import { loadLowkieProgramRuntimeConfig, createAnchorConnection } from "../src/core/programContext";

dotenv.config();

function readPoolFlag(data: Buffer, offset: number): string {
  return offset < data.length ? String(data[offset] !== 0) : "n/a";
}

async function main(): Promise<void> {
  const denominationLamports = BigInt(process.argv[2] ?? "1000000000");
  const { rpcUrl, programId } = loadLowkieProgramRuntimeConfig();
  const connection = createAnchorConnection(rpcUrl);
  const poolPda = derivePoolPda(programId, denominationLamports);
  const info = await connection.getAccountInfo(poolPda, "confirmed");

  console.log(`RPC: ${rpcUrl}`);
  console.log(`Program: ${programId.toBase58()}`);
  console.log(`Pool: ${poolPda.toBase58()}`);
  console.log(`Denomination: ${denominationLamports.toString()} lamports`);

  if (!info) {
    console.log("Pool not found");
    return;
  }

  const data = Buffer.from(info.data);
  console.log(`Owner: ${info.owner.toBase58()}`);
  console.log(`Size: ${data.length}`);
  console.log(`Anchor isInitialized byte@64: ${readPoolFlag(data, 64)}`);
  console.log(`Legacy isInitialized byte@66: ${readPoolFlag(data, 66)}`);

  if (data.length >= 64) {
    console.log(`Denomination field@56: ${data.readBigUInt64LE(56).toString()}`);
  }

  if (data.length >= 48) {
    console.log(`Balance nonce@40: ${data.readBigUInt64LE(40).toString()}`);
  }

  if (data.length >= 12) {
    console.log(`Encrypted balance[0..4]: ${data.subarray(8, 12).toString("hex")}`);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});