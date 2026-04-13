import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function detectLocalClusterOffset(): string | null {
  const trustedDealerConfig = path.resolve("artifacts/trusted_dealer_config.toml");
  if (fs.existsSync(trustedDealerConfig)) {
    const content = fs.readFileSync(trustedDealerConfig, "utf8");
    const match = content.match(/cluster_offsets\s*=\s*\[(\d+)\]/);
    if (match?.[1]) {
      return match[1];
    }
  }

  const nodeConfig = path.resolve("artifacts/node_config_0.toml");
  if (fs.existsSync(nodeConfig)) {
    const content = fs.readFileSync(nodeConfig, "utf8");
    const match = content.match(/offset\s*=\s*(\d+)/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

async function checkRpcHealth(rpcUrl: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

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
    fail(
      `RPC endpoint ${rpcUrl} is unreachable (${String(error)}). ` +
      "Start localnet in another terminal with: arcium localnet"
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.ANCHOR_PROVIDER_URL ??= "http://127.0.0.1:8899";
  env.ANCHOR_WALLET ??= path.join(os.homedir(), ".config/solana/id.json");

  if (!env.ARCIUM_CLUSTER_OFFSET) {
    const detectedOffset = detectLocalClusterOffset();
    if (detectedOffset) {
      env.ARCIUM_CLUSTER_OFFSET = detectedOffset;
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

  await checkRpcHealth(env.ANCHOR_PROVIDER_URL);
  runStep("Run integration tests", "yarn", ["-s", "test"], env);

  console.log("\n✅ local:validate passed");
}

void main().catch((error: unknown) => {
  fail(String(error));
});
