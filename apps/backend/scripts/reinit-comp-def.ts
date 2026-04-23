/**
 * Attempts to re-initialize a computation definition with a new offchain URL.
 * Usage: npx ts-node scripts/reinit-comp-def.ts <comp-def-name>
 *   e.g. npx ts-node scripts/reinit-comp-def.ts compact_registry
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getArciumProgram,
  getArciumProgramId,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getCircuitState,
  getLookupTableAddress,
  getMXEAccAddress,
} from "@arcium-hq/client";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  deriveProtocolConfigPda,
} from "../src/core/arciumAccounts";
import {
  loadLowkieProgramContext,
} from "../src/core/programContext";

dotenv.config();

const COMP_DEFS: Record<string, string> = {
  init_pool_balance: "initInitPoolCompDef",
  deposit_to_pool: "initDepositCompDef",
  withdraw_from_pool: "initWithdrawCompDef",
  compact_registry: "initCompactCompDef",
};

function compDefOffset(name: string): number {
  return Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
}

function loadCircuitHash(compDefName: string): number[] {
  const hashPath = path.resolve("build", `${compDefName}.hash`);
  const raw = JSON.parse(fs.readFileSync(hashPath, "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.length !== 32) {
    throw new Error(`Invalid circuit hash at ${hashPath}`);
  }
  return raw;
}

function getOffchainUrl(compDefName: string): string | null {
  const envKey = `LOWKIE_OFFCHAIN_${compDefName.toUpperCase()}_URL`;
  return process.env[envKey]?.trim() || null;
}

async function main(): Promise<void> {
  const compDefName = process.argv[2];
  if (!compDefName || !COMP_DEFS[compDefName]) {
    console.error(`Usage: npx ts-node scripts/reinit-comp-def.ts <${Object.keys(COMP_DEFS).join("|")}>`);
    process.exit(1);
  }

  const methodName = COMP_DEFS[compDefName];
  const {
    programId,
    walletKeypair: wallet,
    provider,
    program,
  } = loadLowkieProgramContext();
  anchor.setProvider(provider);
  const arcium = getArciumProgram(provider);
  const arciumProgram = getArciumProgramId();

  const offset = compDefOffset(compDefName);
  const compDefAccount = getCompDefAccAddress(programId, offset);
  const mxeAccount = getMXEAccAddress(programId);
  const protocolConfig = deriveProtocolConfigPda(programId);

  // Check current state
  const existing = await provider.connection.getAccountInfo(compDefAccount, "confirmed");
  if (existing) {
    const compDef = await (arcium.account as any).computationDefinitionAccount.fetch(compDefAccount);
    const state = getCircuitState(compDef.circuitSource);
    console.log(`Current comp-def state: ${state}`);
    console.log(`Current circuit source:`, JSON.stringify(compDef.circuitSource));
  } else {
    console.log("Comp-def account does not exist yet.");
  }

  const sourceUrl = getOffchainUrl(compDefName);
  if (!sourceUrl) {
    console.error(`No offchain URL configured. Set LOWKIE_OFFCHAIN_${compDefName.toUpperCase()}_URL in .env`);
    process.exit(1);
  }

  const sourceHash = loadCircuitHash(compDefName);
  console.log(`\nAttempting to re-init ${compDefName} with:`);
  console.log(`  URL:  ${sourceUrl}`);
  console.log(`  Hash: [${sourceHash.join(",")}]`);

  const mxe = await (arcium.account as any).mxeAccount.fetch(mxeAccount);
  const addressLookupTable = getLookupTableAddress(programId, mxe.lutOffsetSlot);
  const lutProgram = new PublicKey("AddressLookupTab1e1111111111111111111111111");

  try {
    const tx = await (program.methods as any)
      [methodName](sourceUrl, sourceHash)
      .accounts({
        payer: wallet.publicKey,
        protocolConfig,
        mxeAccount,
        compDefAccount,
        addressLookupTable,
        lutProgram,
        arciumProgram,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log(`\nSuccess! TX: ${tx}`);

    // Verify
    const updated = await (arcium.account as any).computationDefinitionAccount.fetch(compDefAccount);
    const newState = getCircuitState(updated.circuitSource);
    console.log(`Updated comp-def state: ${newState}`);
    console.log(`Updated circuit source:`, JSON.stringify(updated.circuitSource));
  } catch (error: any) {
    console.error(`\nFailed to re-init comp-def:`);
    if (error.logs) {
      console.error(error.logs.join("\n"));
    }
    console.error(error.message || error);
  }
}

void main();
