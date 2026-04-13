import { resolveNetworkName } from "./constants";

export type EnvSource = Record<string, string | undefined>;

export interface RuntimeSafetyConfig {
  network: string;
  autoCompactRegistry: boolean;
  allowUnsafeLocalnet: boolean;
  writePlaintextNoteFile: boolean;
  allowPlaintextNoteFile: boolean;
}

function parseBooleanEnv(
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

export function resolveRuntimeSafetyConfig(
  env: EnvSource = process.env,
  network = resolveNetworkName(),
): RuntimeSafetyConfig {
  return {
    network,
    autoCompactRegistry: parseBooleanEnv(
      env,
      "LOWKIE_AUTO_COMPACT_REGISTRY",
      false,
    ),
    allowUnsafeLocalnet: parseBooleanEnv(
      env,
      "LOWKIE_ALLOW_UNSAFE_LOCALNET",
      false,
    ),
    writePlaintextNoteFile: parseBooleanEnv(
      env,
      "LOWKIE_WRITE_NOTE_FILE",
      false,
    ),
    allowPlaintextNoteFile: parseBooleanEnv(
      env,
      "LOWKIE_ALLOW_PLAINTEXT_NOTE_FILE",
      false,
    ),
  };
}

export function assertRuntimeSafety(
  env: EnvSource = process.env,
  network = resolveNetworkName(),
): RuntimeSafetyConfig {
  const config = resolveRuntimeSafetyConfig(env, network);

  if (config.autoCompactRegistry && config.network !== "localnet") {
    throw new Error(
      "LOWKIE_AUTO_COMPACT_REGISTRY is only supported on localnet. Remove it for devnet, mainnet, or custom RPC deployments.",
    );
  }

  if (config.autoCompactRegistry && !config.allowUnsafeLocalnet) {
    throw new Error(
      "LOWKIE_AUTO_COMPACT_REGISTRY requires LOWKIE_ALLOW_UNSAFE_LOCALNET=true because registry compaction is unsafe and intended only for controlled local demos.",
    );
  }

  if (config.allowPlaintextNoteFile && config.network !== "localnet") {
    throw new Error(
      "LOWKIE_ALLOW_PLAINTEXT_NOTE_FILE is only supported on localnet. Plaintext note material must stay disabled on non-local deployments.",
    );
  }

  if (config.writePlaintextNoteFile && !config.allowPlaintextNoteFile) {
    throw new Error(
      "LOWKIE_WRITE_NOTE_FILE requires LOWKIE_ALLOW_PLAINTEXT_NOTE_FILE=true because it writes plaintext note material to disk.",
    );
  }

  return config;
}
