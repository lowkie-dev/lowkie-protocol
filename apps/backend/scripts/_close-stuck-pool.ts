/**
 * One-off script to close a stuck pool whose MPC init_pool_balance callback
 * never fired (is_initialized == false).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx ts-node scripts/_close-stuck-pool.ts <denomination_lamports>
 */
import * as anchor from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import dotenv from "dotenv";
import {
  loadLowkieProgramContext,
} from "../src/core/programContext";
import {
  derivePoolPda,
  deriveVaultPda,
  deriveNullifierRegistryPda,
  deriveProtocolConfigPda,
} from "../src/core/arciumAccounts";
dotenv.config();

async function main() {
  const denominationArg = process.argv[2];
  if (!denominationArg) {
    console.error(
      "Usage: npx ts-node scripts/_close-stuck-pool.ts <denomination_lamports>",
    );
    console.error("Example: npx ts-node scripts/_close-stuck-pool.ts 1000000000");
    process.exit(1);
  }

  const denominationLamports = BigInt(denominationArg);
  console.log(
    `Closing stuck pool for denomination ${denominationLamports} lamports (${Number(denominationLamports) / LAMPORTS_PER_SOL} SOL)`,
  );

  const { connection: conn, provider, program } = loadLowkieProgramContext();
  anchor.setProvider(provider);

  const poolPda = derivePoolPda(program.programId, denominationLamports);
  const vaultPda = deriveVaultPda(program.programId, denominationLamports);
  const nullifierRegistryPda = deriveNullifierRegistryPda(
    program.programId,
    denominationLamports,
  );
  const protocolConfigPda = deriveProtocolConfigPda(program.programId);

  // Check pool state first
  const poolInfo = await conn.getAccountInfo(poolPda);
  if (!poolInfo) {
    console.log("Pool PDA does not exist — nothing to close.");
    return;
  }

  try {
    const poolState = await (program.account as any).poolState.fetch(poolPda);
    console.log("Pool state:", {
      isInitialized: poolState.isInitialized,
      denomination: poolState.denominationLamports.toString(),
    });
    if (poolState.isInitialized) {
      console.error("ERROR: Pool is already initialized — refusing to close.");
      process.exit(1);
    }
  } catch (e: any) {
    console.log("Could not fetch pool state via Anchor:", e.message);
  }

  console.log("Sending close_uninitialized_pool transaction...");
  const tx = await (program.methods as any)
    .closeUninitializedPool(new anchor.BN(denominationArg))
    .accounts({
      admin: provider.wallet.publicKey,
      protocolConfig: protocolConfigPda,
      poolState: poolPda,
      vault: vaultPda,
      nullifierRegistry: nullifierRegistryPda,
    })
    .rpc();

  console.log("Transaction signature:", tx);
  console.log("Done! Pool PDAs closed. You can now re-run bootstrap.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
