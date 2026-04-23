/**
 * Lowkie — Shared client utilities.
 *
 * Common functions used by both send.ts and relayer.ts.
 * Extracted to reduce duplication and improve maintainability.
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getMXEPublicKey } from "@arcium-hq/client";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_WALLET_PATH,
  MIN_SUPPORTED_DENOMINATION_LAMPORTS,
  SUPPORTED_DENOMINATION_LAMPORTS,
} from "./constants";

// ── Keypair ──────────────────────────────────────────────────────────────────

/**
 * Read a Solana keypair from a JSON file.
 * Supports `~` expansion for home directory.
 */
export function expandHomePath(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }

  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  return filePath;
}

export function resolvePathFromEnv(
  envKey: string,
  fallback = DEFAULT_WALLET_PATH,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveOptionalPathFromEnv(envKey, env) ?? expandHomePath(fallback);
}

export function resolveOptionalPathFromEnv(
  envKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configuredPath = env[envKey]?.trim();
  if (!configuredPath) {
    return undefined;
  }

  return expandHomePath(configuredPath);
}

export function readKeypair(filePath: string): Keypair {
  const resolved = expandHomePath(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Keypair file not found: ${resolved}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved).toString());
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

export async function assertRpcHealth(
  rpcUrl: string,
  guidance: string,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    throw new Error(
      `RPC endpoint ${rpcUrl} is unreachable (${String(error)}). ${guidance}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ── Environment ──────────────────────────────────────────────────────────────

/**
 * Convenience wrapper: parse a boolean env var from `process.env`.
 * Delegates to `parseBooleanEnv` so there is exactly one implementation.
 */
export function envBool(name: string, fallback = false): boolean {
  return parseBooleanEnv(process.env, name, fallback);
}

export function confirmedRpcOptions(
  skipPreflight = false,
): anchor.web3.ConfirmOptions {
  return skipPreflight
    ? { commitment: "confirmed", skipPreflight: true }
    : { commitment: "confirmed" };
}

/**
 * Validate that the relayer keypair differs from the sender keypair.
 * Throws if they're the same (breaks unlinkability).
 */
export function assertDistinctKeypairs(
  sender: Keypair,
  relayer: Keypair,
): void {
  if (relayer.publicKey.equals(sender.publicKey)) {
    throw new Error(
      "RELAYER_KEYPAIR_PATH resolves to the same keypair as ANCHOR_WALLET. " +
        "Use separate keys for unlinkability.",
    );
  }
}

// ── Cryptography ─────────────────────────────────────────────────────────────

/**
 * Compute the note hash commitment:
 * `SHA256(secret ∥ recipient ∥ amount_lamports_le)`
 *
 * This binding commits to all three values. Without the 32-byte `secret`,
 * the preimage is computationally infeasible to recover (2^256 work).
 */
export function computeNoteHash(
  secret: Uint8Array,
  recipient: PublicKey,
  lamports: bigint,
): Buffer {
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(lamports);
  return createHash("sha256")
    .update(secret)
    .update(recipient.toBuffer())
    .update(amountBuf)
    .digest();
}

// ── Recipient Hash ───────────────────────────────────────────────────────────

/**
 * Compute the recipient hash commitment:
 * `SHA256(withdraw_key ∥ recipient_pubkey)`
 *
 * The withdraw_key is a per-note random value separate from note_secret.
 * This ensures the on-chain recipient verification reveals nothing about the
 * note secret, preventing deposit-withdrawal linkage via the secret.
 */
export function computeRecipientHash(
  withdrawKey: Uint8Array,
  recipient: PublicKey,
): Buffer {
  return createHash("sha256")
    .update(withdrawKey)
    .update(recipient.toBuffer())
    .digest();
}

/**
 * Compute the public nullifier commitment:
 * `SHA256("lowkie:nullifier:v1" ∥ note_secret)`
 *
 * This survives note closure and registry compaction without revealing the
 * note secret itself.
 */
export function computeNullifierHash(secret: Uint8Array): Buffer {
  return createHash("sha256")
    .update("lowkie:nullifier:v1")
    .update(secret)
    .digest();
}

/**
 * Split a 32-byte secret into two u128 limbs (little-endian).
 * Used for encrypting note_secret as two Enc<Shared, u128> values.
 */
export function splitSecretToU128(secret: Uint8Array): [bigint, bigint] {
  let lo = 0n;
  for (let i = 0; i < 16; i++) lo |= BigInt(secret[i]) << BigInt(i * 8);
  let hi = 0n;
  for (let i = 0; i < 16; i++) hi |= BigInt(secret[16 + i]) << BigInt(i * 8);
  return [lo, hi];
}

// ── Denomination Decomposition ──────────────────────────────────────────────

/**
 * Decompose a transfer amount into the supported fixed denominations.
 *
 * Example with tiers [1.0, 0.5, 0.1, 0.05, 0.01]:
 *   1.65 SOL -> [1.0, 0.5, 0.1, 0.05]
 *
 * The returned notes are shuffled so deposits do not follow a deterministic
 * largest-to-smallest sequence on-chain.
 */
export function decomposeIntoDenominations(
  totalLamports: bigint,
  supportedDenominations: readonly bigint[] = SUPPORTED_DENOMINATION_LAMPORTS,
): bigint[] {
  if (totalLamports <= 0n) {
    throw new Error("totalLamports must be > 0");
  }

  if (totalLamports < MIN_SUPPORTED_DENOMINATION_LAMPORTS) {
    throw new Error(
      `Amount must be at least ${MIN_SUPPORTED_DENOMINATION_LAMPORTS.toString()} lamports`,
    );
  }

  const notes: bigint[] = [];
  let remaining = totalLamports;

  for (const denomination of supportedDenominations) {
    let count = remaining / denomination;
    while (count > 0n) {
      notes.push(denomination);
      remaining -= denomination;
      count -= 1n;
    }
  }

  if (remaining !== 0n) {
    throw new Error(
      `Amount ${totalLamports.toString()} lamports is not representable using the supported denominations`,
    );
  }

  for (let i = notes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [notes[i], notes[j]] = [notes[j], notes[i]];
  }

  return notes;
}

// ── Formatting ───────────────────────────────────────────────────────────

/**
 * Format a lamport amount as a human-readable SOL string.
 * Centralised here to avoid duplication across client modules.
 */
export function formatSol(lamports: bigint | number): string {
  const solValue =
    typeof lamports === "bigint"
      ? Number(lamports) / LAMPORTS_PER_SOL
      : lamports / LAMPORTS_PER_SOL;
  return `${solValue} SOL`;
}

// ── Environment helpers ──────────────────────────────────────────────────

export type EnvSource = Record<string, string | undefined>;

/**
 * Parse a boolean environment variable.
 * Truthy values: "1", "true", "yes", "on" (case-insensitive).
 *
 * Centralised here — used by runtimeSafety.ts and apps/backend/lib/security.ts.
 */
export function parseBooleanEnv(
  env: EnvSource,
  name: string,
  fallback = false,
): boolean {
  const value = env[name];
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

// ── MXE Key ──────────────────────────────────────────────────────────────────

/**
 * Fetch the MXE public key with retries.
 * The MXE key is required for client-side encryption (Enc<Shared, T>).
 */
export async function fetchMXEKey(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  retries = 20,
): Promise<Uint8Array> {
  let lastError: unknown;

  for (let i = 0; i < retries; i++) {
    try {
      const k = await getMXEPublicKey(provider, programId);
      if (k) return k;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `MXE key fetch attempt ${i + 1}/${retries} failed: ${message}`,
      );
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  if (lastError instanceof Error) {
    throw new Error(`MXE key unavailable after retries: ${lastError.message}`);
  }

  throw new Error("MXE key unavailable after retries. Is the cluster running?");
}
