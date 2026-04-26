import dotenv from "dotenv";
import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { Keypair } from "@solana/web3.js";
import {
  lowkieSend,
  lowkieBuildDeposits,
  lowkieSubmitDeposits,
  WithdrawalFailedError,
} from "./src/core/send";
import {
  recoverWithdrawal,
  recoverRefund,
  listRecoverableTransfers,
} from "./src/core/recover";
import {
  loadRecoveryFile,
  deleteRecoveryFile,
} from "./src/core/recoveryStore";
import {
  inspectLowkieReadiness,
  LowkieReadinessError,
} from "./src/core/readiness";
import {
  DEFAULT_WALLET_PATH,
  SUPPORTED_DENOMINATION_DISPLAY,
  SUPPORTED_DENOMINATION_LAMPORTS,
} from "./src/core/constants";
import { derivePoolPda } from "./src/core/arciumAccounts";
import {
  createAnchorConnection,
  createAnchorProvider,
  loadLowkieProgram,
  loadLowkieProgramRuntimeConfig,
  loadLowkieRpcRuntimeConfig,
} from "./src/core/programContext";
import { resolveRemoteRelayerConfig } from "./src/core/relayClient";
import { executeRelayRequest } from "./src/core/relayer";
import { RelayRequest } from "./src/core/relayProtocol";
import {
  redactAmountSol,
  redactErrorMessage,
  redactValue,
} from "./src/core/privacyLogging";
import {
  resolveKeypairFromEnv,
  resolveOptionalKeypairFromEnv,
  resolveOptionalPathFromEnv,
} from "./src/core/utils";
import {
  createFixedWindowRateLimiter,
  isAuthorized,
  resolveApiSecurityConfig,
} from "./lib/security";

dotenv.config();

// ── Global error handlers — prevent silent crashes ──────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

const HOST =
  process.env.HOST ??
  process.env.BACKEND_HOST ??
  process.env.FRONTEND_HOST ??
  "0.0.0.0";
const PORT = Number(
  process.env.PORT ??
    process.env.BACKEND_PORT ??
    process.env.FRONTEND_PORT ??
    "5174",
);
const {
  rpcUrl: RPC,
  network: NETWORK,
  runtimeSafety: RUNTIME_SAFETY,
} = loadLowkieRpcRuntimeConfig();
const SECURITY = resolveApiSecurityConfig({
  env: process.env,
  host: HOST,
  network: NETWORK,
});
const REMOTE_RELAYER = resolveRemoteRelayerConfig();
const rateLimit = createFixedWindowRateLimiter(SECURITY);

let sendInFlight = false;
let relayInFlight = false;

function resolveSenderWalletInfo(): {
  senderWalletConfigured: boolean;
  senderWalletAddress: string | null;
  senderWalletSource: "env" | "default";
  senderWalletError?: string;
  keypair?: Keypair;
} {
  const configuredSender = resolveOptionalKeypairFromEnv("SENDER_WALLET");
  const senderWalletSource = configuredSender ? "env" : "default";

  try {
    const keypair = resolveKeypairFromEnv(
      "SENDER_WALLET",
      DEFAULT_WALLET_PATH,
    ).keypair;
    return {
      senderWalletConfigured: true,
      senderWalletAddress: keypair.publicKey.toBase58(),
      senderWalletSource,
      keypair,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      senderWalletConfigured: false,
      senderWalletAddress: null,
      senderWalletSource,
      senderWalletError: message,
    };
  }
}

function resolveRelayerWalletInfo(): {
  relayerWalletConfigured: boolean;
  relayerWalletAddress: string | null;
  relayerWalletError?: string;
} {
  const relayerResolution = resolveOptionalKeypairFromEnv(
    "RELAYER_KEYPAIR_PATH",
  );
  if (!relayerResolution) {
    return {
      relayerWalletConfigured: false,
      relayerWalletAddress: null,
      relayerWalletError: "RELAYER_KEYPAIR_PATH is not configured.",
    };
  }

  try {
    const keypair = relayerResolution.keypair;
    return {
      relayerWalletConfigured: true,
      relayerWalletAddress: keypair.publicKey.toBase58(),
    };
  } catch (error) {
    return {
      relayerWalletConfigured: false,
      relayerWalletAddress: null,
      relayerWalletError:
        error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveConfiguredProgramStatus(): {
  programId: string;
  clusterOffset: number | string;
  programRuntimeError?: string;
} {
  try {
    const { programId, configuredClusterOffset } =
      loadLowkieProgramRuntimeConfig();
    return {
      programId: programId.toBase58(),
      clusterOffset: configuredClusterOffset ?? "unset",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      programId: process.env.LOWKIE_PROGRAM_ID ?? "unset",
      clusterOffset: process.env.ARCIUM_CLUSTER_OFFSET ?? "unset",
      programRuntimeError: message,
    };
  }
}

async function resolveHealthPayload(): Promise<Record<string, unknown>> {
  const senderWalletInfo = resolveSenderWalletInfo();
  const relayerWalletInfo = resolveRelayerWalletInfo();
  const configuredProgram = resolveConfiguredProgramStatus();
  const basePayload = {
    ok: true,
    rpc: RPC,
    programId: configuredProgram.programId,
    clusterOffset: configuredProgram.clusterOffset,
    network: NETWORK,
    senderWalletConfigured: senderWalletInfo.senderWalletConfigured,
    senderWalletAddress: senderWalletInfo.senderWalletAddress,
    senderWalletSource: senderWalletInfo.senderWalletSource,
    ...(senderWalletInfo.senderWalletError
      ? { senderWalletError: senderWalletInfo.senderWalletError }
      : {}),
    relayerMode: REMOTE_RELAYER ? "remote" : "local",
    relayerRemoteUrl: REMOTE_RELAYER?.url,
    relayerExecutionConfigured: REMOTE_RELAYER
      ? true
      : relayerWalletInfo.relayerWalletConfigured,
    relayerWalletConfigured: relayerWalletInfo.relayerWalletConfigured,
    relayerWalletAddress: relayerWalletInfo.relayerWalletAddress,
    ...(relayerWalletInfo.relayerWalletError
      ? { relayerWalletError: relayerWalletInfo.relayerWalletError }
      : {}),
    ...(configuredProgram.programRuntimeError
      ? { programRuntimeError: configuredProgram.programRuntimeError }
      : {}),
    authRequired: SECURITY.requireApiAuth,
    rateLimitWindowMs: SECURITY.rateLimitWindowMs,
    rateLimitMaxRequests: SECURITY.rateLimitMaxRequests,
    serializeSendRequests: SECURITY.serializeSendRequests,
    relayEndpointEnabled: true,
    unsafeDemoFeaturesEnabled:
      RUNTIME_SAFETY.autoCompactRegistry ||
      RUNTIME_SAFETY.operatorCompactRegistry ||
      RUNTIME_SAFETY.writePlaintextNoteFile ||
      RUNTIME_SAFETY.allowPlaintextNoteFile,
  };

  try {
    const { rpcUrl, programId, configuredClusterOffset } =
      loadLowkieProgramRuntimeConfig();
    const connection = createAnchorConnection(rpcUrl);
    const wallet = senderWalletInfo.keypair
      ? senderWalletInfo.keypair
      : (resolveOptionalKeypairFromEnv("ANCHOR_WALLET")?.keypair ??
        Keypair.generate());
    const provider = createAnchorProvider(connection, wallet);
    const program = loadLowkieProgram(provider, programId);
    const clusterOffset = configuredClusterOffset ?? -1;
    const readiness = await inspectLowkieReadiness(
      provider,
      program,
      clusterOffset,
    );

    return {
      ...basePayload,
      programId: programId.toBase58(),
      clusterOffset,
      readiness,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...basePayload,
      ok: false,
      readiness: {
        ready: false,
        issues: [message],
      },
    };
  }
}

// ── Initialize Fastify ────────────────────────────────────────────────────────

const fastify = Fastify({
  trustProxy: SECURITY.trustProxyHeaders,
  bodyLimit: SECURITY.maxRequestBodyBytes,
});

fastify.register(cors, {
  origin: SECURITY.allowedOrigins.length > 0 ? SECURITY.allowedOrigins : true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["authorization", "content-type"],
});

// ── Public Routes ────────────────────────────────────────────────────────────

fastify.get("/api/health", async (request, reply) => {
  return await resolveHealthPayload();
});

fastify.get("/api/relayer/health", async (request, reply) => {
  const relayerWalletInfo = resolveRelayerWalletInfo();
  return {
    ok: REMOTE_RELAYER ? true : relayerWalletInfo.relayerWalletConfigured,
    network: NETWORK,
    rpc: RPC,
    relayerMode: REMOTE_RELAYER ? "remote" : "local",
    relayerRemoteUrl: REMOTE_RELAYER?.url,
    relayerWalletConfigured: relayerWalletInfo.relayerWalletConfigured,
    relayerWalletAddress: relayerWalletInfo.relayerWalletAddress,
    ...(relayerWalletInfo.relayerWalletError
      ? { relayerWalletError: relayerWalletInfo.relayerWalletError }
      : {}),
  };
});

fastify.get("/api/denominations", async (request, reply) => {
  const denominations = SUPPORTED_DENOMINATION_LAMPORTS.map((lamports) => {
    const sol = Number(lamports) / 1_000_000_000;
    return {
      lamports: lamports.toString(),
      display: `${lamports % 100_000_000n === 0n ? sol.toFixed(1) : sol.toFixed(2)} SOL`,
    };
  });
  return { denominations };
});

fastify.get("/api/pool/status", async (request, reply) => {
  try {
    const { rpcUrl, programId } = loadLowkieProgramRuntimeConfig();
    const connection = createAnchorConnection(rpcUrl);
    const wallet =
      resolveOptionalKeypairFromEnv("ANCHOR_WALLET")?.keypair ??
      Keypair.generate();
    const provider = createAnchorProvider(connection, wallet);
    const program = loadLowkieProgram(provider, programId);
    const issues: string[] = [];

    const pools = await Promise.all(
      SUPPORTED_DENOMINATION_LAMPORTS.map(async (denominationLamports) => {
        const sol = Number(denominationLamports) / 1_000_000_000;
        const display = `${denominationLamports % 100_000_000n === 0n ? sol.toFixed(1) : sol.toFixed(2)} SOL`;
        const address = derivePoolPda(programId, denominationLamports);
        let exists = false;
        let initialized = false;
        try {
          const pool = await (program.account as any).poolState.fetch(address);
          exists = true;
          initialized = Boolean(pool.isInitialized);
          if (!initialized) {
            issues.push(`${display} pool exists but is not initialized.`);
          }
        } catch {
          issues.push(`${display} pool PDA not found.`);
        }
        return {
          denominationLamports: denominationLamports.toString(),
          denominationDisplay: display,
          address: address.toBase58(),
          exists,
          initialized,
        };
      }),
    );

    return {
      programId: programId.toBase58(),
      network: NETWORK,
      pools,
      issues,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Pool status error:", redactErrorMessage(message));
    reply.status(500).send({ error: "Failed to fetch pool status" });
  }
});

// ── Protected Routes ─────────────────────────────────────────────────────────

fastify.register(async (instance) => {
  // Authorization & Rate Limit Hook
  instance.addHook("preHandler", async (request, reply) => {
    // 1. Auth Check
    const authHeader = request.headers.authorization;
    if (!isAuthorized(authHeader, SECURITY)) {
      reply.status(401).send({
        success: false,
        error: "Missing or invalid Authorization bearer token",
      });
      return reply;
    }

    // 2. Rate Limit
    const rateLimitResult = rateLimit(request.ip);
    if (!rateLimitResult.allowed) {
      reply.header("Retry-After", String(rateLimitResult.retryAfterSec));
      reply.status(429).send({
        success: false,
        error: "Rate limit exceeded",
        retryAfterSec: rateLimitResult.retryAfterSec,
      });
      return reply;
    }
  });

  instance.get("/api/recoverable", async (request, reply) => {
    try {
      const transfers = listRecoverableTransfers();
      return { success: true, transfers };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("List recoverable error:", redactErrorMessage(message));
      reply
        .status(500)
        .send({ success: false, error: "Internal server error" });
    }
  });

  instance.post("/api/send", async (request, reply) => {
    if (SECURITY.serializeSendRequests && sendInFlight) {
      reply.status(409).send({
        success: false,
        error:
          "Another transfer is already in progress. This backend serializes send requests to protect shared pool state.",
      });
      return;
    }

    try {
      sendInFlight = true;
      const parsed = request.body as {
        recipient?: string;
        amountSol?: number;
        delayMs?: number;
      };

      if (
        !parsed ||
        !parsed.recipient ||
        typeof parsed.amountSol !== "number"
      ) {
        reply
          .status(400)
          .send({ error: "recipient and amountSol are required" });
        return;
      }

      if (!Number.isFinite(parsed.amountSol) || parsed.amountSol <= 0) {
        reply
          .status(400)
          .send({ error: "amountSol must be a positive number" });
        return;
      }

      if (parsed.amountSol > SECURITY.maxAmountSol) {
        reply.status(400).send({
          error: `amountSol exceeds LOWKIE_MAX_AMOUNT_SOL (${SECURITY.maxAmountSol})`,
        });
        return;
      }

      const requestedDelayMs = parsed.delayMs ?? 15_000;
      if (!Number.isFinite(requestedDelayMs)) {
        reply.status(400).send({ error: "delayMs must be a finite number" });
        return;
      }

      if (
        requestedDelayMs < SECURITY.minDelayMs ||
        requestedDelayMs > SECURITY.maxDelayMs
      ) {
        reply.status(400).send({
          error: `delayMs must be between ${SECURITY.minDelayMs} and ${SECURITY.maxDelayMs}`,
        });
        return;
      }

      console.log(`\n━━━ API /api/send ━━━`);
      console.log(`  Recipient: ${redactValue(parsed.recipient)}`);
      console.log(`  Amount:    ${redactAmountSol(parsed.amountSol)}`);
      console.log(
        `  Notes:     Fixed denominations (${SUPPORTED_DENOMINATION_DISPLAY})`,
      );
      console.log(`  Delay:     ${requestedDelayMs}ms`);

      const result = await lowkieSend(
        parsed.recipient,
        parsed.amountSol,
        requestedDelayMs,
      );
      if (result.partialFailure) {
        reply.status(409).send({
          success: false,
          message: "Transfer partially completed",
          ...result,
        });
        return;
      }

      return { success: true, message: "Transfer complete", ...result };
    } catch (error) {
      if (error instanceof WithdrawalFailedError) {
        console.error(
          "Withdrawal failed (deposits succeeded):",
          redactErrorMessage(error.message),
        );
        reply.status(502).send({
          success: false,
          error:
            "Withdrawal failed after successful deposit(s). Funds can be recovered.",
          recoveryId: error.recoveryId,
          depositReceipts: error.depositReceipts,
        });
      } else if (error instanceof LowkieReadinessError) {
        console.error("Readiness error:", redactErrorMessage(error.message));
        reply.status(503).send({
          success: false,
          error: "Protocol is not ready. Check /api/health for details.",
          readiness: error.report,
        });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Send error:", redactErrorMessage(message));
        reply
          .status(500)
          .send({ success: false, error: "Internal server error" });
      }
    } finally {
      sendInFlight = false;
    }
  });

  instance.post("/api/build-deposits", async (request, reply) => {
    try {
      const parsed = request.body as {
        sender?: string;
        recipient?: string;
        amountSol?: number;
        delayMs?: number;
      };

      if (
        !parsed ||
        !parsed.sender ||
        !parsed.recipient ||
        typeof parsed.amountSol !== "number"
      ) {
        reply
          .status(400)
          .send({ error: "sender, recipient and amountSol are required" });
        return;
      }

      if (!Number.isFinite(parsed.amountSol) || parsed.amountSol <= 0) {
        reply
          .status(400)
          .send({ error: "amountSol must be a positive number" });
        return;
      }

      const requestedDelayMs = parsed.delayMs ?? 15_000;

      console.log(`\n━━━ API /api/build-deposits ━━━`);
      const result = await lowkieBuildDeposits(
        parsed.sender,
        parsed.recipient,
        parsed.amountSol,
        requestedDelayMs,
      );

      return { success: true, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Build deposits error:", redactErrorMessage(message));
      reply
        .status(500)
        .send({ success: false, error: "Failed to build deposits" });
    }
  });

  instance.post("/api/submit-deposits", async (request, reply) => {
    if (SECURITY.serializeSendRequests && sendInFlight) {
      reply.status(409).send({
        success: false,
        error: "Another transfer is already in progress.",
      });
      return;
    }

    try {
      sendInFlight = true;
      const parsed = request.body as {
        recoveryId?: string;
        signedTransactionsBase64?: string[];
      };

      if (
        !parsed ||
        !parsed.recoveryId ||
        !Array.isArray(parsed.signedTransactionsBase64)
      ) {
        reply.status(400).send({
          error: "recoveryId and signedTransactionsBase64 array are required",
        });
        return;
      }

      console.log(`\n━━━ API /api/submit-deposits ━━━`);
      const result = await lowkieSubmitDeposits(
        parsed.recoveryId,
        parsed.signedTransactionsBase64,
      );

      return { success: true, message: "Transfer complete", ...result };
    } catch (error) {
      if (error instanceof WithdrawalFailedError) {
        console.error(
          "Withdrawal failed (deposits succeeded):",
          redactErrorMessage(error.message),
        );
        reply.status(502).send({
          success: false,
          error: "Withdrawal failed after successful deposit(s).",
          detailedError: redactErrorMessage(error.message),
          recoveryId: error.recoveryId,
          depositReceipts: error.depositReceipts,
        });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Submit deposits error:", redactErrorMessage(message));
        reply
          .status(500)
          .send({ success: false, error: "Failed to submit deposits" });
      }
    } finally {
      sendInFlight = false;
    }
  });

  instance.post("/api/recover", async (request, reply) => {
    try {
      const parsed = request.body as {
        recoveryId?: string;
        mode?: "withdraw" | "refund";
      };

      if (
        !parsed ||
        !parsed.recoveryId ||
        typeof parsed.recoveryId !== "string"
      ) {
        reply
          .status(400)
          .send({ success: false, error: "recoveryId is required" });
        return;
      }

      if (!/^lowkie-[\w-]+$/.test(parsed.recoveryId)) {
        reply.status(400).send({ success: false, error: "Invalid recoveryId" });
        return;
      }

      const result =
        parsed.mode === "refund"
          ? await recoverRefund(parsed.recoveryId)
          : await recoverWithdrawal(parsed.recoveryId);

      reply
        .status(result.failed.length > 0 ? 207 : 200)
        .send({ success: result.failed.length === 0, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Recovery error:", redactErrorMessage(message));
      reply.status(500).send({ success: false, error: "Recovery failed" });
    }
  });

  instance.delete(
    "/api/recovery/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      try {
        const { id } = request.params;
        if (!/^lowkie-[\w-]+$/.test(id)) {
          reply
            .status(400)
            .send({ success: false, error: "Invalid recovery id" });
          return;
        }
        const file = loadRecoveryFile(id);
        if (!file) {
          reply.status(404).send({ success: false, error: "Not found" });
          return;
        }
        deleteRecoveryFile(id);
        reply.send({ success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Dismiss recovery error:", redactErrorMessage(message));
        reply
          .status(500)
          .send({ success: false, error: "Internal server error" });
      }
    },
  );

  instance.post("/api/relay", async (request, reply) => {
    if (SECURITY.serializeSendRequests && relayInFlight) {
      reply.status(409).send({
        success: false,
        error: "Another relay request is already in progress.",
      });
      return;
    }

    try {
      relayInFlight = true;
      const parsed = request.body as RelayRequest;
      const result = await executeRelayRequest(parsed);
      return { success: true, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Relay error:", redactErrorMessage(message));
      reply
        .status(500)
        .send({ success: false, error: "Relay execution failed" });
    } finally {
      relayInFlight = false;
    }
  });
});

// ── Start Server ──────────────────────────────────────────────────────────────

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`Server listening on http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
