import { PublicKey } from "@solana/web3.js";

export interface RelaySubNoteMaterial {
  noteSecret: Uint8Array;
  withdrawKey: Uint8Array;
  hash: Buffer;
  denominationLamports: bigint;
  amountLamports: bigint;
}

export interface RelaySubNotePayload {
  noteSecret: number[];
  withdrawKey: number[];
  noteHash: number[];
  denominationLamports: string;
  amountLamports: string;
}

export interface RelayRequest {
  sender?: string;
  recipient: string;
  totalLamports: string;
  delayMs: number;
  clusterOffset: number;
  programId?: string;
  rpcUrl?: string;
  subNotes: RelaySubNotePayload[];
}

export interface RelayResult {
  initialDelayMs: number;
  compactedDenominations: string[];
  withdrawals: Array<{
    noteHashHex: string;
    denominationLamports: string;
    withdrawSig: string;
    compactSig: string;
  }>;
  recipientBalanceBeforeLamports: string;
  recipientBalanceAfterLamports: string;
  totalReceivedLamports: string;
}

export interface ParsedRelayRequest {
  sender?: PublicKey;
  recipient: PublicKey;
  totalLamports: bigint;
  delayMs: number;
  clusterOffset: number;
  programId?: PublicKey;
  rpcUrl?: string;
  subNotes: RelaySubNoteMaterial[];
}

export function serializeRelaySubNotes(
  subNotes: readonly RelaySubNoteMaterial[],
): RelaySubNotePayload[] {
  return subNotes.map((subNote) => ({
    noteSecret: Array.from(subNote.noteSecret),
    withdrawKey: Array.from(subNote.withdrawKey),
    noteHash: Array.from(subNote.hash),
    denominationLamports: subNote.denominationLamports.toString(),
    amountLamports: subNote.amountLamports.toString(),
  }));
}

export function deserializeRelaySubNotes(
  subNotes: readonly RelaySubNotePayload[],
): RelaySubNoteMaterial[] {
  return subNotes.map((subNote) => ({
    noteSecret: new Uint8Array(subNote.noteSecret),
    withdrawKey: new Uint8Array(subNote.withdrawKey),
    hash: Buffer.from(subNote.noteHash),
    denominationLamports: BigInt(subNote.denominationLamports),
    amountLamports: BigInt(subNote.amountLamports),
  }));
}

export function buildRelayRequest(input: {
  sender?: string;
  recipient: string;
  totalLamports: bigint;
  delayMs: number;
  clusterOffset: number;
  programId?: string;
  rpcUrl?: string;
  subNotes: readonly RelaySubNoteMaterial[];
}): RelayRequest {
  return {
    sender: input.sender,
    recipient: input.recipient,
    totalLamports: input.totalLamports.toString(),
    delayMs: input.delayMs,
    clusterOffset: input.clusterOffset,
    programId: input.programId,
    rpcUrl: input.rpcUrl,
    subNotes: serializeRelaySubNotes(input.subNotes),
  };
}

export function parseRelayRequest(request: RelayRequest): ParsedRelayRequest {
  if (!Number.isFinite(request.delayMs) || request.delayMs <= 0) {
    throw new Error("Relay request delayMs must be a positive number.");
  }

  if (!Number.isInteger(request.clusterOffset)) {
    throw new Error("Relay request clusterOffset must be an integer.");
  }

  if (!Array.isArray(request.subNotes) || request.subNotes.length === 0) {
    throw new Error("Relay request must contain at least one sub-note.");
  }

  return {
    sender: request.sender ? new PublicKey(request.sender) : undefined,
    recipient: new PublicKey(request.recipient),
    totalLamports: BigInt(request.totalLamports),
    delayMs: request.delayMs,
    clusterOffset: request.clusterOffset,
    programId: request.programId ? new PublicKey(request.programId) : undefined,
    rpcUrl: request.rpcUrl?.trim() || undefined,
    subNotes: deserializeRelaySubNotes(request.subNotes),
  };
}