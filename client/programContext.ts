import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import {
  resolveClusterOffset,
  resolveNetworkName,
  resolveProgramId,
  resolveRpcUrl,
} from "./constants";
import { RuntimeSafetyConfig, assertRuntimeSafety } from "./runtimeSafety";

export interface LowkieRpcRuntimeConfig {
  rpcUrl: string;
  network: string;
  configuredClusterOffset: number | undefined;
  runtimeSafety: RuntimeSafetyConfig;
}

export interface LowkieProgramRuntimeConfig extends LowkieRpcRuntimeConfig {
  programId: PublicKey;
}

const DEFAULT_IDL_PATH = "./target/idl/lowkie_pool.json";

export function loadLowkieRpcRuntimeConfig(): LowkieRpcRuntimeConfig {
  const rpcUrl = resolveRpcUrl();
  const network = resolveNetworkName(rpcUrl);

  return {
    rpcUrl,
    network,
    configuredClusterOffset: resolveClusterOffset(),
    runtimeSafety: assertRuntimeSafety(process.env, network),
  };
}

export function loadLowkieProgramRuntimeConfig(): LowkieProgramRuntimeConfig {
  const runtime = loadLowkieRpcRuntimeConfig();

  return {
    ...runtime,
    programId: resolveProgramId(),
  };
}

export function createAnchorConnection(
  rpcUrl: string,
  commitment: anchor.web3.Commitment = "confirmed",
): Connection {
  return new Connection(rpcUrl, commitment);
}

export function createAnchorProvider(
  connection: Connection,
  walletKeypair: Keypair,
  options: anchor.web3.ConfirmOptions = { commitment: "confirmed" },
): anchor.AnchorProvider {
  return new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(walletKeypair),
    options,
  );
}

export function loadLowkieProgram(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  idlPath = DEFAULT_IDL_PATH,
): Program<any> {
  if (!fs.existsSync(idlPath)) {
    throw new Error(
      `Missing ${idlPath}. Run \`arcium build\` first.`,
    );
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as anchor.Idl & {
    address?: string;
  };
  idl.address = programId.toBase58();

  return new anchor.Program(idl as anchor.Idl, provider) as Program<any>;
}