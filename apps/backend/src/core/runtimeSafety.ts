import { resolveNetworkName } from "./constants";
import { parseBooleanEnv, EnvSource } from "./utils";

export interface RuntimeSafetyConfig {
  network: string;
  autoCompactRegistry: boolean;
  operatorCompactRegistry: boolean;
  skipPreflight: boolean;
  allowUnsafeLocalnet: boolean;
  writePlaintextNoteFile: boolean;
  allowPlaintextNoteFile: boolean;
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
    operatorCompactRegistry: parseBooleanEnv(
      env,
      "LOWKIE_OPERATOR_COMPACT_REGISTRY",
      false,
    ),
    skipPreflight: parseBooleanEnv(env, "LOWKIE_SKIP_PREFLIGHT", false),
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
      "LOWKIE_AUTO_COMPACT_REGISTRY is only supported on localnet. Remove it for devnet or mainnet deployments.",
    );
  }

  if (config.operatorCompactRegistry && config.network === "mainnet") {
    throw new Error(
      "LOWKIE_OPERATOR_COMPACT_REGISTRY is not supported on mainnet deployments.",
    );
  }

  if (
    config.autoCompactRegistry &&
    config.network === "localnet" &&
    !config.allowUnsafeLocalnet
  ) {
    throw new Error(
      "LOWKIE_AUTO_COMPACT_REGISTRY on localnet requires LOWKIE_ALLOW_UNSAFE_LOCALNET=true.",
    );
  }

  if (
    config.operatorCompactRegistry &&
    config.network === "localnet" &&
    !config.allowUnsafeLocalnet
  ) {
    throw new Error(
      "LOWKIE_OPERATOR_COMPACT_REGISTRY on localnet requires LOWKIE_ALLOW_UNSAFE_LOCALNET=true.",
    );
  }

  if (config.skipPreflight && config.network !== "localnet") {
    throw new Error(
      "LOWKIE_SKIP_PREFLIGHT is only supported on localnet. Remove it for devnet or mainnet deployments.",
    );
  }

  if (
    config.skipPreflight &&
    config.network === "localnet" &&
    !config.allowUnsafeLocalnet
  ) {
    throw new Error(
      "LOWKIE_SKIP_PREFLIGHT on localnet requires LOWKIE_ALLOW_UNSAFE_LOCALNET=true.",
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
