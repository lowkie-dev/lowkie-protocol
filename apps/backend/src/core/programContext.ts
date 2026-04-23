import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_WALLET_PATH,
  resolveClusterOffset,
  resolveNetworkName,
  resolveProgramId,
  resolveRpcUrl,
} from "./constants";
import { RuntimeSafetyConfig, assertRuntimeSafety } from "./runtimeSafety";
import { resolveKeypairFromEnv } from "./utils";

export interface LowkieRpcRuntimeConfig {
  rpcUrl: string;
  network: string;
  configuredClusterOffset: number | undefined;
  runtimeSafety: RuntimeSafetyConfig;
}

export interface LowkieProgramRuntimeConfig extends LowkieRpcRuntimeConfig {
  programId: PublicKey;
}

export interface LowkieWalletContext {
  walletPath: string;
  walletKeypair: Keypair;
}

export interface LowkieProgramContext extends LowkieProgramRuntimeConfig {
  walletPath: string;
  walletKeypair: Keypair;
  connection: Connection;
  provider: anchor.AnchorProvider;
  program: Program<any>;
}

const DEFAULT_IDL_PATH = path.resolve(
  __dirname,
  "../../../../target/idl/lowkie_pool.json",
);
const DEFAULT_RPC_HTTP_TIMEOUT_MS = 30_000;

function resolveRpcHttpTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LOWKIE_RPC_HTTP_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_RPC_HTTP_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("LOWKIE_RPC_HTTP_TIMEOUT_MS must be a positive integer.");
  }

  return parsed;
}

function createRpcFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  };
}

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

export function loadAnchorWalletContext(
  walletEnvKey = "ANCHOR_WALLET",
  fallbackPath = DEFAULT_WALLET_PATH,
  env: NodeJS.ProcessEnv = process.env,
): LowkieWalletContext {
  const { keypair, source } = resolveKeypairFromEnv(
    walletEnvKey,
    fallbackPath,
    env,
  );
  return {
    walletPath: source,
    walletKeypair: keypair,
  };
}

export function loadLowkieProgramContext(
  options: {
    walletEnvKey?: string;
    walletFallbackPath?: string;
    idlPath?: string;
    commitment?: anchor.web3.Commitment;
    confirmOptions?: anchor.web3.ConfirmOptions;
    env?: NodeJS.ProcessEnv;
  } = {},
): LowkieProgramContext {
  const {
    walletEnvKey = "ANCHOR_WALLET",
    walletFallbackPath = DEFAULT_WALLET_PATH,
    idlPath = DEFAULT_IDL_PATH,
    commitment = "confirmed",
    confirmOptions = { commitment },
    env = process.env,
  } = options;
  const runtime = loadLowkieProgramRuntimeConfig();
  const { walletPath, walletKeypair } = loadAnchorWalletContext(
    walletEnvKey,
    walletFallbackPath,
    env,
  );
  const connection = createAnchorConnection(runtime.rpcUrl, commitment);
  const provider = createAnchorProvider(
    connection,
    walletKeypair,
    confirmOptions,
  );
  const program = loadLowkieProgram(provider, runtime.programId, idlPath);

  return {
    ...runtime,
    walletPath,
    walletKeypair,
    connection,
    provider,
    program,
  };
}

export function createAnchorConnection(
  rpcUrl: string,
  commitment: anchor.web3.Commitment = "confirmed",
): Connection {
  const timeoutMs = resolveRpcHttpTimeoutMs();
  return new Connection(rpcUrl, {
    commitment,
    confirmTransactionInitialTimeout: timeoutMs,
    fetch: createRpcFetch(timeoutMs),
  });
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
    throw new Error(`Missing ${idlPath}. Run \`arcium build\` first.`);
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as anchor.Idl & {
    address?: string;
  };
  idl.address = programId.toBase58();

  return new anchor.Program(idl as anchor.Idl, provider) as Program<any>;
}
