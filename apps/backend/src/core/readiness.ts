import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  getArciumProgramId,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getMXEAccAddress,
} from "@arcium-hq/client";
import { derivePoolPda, deriveProtocolConfigPda } from "./arciumAccounts";
import { SUPPORTED_DENOMINATION_LAMPORTS } from "./constants";
import { formatSol } from "./utils";

const REQUIRED_COMP_DEF_NAMES = [
  "init_pool_balance",
  "deposit_to_pool",
  "withdraw_from_pool",
  "compact_registry",
] as const;

interface AccountReadiness {
  address: string;
  exists: boolean;
  owner?: string;
}

export interface ComputationDefinitionReadiness extends AccountReadiness {
  name: (typeof REQUIRED_COMP_DEF_NAMES)[number];
}

export interface PoolReadiness extends AccountReadiness {
  denominationLamports: string;
  denominationDisplay: string;
  initialized: boolean;
}

export interface LowkieReadinessReport {
  ready: boolean;
  clusterOffset: number;
  programId: string;
  protocolConfig: AccountReadiness;
  mxeAccount: AccountReadiness;
  computationDefinitions: ComputationDefinitionReadiness[];
  pools: PoolReadiness[];
  issues: string[];
}



function buildReadinessErrorMessage(report: LowkieReadinessReport): string {
  return (
    `Program ${report.programId} is not send-ready on cluster ${report.clusterOffset}. ` +
    `${report.issues.join(" ")} ` +
    "Run yarn bootstrap:program with the current .env or switch LOWKIE_PROGRAM_ID to a fully bootstrapped deployment."
  );
}

export class LowkieReadinessError extends Error {
  readonly report: LowkieReadinessReport;

  constructor(report: LowkieReadinessReport) {
    super(buildReadinessErrorMessage(report));
    this.name = "LowkieReadinessError";
    this.report = report;
  }
}

export async function inspectLowkieReadiness(
  provider: anchor.AnchorProvider,
  program: Program<any>,
  clusterOffset: number,
): Promise<LowkieReadinessReport> {
  const programId = program.programId;
  const arciumProgramId = getArciumProgramId();
  const protocolConfig = deriveProtocolConfigPda(programId);
  const mxeAccount = getMXEAccAddress(programId);
  const compDefs = REQUIRED_COMP_DEF_NAMES.map((name) => ({
    name,
    address: getCompDefAccAddress(
      programId,
      Buffer.from(getCompDefAccOffset(name)).readUInt32LE(),
    ),
  }));
  const pools = SUPPORTED_DENOMINATION_LAMPORTS.map((denominationLamports) => ({
    denominationLamports,
    denominationDisplay: formatSol(denominationLamports),
    address: derivePoolPda(programId, denominationLamports),
  }));

  const accountKeys = [
    protocolConfig,
    mxeAccount,
    ...compDefs.map((compDef) => compDef.address),
    ...pools.map((pool) => pool.address),
  ];
  const accountInfos = await provider.connection.getMultipleAccountsInfo(
    accountKeys,
    "confirmed",
  );
  let infoIndex = 0;
  const protocolConfigInfo = accountInfos[infoIndex++] ?? null;
  const mxeInfo = accountInfos[infoIndex++] ?? null;
  const compDefInfos = compDefs.map((compDef) => ({
    ...compDef,
    info: accountInfos[infoIndex++] ?? null,
  }));
  const poolInfos = pools.map((pool) => ({
    ...pool,
    info: accountInfos[infoIndex++] ?? null,
  }));

  const issues: string[] = [];
  const protocolConfigReadiness: AccountReadiness = {
    address: protocolConfig.toBase58(),
    exists: Boolean(protocolConfigInfo),
    owner: protocolConfigInfo?.owner.toBase58(),
  };
  if (!protocolConfigInfo) {
    issues.push(`Missing protocol config PDA ${protocolConfig.toBase58()}.`);
  } else if (!protocolConfigInfo.owner.equals(programId)) {
    issues.push(
      `Protocol config ${protocolConfig.toBase58()} has unexpected owner ${protocolConfigInfo.owner.toBase58()}.`,
    );
  }

  const mxeReadiness: AccountReadiness = {
    address: mxeAccount.toBase58(),
    exists: Boolean(mxeInfo),
    owner: mxeInfo?.owner.toBase58(),
  };
  if (!mxeInfo) {
    issues.push(`Missing MXE account ${mxeAccount.toBase58()}.`);
  } else if (!mxeInfo.owner.equals(arciumProgramId)) {
    issues.push(
      `MXE account ${mxeAccount.toBase58()} has unexpected owner ${mxeInfo.owner.toBase58()}.`,
    );
  }

  const computationDefinitions = compDefInfos.map(({ name, address, info }) => {
    if (!info) {
      issues.push(
        `Missing computation definition ${name} at ${address.toBase58()}.`,
      );
    } else if (!info.owner.equals(arciumProgramId)) {
      issues.push(
        `Computation definition ${name} at ${address.toBase58()} has unexpected owner ${info.owner.toBase58()}.`,
      );
    }

    return {
      name,
      address: address.toBase58(),
      exists: Boolean(info),
      owner: info?.owner.toBase58(),
    } satisfies ComputationDefinitionReadiness;
  });

  const poolsReadiness = await Promise.all(
    poolInfos.map(
      async ({ denominationLamports, denominationDisplay, address, info }) => {
        let initialized = false;

        if (!info) {
          issues.push(
            `Missing ${denominationDisplay} pool PDA ${address.toBase58()}.`,
          );
        } else if (!info.owner.equals(programId)) {
          issues.push(
            `${denominationDisplay} pool PDA ${address.toBase58()} has unexpected owner ${info.owner.toBase58()}.`,
          );
        } else {
          try {
            const pool = await (program.account as any).poolState.fetch(
              address,
            );
            initialized = Boolean(pool.isInitialized);

            if (!initialized) {
              issues.push(
                `${denominationDisplay} pool PDA ${address.toBase58()} exists but is not initialized.`,
              );
            }

            const actualDenomination = BigInt(
              pool.denominationLamports.toString(),
            );
            if (actualDenomination !== denominationLamports) {
              issues.push(
                `${denominationDisplay} pool PDA ${address.toBase58()} is configured for ${actualDenomination.toString()} lamports.`,
              );
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            issues.push(
              `Unable to decode ${denominationDisplay} pool PDA ${address.toBase58()}: ${message}.`,
            );
          }
        }

        return {
          denominationLamports: denominationLamports.toString(),
          denominationDisplay,
          address: address.toBase58(),
          exists: Boolean(info),
          owner: info?.owner.toBase58(),
          initialized,
        } satisfies PoolReadiness;
      },
    ),
  );

  return {
    ready: issues.length === 0,
    clusterOffset,
    programId: programId.toBase58(),
    protocolConfig: protocolConfigReadiness,
    mxeAccount: mxeReadiness,
    computationDefinitions,
    pools: poolsReadiness,
    issues,
  };
}

export async function assertLowkieReadiness(
  provider: anchor.AnchorProvider,
  program: Program<any>,
  clusterOffset: number,
): Promise<LowkieReadinessReport> {
  const report = await inspectLowkieReadiness(provider, program, clusterOffset);
  if (!report.ready) {
    throw new LowkieReadinessError(report);
  }
  return report;
}
