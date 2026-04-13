/**
 * Lowkie — Frontend Server
 *
 * Serves the frontend UI and exposes API endpoints for the demo:
 *   GET  /api/health  — Check backend status + cluster info
 *   POST /api/send    — Execute a full deposit + relayed withdrawal
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ARCIUM_CLUSTER_OFFSET=456 \
 *   LOWKIE_PROGRAM_ID=6Jub3sVovG5EjKCs6bUVjX6buLKLBDZ5L6zNt659xmLH \
 *   npx ts-node scripts/frontend-server.ts
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import dotenv from "dotenv";
import { lowkieSend } from "../client/send";
import { loadLowkieRpcRuntimeConfig } from "../client/programContext";
import {
  redactAmountSol,
  redactErrorMessage,
  redactValue,
} from "../client/privacyLogging";
import {
  buildCorsHeaders,
  createFixedWindowRateLimiter,
  isAuthorized,
  isOriginAllowed,
  resolveFrontendBridgeSecurityConfig,
} from "./frontendBridgeSecurity";

dotenv.config();

const HOST = process.env.FRONTEND_HOST ?? "127.0.0.1";
const PORT = Number(process.env.FRONTEND_PORT ?? "5174");
const WEB_ROOT = path.resolve("frontend");
const { rpcUrl: RPC, network: NETWORK, runtimeSafety: RUNTIME_SAFETY } =
  loadLowkieRpcRuntimeConfig();
const SECURITY = resolveFrontendBridgeSecurityConfig({
  env: process.env,
  host: HOST,
  network: NETWORK,
});
const rateLimit = createFixedWindowRateLimiter(SECURITY);

let sendInFlight = false;

function json(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  const origin =
    typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...buildCorsHeaders(origin, SECURITY.allowedOrigins),
  });
  res.end(JSON.stringify(payload));
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  const ext = path.extname(filePath);
  const type =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "application/javascript; charset=utf-8"
          : ext === ".svg"
            ? "image/svg+xml"
            : "text/plain; charset=utf-8";

  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(filePath).pipe(res);
}

async function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new Error(
        `Request body exceeds LOWKIE_MAX_REQUEST_BODY_BYTES (${maxBytes} bytes).`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function getClientKey(req: http.IncomingMessage): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.socket.remoteAddress ?? "unknown";
}

function requestOrigin(req: http.IncomingMessage): string | undefined {
  return typeof req.headers.origin === "string"
    ? req.headers.origin
    : undefined;
}

function validateRequestOrigin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const origin = requestOrigin(req);
  if (!isOriginAllowed(origin, SECURITY.allowedOrigins)) {
    json(req, res, 403, { error: "Origin not allowed" });
    return false;
  }

  return true;
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    json(req, res, 400, { error: "Bad request" });
    return;
  }

  if (!validateRequestOrigin(req, res)) {
    return;
  }

  if (req.method === "OPTIONS") {
    json(req, res, 200, { ok: true });
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // ── Health endpoint ────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/health") {
    const programId = process.env.LOWKIE_PROGRAM_ID ?? "unset";
    const cluster = process.env.ARCIUM_CLUSTER_OFFSET ?? "unset";

    json(req, res, 200, {
      ok: true,
      rpc: RPC,
      programId,
      clusterOffset: cluster,
      network: NETWORK,
      senderWalletConfigured: Boolean(process.env.ANCHOR_WALLET),
      relayerWalletConfigured: Boolean(process.env.RELAYER_KEYPAIR_PATH),
      authRequired: SECURITY.requireApiAuth,
      rateLimitWindowMs: SECURITY.rateLimitWindowMs,
      rateLimitMaxRequests: SECURITY.rateLimitMaxRequests,
      serializeSendRequests: SECURITY.serializeSendRequests,
      unsafeDemoFeaturesEnabled:
        RUNTIME_SAFETY.autoCompactRegistry ||
        RUNTIME_SAFETY.writePlaintextNoteFile ||
        RUNTIME_SAFETY.allowPlaintextNoteFile,
    });
    return;
  }

  // ── Send endpoint (deposit + relayed withdrawal) ───────────────────────
  if (
    req.method === "POST" &&
    (url.pathname === "/api/send" || url.pathname === "/api/deposit")
  ) {
    if (!isAuthorized(req.headers.authorization, SECURITY)) {
      json(req, res, 401, {
        success: false,
        error: "Missing or invalid Authorization bearer token",
      });
      return;
    }

    const rateLimitResult = rateLimit(getClientKey(req));
    if (!rateLimitResult.allowed) {
      res.setHeader("Retry-After", String(rateLimitResult.retryAfterSec));
      json(req, res, 429, {
        success: false,
        error: "Rate limit exceeded",
        retryAfterSec: rateLimitResult.retryAfterSec,
      });
      return;
    }

    if (SECURITY.serializeSendRequests && sendInFlight) {
      json(req, res, 409, {
        success: false,
        error:
          "Another transfer is already in progress. This bridge serializes send requests to protect shared pool state.",
      });
      return;
    }

    try {
      sendInFlight = true;
      const body = await readBody(req, SECURITY.maxRequestBodyBytes);
      const parsed = JSON.parse(body) as {
        recipient?: string;
        amountSol?: number;
        splits?: number;
        delayMs?: number;
      };

      if (!parsed.recipient || typeof parsed.amountSol !== "number") {
        json(req, res, 400, { error: "recipient and amountSol are required" });
        return;
      }

      if (!Number.isFinite(parsed.amountSol) || parsed.amountSol <= 0) {
        json(req, res, 400, { error: "amountSol must be a positive number" });
        return;
      }

      if (parsed.amountSol > SECURITY.maxAmountSol) {
        json(req, res, 400, {
          error: `amountSol exceeds LOWKIE_MAX_AMOUNT_SOL (${SECURITY.maxAmountSol})`,
        });
        return;
      }

      const requestedDelayMs = parsed.delayMs ?? 15000;
      if (!Number.isFinite(requestedDelayMs)) {
        json(req, res, 400, { error: "delayMs must be a finite number" });
        return;
      }

      if (
        requestedDelayMs < SECURITY.minDelayMs ||
        requestedDelayMs > SECURITY.maxDelayMs
      ) {
        json(req, res, 400, {
          error: `delayMs must be between ${SECURITY.minDelayMs} and ${SECURITY.maxDelayMs}`,
        });
        return;
      }

      console.log(`\n━━━ API /api/send ━━━`);
      console.log(`  Recipient: ${redactValue(parsed.recipient)}`);
      console.log(`  Amount:    ${redactAmountSol(parsed.amountSol)}`);
      console.log(`  Notes:     Fixed denominations (1.0 / 0.1 / 0.01 SOL)`);
      console.log(`  Delay:     ${requestedDelayMs}ms`);

      const result = await lowkieSend(
        parsed.recipient,
        parsed.amountSol,
        requestedDelayMs,
      );
      json(req, res, 200, {
        success: true,
        message: "Transfer complete",
        ...result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Send error:", redactErrorMessage(message));
      json(req, res, 500, { success: false, error: String(error) });
    } finally {
      sendInFlight = false;
    }
    return;
  }

  // ── Static file serving ────────────────────────────────────────────────
  if (req.method === "GET") {
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.resolve(WEB_ROOT, `.${rel}`);
    if (!filePath.startsWith(WEB_ROOT)) {
      json(req, res, 403, { error: "Forbidden" });
      return;
    }
    serveFile(res, filePath);
    return;
  }

  json(req, res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`\n🔒 Lowkie Frontend Server`);
  console.log(`   URL:      http://${HOST}:${PORT}`);
  console.log(`   Network:  ${NETWORK}`);
  console.log(`   RPC:      ${RPC}`);
  console.log(`   Program:  ${process.env.LOWKIE_PROGRAM_ID ?? "unset"}`);
  console.log(
    `   Auth:     ${SECURITY.requireApiAuth ? "required" : "disabled"}`,
  );
  console.log(
    `   Rate:     ${SECURITY.rateLimitMaxRequests} req / ${SECURITY.rateLimitWindowMs}ms per client`,
  );
  console.log(
    `   Sends:    ${SECURITY.serializeSendRequests ? "serialized" : "concurrent"}`,
  );
  if (SECURITY.allowedOrigins.length > 0) {
    console.log(`   Origins:  ${SECURITY.allowedOrigins.join(", ")}`);
  }
  console.log(`\n   Endpoints:`);
  console.log(`   GET  /api/health  — Backend status`);
  console.log(`   POST /api/send    — Execute deposit + withdrawal`);
  console.log(`\n   Ready.`);
});
