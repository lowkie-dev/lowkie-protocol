/**
 * Lowkie — Shared constants for all client modules.
 *
 * Single source of truth for program IDs, default configs, and
 * denomination values. Keep in sync with the on-chain program.
 */
import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";

// ── Program ──────────────────────────────────────────────────────────────────

export const DEFAULT_PROGRAM_ID = "LowkiePoo1111111111111111111111111111111111";
export const DEFAULT_WALLET_PATH = "~/.config/solana/id.json";

// ── Network defaults ─────────────────────────────────────────────────────────

export const DEFAULT_RPC_URL = "http://127.0.0.1:8899";

/** Supported fixed pool denominations for the MVP, in lamports. */
export const SUPPORTED_DENOMINATION_LAMPORTS = [
  1_000_000_000n,
  100_000_000n,
  10_000_000n,
] as const;

export const MIN_SUPPORTED_DENOMINATION_LAMPORTS =
  SUPPORTED_DENOMINATION_LAMPORTS[SUPPORTED_DENOMINATION_LAMPORTS.length - 1];

/** Cluster offsets for Arcium MXE networks. */
export const CLUSTER_OFFSETS = {
  localnet: 0,
  devnet: 456,
  mainnet: 2026,
} as const;

// ── Relayer ──────────────────────────────────────────────────────────────────

/** Default delay before the relayer submits the withdrawal (ms). */
export const DEFAULT_RELAYER_DELAY_MS = 15_000;

/** Jitter factor applied to the relayer delay (±30%). */
export const RELAYER_JITTER_FACTOR = 0.3;

/** Minimum allowed relayer delay (ms). */
export const MIN_RELAYER_DELAY_MS = 1_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Detect the local Arcium cluster offset from generated artifacts.
 */
export function detectLocalClusterOffset(): number | undefined {
  const trustedDealerConfig = path.resolve(
    "artifacts/trusted_dealer_config.toml",
  );
  if (fs.existsSync(trustedDealerConfig)) {
    const content = fs.readFileSync(trustedDealerConfig, "utf8");
    const match = content.match(/cluster_offsets\s*=\s*\[(\d+)\]/);
    if (match?.[1]) {
      return Number.parseInt(match[1], 10);
    }
  }

  const nodeConfig = path.resolve("artifacts/node_config_0.toml");
  if (fs.existsSync(nodeConfig)) {
    const content = fs.readFileSync(nodeConfig, "utf8");
    const match = content.match(/offset\s*=\s*(\d+)/);
    if (match?.[1]) {
      return Number.parseInt(match[1], 10);
    }
  }

  return undefined;
}

/**
 * Resolve the Lowkie program ID from env, failing if still a placeholder.
 */
export function resolveProgramId(): PublicKey {
  const raw = process.env.LOWKIE_PROGRAM_ID ?? DEFAULT_PROGRAM_ID;
  if (raw === DEFAULT_PROGRAM_ID) {
    throw new Error(
      "LOWKIE_PROGRAM_ID is still a placeholder. Set it to your deployed program ID.",
    );
  }
  return new PublicKey(raw);
}

/**
 * Resolve the RPC URL from env.
 */
export function resolveRpcUrl(): string {
  return process.env.ANCHOR_PROVIDER_URL ?? DEFAULT_RPC_URL;
}

/**
 * Resolve the Arcium cluster offset from env when explicitly configured.
 */
export function resolveClusterOffset(): number | undefined {
  const raw = process.env.ARCIUM_CLUSTER_OFFSET;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error("ARCIUM_CLUSTER_OFFSET must be an integer.");
    }

    return parsed;
  }

  const network = resolveNetworkName();
  if (network === "localnet") {
    return detectLocalClusterOffset() ?? CLUSTER_OFFSETS.localnet;
  }

  return undefined;
}

/**
 * Resolve a human-readable network label from the configured RPC URL.
 */
export function resolveNetworkName(rpcUrl = resolveRpcUrl()): string {
  if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost")) {
    return "localnet";
  }
  if (rpcUrl.includes("devnet")) {
    return "devnet";
  }
  if (rpcUrl.includes("mainnet")) {
    return "mainnet";
  }
  return "custom";
}
