import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_WALLET_PATH,
  detectLocalClusterOffset,
} from "../src/core/constants";
import { assertRpcHealth, resolvePathFromEnv } from "../src/core/utils";

function fail(message: string): never {
  console.error(`\n[local:validate] ${message}`);
  process.exit(1);
}

function runStep(title: string, command: string, args: string[], env: NodeJS.ProcessEnv): void {
  console.log(`\n==> ${title}`);
  const result = spawnSync(command, args, { stdio: "inherit", env });

  if (result.error) {
    if (result.error.message.includes("ENOENT")) {
      fail(`Missing command: ${command}. Install it and retry.`);
    }
    fail(`${title} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    fail(`${title} failed with exit code ${result.status}.`);
  }
}

async function main(): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.ANCHOR_PROVIDER_URL ??= "http://127.0.0.1:8899";
  env.ANCHOR_WALLET = resolvePathFromEnv(
    "ANCHOR_WALLET",
    DEFAULT_WALLET_PATH,
    env,
  );

  if (!env.ARCIUM_CLUSTER_OFFSET) {
    const detectedOffset = detectLocalClusterOffset();
    if (detectedOffset !== undefined) {
      env.ARCIUM_CLUSTER_OFFSET = detectedOffset.toString();
      console.log(`[local:validate] Using detected ARCIUM_CLUSTER_OFFSET=${detectedOffset}`);
    } else {
      fail(
        "ARCIUM_CLUSTER_OFFSET is not set and could not be auto-detected from artifacts. Start localnet with arcium localnet and export ARCIUM_CLUSTER_OFFSET in this shell."
      );
    }
  }

  if (!env.ANCHOR_WALLET || !fs.existsSync(env.ANCHOR_WALLET)) {
    fail(`ANCHOR_WALLET not found at ${env.ANCHOR_WALLET}.`);
  }

  runStep("Run static checks", "yarn", ["-s", "ci:check"], env);

  const idlPath = path.resolve("target/idl/lowkie_pool.json");
  if (!fs.existsSync(idlPath)) {
    runStep("Build Arcium artifacts", "arcium", ["build"], env);
  }

  if (!fs.existsSync(idlPath)) {
    fail("Missing target/idl/lowkie_pool.json after build.");
  }

  try {
    await assertRpcHealth(
      env.ANCHOR_PROVIDER_URL,
      "Start localnet in another terminal with: arcium localnet",
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  runStep("Run integration tests", "yarn", ["-s", "test"], env);

  console.log("\n✅ local:validate passed");
}

void main().catch((error: unknown) => {
  fail(String(error));
});
