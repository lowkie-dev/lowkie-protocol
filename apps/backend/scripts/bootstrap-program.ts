import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  awaitComputationFinalization,
  deserializeLE,
  getArciumEnv,
  getArciumProgram,
  getArciumProgramId,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getCircuitState,
  getLookupTableAddress,
  getMXEAccAddress,
  getRawCircuitAccAddress,
  RescueCipher,
  uploadCircuit,
  x25519,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  buildArciumQueueAccounts,
  deriveNullifierRegistryPda,
  derivePoolPda,
  deriveProtocolConfigPda,
  deriveVaultPda,
} from "../src/core/arciumAccounts";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  SUPPORTED_DENOMINATION_LAMPORTS,
} from "../src/core/constants";
import {
  loadLowkieProgramContext,
} from "../src/core/programContext";
import {
  assertRpcHealth,
  confirmedRpcOptions,
  fetchMXEKey,
  readKeypair,
  resolveOptionalKeypairFromEnv,
  resolveOptionalPathFromEnv,
  resolvePathFromEnv,
} from "../src/core/utils";

dotenv.config();

const CIRCUIT_ARTIFACTS = {
  init_pool_balance: "build/init_pool_balance.arcis",
  deposit_to_pool: "build/deposit_to_pool.arcis",
  withdraw_from_pool: "build/withdraw_from_pool.arcis",
  compact_registry: "build/compact_registry.arcis",
} as const;

const CIRCUIT_UPLOAD_CHUNK_SIZE = Number.parseInt(
  process.env.LOWKIE_CIRCUIT_UPLOAD_CHUNK_SIZE ?? "8",
  10,
);
const BOOTSTRAP_FEE_BUFFER_LAMPORTS = BigInt(
  Math.floor(0.25 * LAMPORTS_PER_SOL),
);

type CompDefName = keyof typeof CIRCUIT_ARTIFACTS;
type CircuitRegistrationMode = "onchain" | "offchain";

function getOffchainCircuitUrlEnvName(compDefName: CompDefName): string {
  return `LOWKIE_OFFCHAIN_${compDefName.toUpperCase()}_URL`;
}

function hasConfiguredOffchainCircuitSource(): boolean {
  if (
    typeof process.env.LOWKIE_OFFCHAIN_CIRCUIT_BASE_URL === "string" &&
    process.env.LOWKIE_OFFCHAIN_CIRCUIT_BASE_URL.trim().length > 0
  ) {
    return true;
  }

  return (Object.keys(CIRCUIT_ARTIFACTS) as CompDefName[]).some(
    (compDefName) => {
      const value = process.env[getOffchainCircuitUrlEnvName(compDefName)];
      return typeof value === "string" && value.trim().length > 0;
    },
  );
}

function resolveCircuitRegistrationMode(): CircuitRegistrationMode {
  const rawMode = process.env.LOWKIE_CIRCUIT_SOURCE_MODE?.trim().toLowerCase();

  if (!rawMode || rawMode === "auto") {
    return hasConfiguredOffchainCircuitSource() ? "offchain" : "onchain";
  }

  if (rawMode === "onchain" || rawMode === "offchain") {
    return rawMode;
  }

  throw new Error(
    `Unsupported LOWKIE_CIRCUIT_SOURCE_MODE=${rawMode}. Expected auto, onchain, or offchain.`,
  );
}

function resolveOffchainCircuitBaseUrl(
  mode: CircuitRegistrationMode,
): string | null {
  if (mode !== "offchain") {
    return null;
  }

  const hasExplicitCircuitUrl = (
    Object.keys(CIRCUIT_ARTIFACTS) as CompDefName[]
  ).some((compDefName) => {
    const value = process.env[getOffchainCircuitUrlEnvName(compDefName)];
    return typeof value === "string" && value.trim().length > 0;
  });

  const baseUrl = process.env.LOWKIE_OFFCHAIN_CIRCUIT_BASE_URL?.trim();
  if (!baseUrl && hasExplicitCircuitUrl) {
    return null;
  }

  if (!baseUrl) {
    throw new Error(
      "LOWKIE_OFFCHAIN_CIRCUIT_BASE_URL is required when LOWKIE_CIRCUIT_SOURCE_MODE=offchain.",
    );
  }

  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function loadCircuitHash(compDefName: CompDefName): number[] {
  const artifactPath = path.resolve("build", `${compDefName}.hash`);
  const raw = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as unknown;

  if (
    !Array.isArray(raw) ||
    raw.length !== 32 ||
    raw.some(
      (byte) =>
        typeof byte !== "number" ||
        !Number.isInteger(byte) ||
        byte < 0 ||
        byte > 255,
    )
  ) {
    throw new Error(
      `Invalid circuit hash artifact for ${compDefName}: expected a JSON array of 32 bytes at ${artifactPath}`,
    );
  }

  return raw;
}

function getOffchainCircuitSource(
  compDefName: CompDefName,
  offchainBaseUrl: string | null,
): { sourceUrl: string; hash: number[] } | null {
  const explicitSourceUrl =
    process.env[getOffchainCircuitUrlEnvName(compDefName)]?.trim();

  if (!explicitSourceUrl && !offchainBaseUrl) {
    return null;
  }

  return {
    sourceUrl: explicitSourceUrl ?? `${offchainBaseUrl}${compDefName}.arcis`,
    hash: loadCircuitHash(compDefName),
  };
}

function compDefOffset(name: string): number {
  return Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
}

function loadCircuitArtifact(compDefName: CompDefName): Uint8Array {
  const artifactPath = path.resolve(CIRCUIT_ARTIFACTS[compDefName]);
  return new Uint8Array(fs.readFileSync(artifactPath));
}

function formatSol(lamports: bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(9);
}

function describeDenomination(lamports: bigint): string {
  return `${formatSol(lamports)} SOL`;
}

async function assertSufficientBootstrapBalance(
  provider: anchor.AnchorProvider,
  payer: PublicKey,
  programId: PublicKey,
  mode: CircuitRegistrationMode,
): Promise<void> {
  if (mode === "offchain") {
    return;
  }

  const balanceLamports = BigInt(
    await provider.connection.getBalance(payer, "confirmed"),
  );
  const shortages: string[] = [];
  let totalShortfallLamports = 0n;

  for (const compDefName of Object.keys(CIRCUIT_ARTIFACTS) as CompDefName[]) {
    const circuitArtifact = loadCircuitArtifact(compDefName);
    const requiredAccountBytes = circuitArtifact.length + 9;
    const requiredLamports = BigInt(
      await provider.connection.getMinimumBalanceForRentExemption(
        requiredAccountBytes,
      ),
    );
    const compDefAccount = getCompDefAccAddress(
      programId,
      compDefOffset(compDefName),
    );
    const rawCircuitAccount = getRawCircuitAccAddress(compDefAccount, 0);
    const existing = await provider.connection.getAccountInfo(
      rawCircuitAccount,
      "confirmed",
    );
    const currentLamports = BigInt(existing?.lamports ?? 0);

    if (currentLamports < requiredLamports) {
      const shortfallLamports = requiredLamports - currentLamports;
      totalShortfallLamports += shortfallLamports;
      shortages.push(
        `${compDefName}: ${formatSol(shortfallLamports)} SOL short`,
      );
    }
  }

  const requiredLamports =
    totalShortfallLamports + BOOTSTRAP_FEE_BUFFER_LAMPORTS;
  if (balanceLamports >= requiredLamports) {
    return;
  }

  const missingLamports = requiredLamports - balanceLamports;
  throw new Error(
    `Insufficient funds for bootstrap. Wallet ${payer.toBase58()} has ${formatSol(balanceLamports)} SOL, but needs at least ${formatSol(missingLamports)} more SOL to finish pending on-chain circuit uploads. Shortfalls: ${shortages.join(", ")}. Public devnet airdrops may be rate-limited; fund the wallet and rerun yarn bootstrap:program. If you intended off-chain circuits, set LOWKIE_OFFCHAIN_CIRCUIT_BASE_URL (or per-circuit LOWKIE_OFFCHAIN_*_URL values) and leave LOWKIE_CIRCUIT_SOURCE_MODE unset or set it to auto/offchain.`,
  );
}

async function ensureComputationDefinitions(
  provider: anchor.AnchorProvider,
  program: Program<any>,
  payer: PublicKey,
  protocolConfig: PublicKey,
  mode: CircuitRegistrationMode,
  offchainBaseUrl: string | null,
  skipPreflight: boolean,
): Promise<void> {
  const programId = program.programId;
  const mxeAccount = getMXEAccAddress(programId);
  const arcium = getArciumProgram(provider);
  const arciumProgram = getArciumProgramId();
  const mxe = await (arcium.account as any).mxeAccount.fetch(mxeAccount);
  const addressLookupTable = getLookupTableAddress(
    programId,
    mxe.lutOffsetSlot,
  );
  const lutProgram = new PublicKey(
    "AddressLookupTab1e1111111111111111111111111",
  );

  for (const [method, compDefName] of [
    ["initInitPoolCompDef", "init_pool_balance"],
    ["initDepositCompDef", "deposit_to_pool"],
    ["initWithdrawCompDef", "withdraw_from_pool"],
    ["initCompactCompDef", "compact_registry"],
  ] as const satisfies ReadonlyArray<readonly [string, CompDefName]>) {
    const offset = compDefOffset(compDefName);
    const compDefAccount = getCompDefAccAddress(programId, offset);
    const offchainSource = getOffchainCircuitSource(
      compDefName,
      offchainBaseUrl,
    );
    let existing = await provider.connection.getAccountInfo(
      compDefAccount,
      "confirmed",
    );

    if (!existing) {
      console.log(
        `Registering computation definition: ${compDefName} (${mode})`,
      );
      await (program.methods as any)
        [method](
          offchainSource?.sourceUrl ?? null,
          offchainSource?.hash ?? null,
        )
        .accounts({
          payer,
          protocolConfig,
          mxeAccount,
          compDefAccount,
          addressLookupTable,
          lutProgram,
          arciumProgram,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

      existing = await provider.connection.getAccountInfo(
        compDefAccount,
        "confirmed",
      );
    }

    if (!existing?.owner.equals(arciumProgram)) {
      throw new Error(
        `Computation definition account not ready: ${compDefName}`,
      );
    }

    const compDef = await (
      arcium.account as any
    ).computationDefinitionAccount.fetch(compDefAccount);
    const circuitState = getCircuitState(compDef.circuitSource);

    if (mode === "offchain") {
      if (circuitState === "OnchainPending") {
        throw new Error(
          `Computation definition ${compDefName} already exists with a pending on-chain circuit upload. Off-chain mode cannot override that state; use a fresh program deployment or finish the pending upload first.`,
        );
      }

      if (circuitState !== "Offchain") {
        console.log(
          `Computation definition ready: ${compDefName} (already finalized on-chain)`,
        );
        continue;
      }

      console.log(
        `Computation definition ready: ${compDefName} (${offchainSource?.sourceUrl})`,
      );
      continue;
    }

    await uploadCircuit(
      provider,
      compDefName,
      programId,
      loadCircuitArtifact(compDefName),
      true,
      CIRCUIT_UPLOAD_CHUNK_SIZE,
      confirmedRpcOptions(skipPreflight),
    );

    console.log(`Computation definition ready: ${compDefName}`);
  }
}

async function ensureProtocolConfig(
  program: Program<any>,
  wallet: anchor.web3.Keypair,
  maintenanceAuthority: PublicKey,
): Promise<PublicKey> {
  const protocolConfigPDA = deriveProtocolConfigPda(program.programId);

  try {
    const existing = await (program.account as any).protocolConfig.fetch(
      protocolConfigPDA,
    );
    if (!new PublicKey(existing.admin).equals(wallet.publicKey)) {
      console.log(
        `Protocol config already initialized: ${protocolConfigPDA.toBase58()}`,
      );
      return protocolConfigPDA;
    }

    if (
      !new PublicKey(existing.maintenanceAuthority).equals(maintenanceAuthority)
    ) {
      const methods = program.methods as any;
      await methods
        .updateProtocolConfig(null, maintenanceAuthority)
        .accounts({
          admin: wallet.publicKey,
          protocolConfig: protocolConfigPDA,
        })
        .rpc({ commitment: "confirmed" });
      console.log(
        `Updated maintenance authority: ${maintenanceAuthority.toBase58()}`,
      );
    }

    return protocolConfigPDA;
  } catch {
    const methods = program.methods as any;
    await methods
      .initializeProtocolConfig(maintenanceAuthority)
      .accounts({
        payer: wallet.publicKey,
        protocolConfig: protocolConfigPDA,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });
    console.log(`Initialized protocol config: ${protocolConfigPDA.toBase58()}`);
    return protocolConfigPDA;
  }
}

async function ensurePoolInitialized(
  provider: anchor.AnchorProvider,
  program: Program<any>,
  wallet: anchor.web3.Keypair,
  clusterOffset: number,
  mxeKey: Uint8Array,
  denominationLamports: bigint,
): Promise<void> {
  const programId = program.programId;
  const poolPDA = derivePoolPda(programId, denominationLamports);
  const vaultPDA = deriveVaultPda(programId, denominationLamports);
  const nullifierRegistryPDA = deriveNullifierRegistryPda(
    programId,
    denominationLamports,
  );
  const protocolConfigPDA = deriveProtocolConfigPda(programId);

  try {
    const existingPool = await (program.account as any).poolState.fetch(
      poolPDA,
    );
    if (existingPool.isInitialized) {
      console.log(
        `Pool ${describeDenomination(denominationLamports)} already initialized.`,
      );
      return;
    }
    // Pool exists but MPC callback never fired — close it so we can retry.
    console.log(
      `Pool ${describeDenomination(denominationLamports)} exists but is_initialized=false. Closing stuck PDAs...`,
    );
    await (program.methods as any)
      .closeUninitializedPool(
        new anchor.BN(denominationLamports.toString()),
      )
      .accounts({
        admin: wallet.publicKey,
        protocolConfig: protocolConfigPDA,
        poolState: poolPDA,
        vault: vaultPDA,
        nullifierRegistry: nullifierRegistryPDA,
      })
      .rpc({ commitment: "confirmed" });
    console.log("Stuck PDAs closed. Re-creating pool...");
  } catch {
    // Pool not created yet.
  }

  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const cipher = new RescueCipher(x25519.getSharedSecret(privateKey, mxeKey));
  const nonce = randomBytes(16);
  const ciphertext = cipher.encrypt([0n], nonce);
  const nonceBN = new anchor.BN(deserializeLE(nonce).toString());
  const computationOffset = new anchor.BN(randomBytes(8), "hex");

  console.log(
    `Initializing ${describeDenomination(denominationLamports)} pool...`,
  );
  await program.methods
    .initPool(
      computationOffset,
      new anchor.BN(denominationLamports.toString()),
      Array.from(ciphertext[0]),
      Array.from(publicKey),
      nonceBN,
    )
    .accountsPartial({
      payer: wallet.publicKey,
      poolState: poolPDA,
      vault: vaultPDA,
      nullifierRegistry: nullifierRegistryPDA,
      ...buildArciumQueueAccounts(
        programId,
        clusterOffset,
        computationOffset,
        "init_pool_balance",
      ),
    })
    .rpc({ commitment: "confirmed" });

  const MPC_POOL_INIT_TIMEOUT = 600_000; // 10 minutes for devnet
  console.log(
    `Waiting up to ${MPC_POOL_INIT_TIMEOUT / 1000}s for MPC finalization...`,
  );
  await awaitComputationFinalization(
    provider,
    computationOffset,
    programId,
    "confirmed",
    MPC_POOL_INIT_TIMEOUT,
  );

  const pool = await (program.account as any).poolState.fetch(poolPDA);
  if (!pool.isInitialized) {
    throw new Error(
      `Pool bootstrap finished without setting is_initialized for ${describeDenomination(denominationLamports)}.`,
    );
  }

  console.log(
    `Pool ${describeDenomination(denominationLamports)} initialized.`,
  );
}

async function main(): Promise<void> {
  const {
    rpcUrl: rpc,
    network,
    programId,
    configuredClusterOffset,
    runtimeSafety,
    walletKeypair: wallet,
    provider,
    program,
  } = loadLowkieProgramContext();
  const maintenanceWallet =
    resolveOptionalKeypairFromEnv("RELAYER_KEYPAIR_PATH")?.keypair ?? wallet;
  anchor.setProvider(provider);
  const arciumEnv = getArciumEnv();
  const clusterOffset =
    configuredClusterOffset ?? arciumEnv.arciumClusterOffset;
  const circuitRegistrationMode = resolveCircuitRegistrationMode();
  const offchainCircuitBaseUrl = resolveOffchainCircuitBaseUrl(
    circuitRegistrationMode,
  );

  console.log("\nLowkie bootstrap");
  console.log(`  Network: ${network}`);
  console.log(`  RPC:     ${rpc}`);
  console.log(`  Program: ${programId.toBase58()}`);
  console.log(`  Circuits: ${circuitRegistrationMode}`);
  console.log(`  Admin:   ${wallet.publicKey.toBase58()}`);
  console.log(`  Maint:   ${maintenanceWallet.publicKey.toBase58()}`);
  if (offchainCircuitBaseUrl) {
    console.log(`  Source:  ${offchainCircuitBaseUrl}`);
  }
  for (const denominationLamports of SUPPORTED_DENOMINATION_LAMPORTS) {
    console.log(
      `  Pool:    ${describeDenomination(denominationLamports)} -> ${derivePoolPda(programId, denominationLamports).toBase58()}`,
    );
    console.log(
      `  Vault:   ${describeDenomination(denominationLamports)} -> ${deriveVaultPda(programId, denominationLamports).toBase58()}`,
    );
  }
  console.log(`  Cluster: ${clusterOffset}`);

  await assertRpcHealth(
    rpc,
    "Check ANCHOR_PROVIDER_URL and ensure the target cluster is running before bootstrapping.",
  );

  await assertSufficientBootstrapBalance(
    provider,
    wallet.publicKey,
    programId,
    circuitRegistrationMode,
  );

  const protocolConfigPDA = await ensureProtocolConfig(
    program,
    wallet,
    maintenanceWallet.publicKey,
  );

  await ensureComputationDefinitions(
    provider,
    program,
    wallet.publicKey,
    protocolConfigPDA,
    circuitRegistrationMode,
    offchainCircuitBaseUrl,
    runtimeSafety.skipPreflight,
  );
  const mxeKey = await fetchMXEKey(provider, programId);
  for (const denominationLamports of SUPPORTED_DENOMINATION_LAMPORTS) {
    await ensurePoolInitialized(
      provider,
      program,
      wallet,
      clusterOffset,
      mxeKey,
      denominationLamports,
    );
  }

  console.log("All configured pools initialized.");
}

async function logUnknownError(error: unknown): Promise<void> {
  if (error && typeof error === "object") {
    const maybeWithLogs = error as {
      logs?: string[];
      getLogs?: () => Promise<string[]>;
    };

    if (Array.isArray(maybeWithLogs.logs) && maybeWithLogs.logs.length > 0) {
      console.error(maybeWithLogs.logs.join("\n"));
    } else if (typeof maybeWithLogs.getLogs === "function") {
      try {
        const logs = await maybeWithLogs.getLogs();
        if (logs.length > 0) {
          console.error(logs.join("\n"));
        }
      } catch {
        // Fall through to object printing below.
      }
    }
  }

  console.dir(error, { depth: null });
}

void main().catch(async (error: unknown) => {
  await logUnknownError(error);
  process.exit(1);
});
