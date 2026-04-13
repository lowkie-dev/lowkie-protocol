import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getClusterAccAddress,
  getFeePoolAccAddress,
  getClockAccAddress,
} from "@arcium-hq/client";

export function encodeDenominationSeed(
  denominationLamports: bigint | number,
): Buffer {
  const seed = Buffer.alloc(8);
  seed.writeBigUInt64LE(BigInt(denominationLamports));
  return seed;
}

export function derivePoolPda(
  programId: PublicKey,
  denominationLamports: bigint | number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), encodeDenominationSeed(denominationLamports)],
    programId,
  )[0];
}

export function deriveVaultPda(
  programId: PublicKey,
  denominationLamports: bigint | number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), encodeDenominationSeed(denominationLamports)],
    programId,
  )[0];
}

export function deriveNullifierRegistryPda(
  programId: PublicKey,
  denominationLamports: bigint | number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("nullifier_registry"),
      encodeDenominationSeed(denominationLamports),
    ],
    programId,
  )[0];
}

export function deriveNotePda(
  programId: PublicKey,
  noteHash: Buffer,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("note"), noteHash],
    programId,
  )[0];
}

export function buildArciumQueueAccounts(
  programId: PublicKey,
  clusterOffset: number,
  computationOffset: anchor.BN,
  compDefName: string,
) {
  const compDefOffset = Buffer.from(
    getCompDefAccOffset(compDefName),
  ).readUInt32LE();
  return {
    computationAccount: getComputationAccAddress(
      clusterOffset,
      computationOffset,
    ),
    clusterAccount: getClusterAccAddress(clusterOffset),
    mxeAccount: getMXEAccAddress(programId),
    mempoolAccount: getMempoolAccAddress(clusterOffset),
    executingPool: getExecutingPoolAccAddress(clusterOffset),
    compDefAccount: getCompDefAccAddress(programId, compDefOffset),
    poolAccount: getFeePoolAccAddress(),
    clockAccount: getClockAccAddress(),
    systemProgram: SystemProgram.programId,
  };
}
