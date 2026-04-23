import { timingSafeEqual } from "node:crypto";
import { parseBooleanEnv, EnvSource } from "../src/core/utils";

export interface ApiSecurityConfig {
  host: string;
  network: string;
  allowUnsafeLocalBridge: boolean;
  requireApiAuth: boolean;
  apiAuthToken?: string;
  allowedOrigins: string[];
  trustProxyHeaders: boolean;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  maxRequestBodyBytes: number;
  maxAmountSol: number;
  minDelayMs: number;
  maxDelayMs: number;
  serializeSendRequests: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
  resetAtMs: number;
}

function parseIntegerEnv(
  env: EnvSource,
  name: string,
  fallback: number,
): number {
  const value = env[name];
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parseNumberEnv(
  env: EnvSource,
  name: string,
  fallback: number,
): number {
  const value = env[name];
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return parsed;
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function parseAllowedOrigins(env: EnvSource): string[] {
  const raw = env.LOWKIE_ALLOWED_ORIGINS;
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map(normalizeOrigin);
}

export function resolveApiSecurityConfig({
  env = process.env,
  host,
  network,
}: {
  env?: EnvSource;
  host: string;
  network: string;
}): ApiSecurityConfig {
  const loopbackHost = isLoopbackHost(host);
  const allowUnsafeLocalBridge = parseBooleanEnv(
    env,
    "LOWKIE_ALLOW_UNSAFE_LOCAL_BRIDGE",
    loopbackHost,
  );
  const requireApiAuth = parseBooleanEnv(
    env,
    "LOWKIE_REQUIRE_API_AUTH",
    !loopbackHost,
  );
  const apiAuthToken = env.LOWKIE_API_AUTH_TOKEN?.trim() || undefined;
  const allowedOrigins = parseAllowedOrigins(env);
  const trustProxyHeaders = parseBooleanEnv(
    env,
    "LOWKIE_TRUST_PROXY_HEADERS",
    false,
  );
  const rateLimitWindowMs = parseIntegerEnv(
    env,
    "LOWKIE_API_RATE_LIMIT_WINDOW_MS",
    60_000,
  );
  const rateLimitMaxRequests = parseIntegerEnv(
    env,
    "LOWKIE_API_RATE_LIMIT_MAX_REQUESTS",
    10,
  );
  const maxRequestBodyBytes = parseIntegerEnv(
    env,
    "LOWKIE_MAX_REQUEST_BODY_BYTES",
    262_144,
  );
  const maxAmountSol = parseNumberEnv(env, "LOWKIE_MAX_AMOUNT_SOL", 100);
  const minDelayMs = parseIntegerEnv(env, "LOWKIE_MIN_DELAY_MS", 1_000);
  const maxDelayMs = parseIntegerEnv(env, "LOWKIE_MAX_DELAY_MS", 120_000);
  const serializeSendRequests = parseBooleanEnv(
    env,
    "LOWKIE_SERIALIZE_SEND_REQUESTS",
    true,
  );

  if (minDelayMs > maxDelayMs) {
    throw new Error(
      "LOWKIE_MIN_DELAY_MS must be less than or equal to LOWKIE_MAX_DELAY_MS.",
    );
  }

  if (allowUnsafeLocalBridge && !loopbackHost) {
    throw new Error(
      "LOWKIE_ALLOW_UNSAFE_LOCAL_BRIDGE is only valid for loopback hosts.",
    );
  }

  if (requireApiAuth && !apiAuthToken) {
    throw new Error(
      "LOWKIE_REQUIRE_API_AUTH=true requires LOWKIE_API_AUTH_TOKEN to be configured.",
    );
  }

  if (requireApiAuth && apiAuthToken) {
    assertApiAuthTokenIsProductionReady(apiAuthToken);
  }

  if (!requireApiAuth && (!loopbackHost || !allowUnsafeLocalBridge)) {
    throw new Error(
      "LOWKIE_REQUIRE_API_AUTH=false is only allowed when LOWKIE_ALLOW_UNSAFE_LOCAL_BRIDGE=true on a loopback host.",
    );
  }

  if (!loopbackHost && !requireApiAuth) {
    throw new Error(
      "Public backend deployments require LOWKIE_REQUIRE_API_AUTH=true.",
    );
  }

  if (!loopbackHost && allowedOrigins.length === 0) {
    throw new Error(
      "Public backend deployments require LOWKIE_ALLOWED_ORIGINS to be configured.",
    );
  }

  return {
    host,
    network,
    allowUnsafeLocalBridge,
    requireApiAuth,
    apiAuthToken,
    allowedOrigins,
    trustProxyHeaders,
    rateLimitWindowMs,
    rateLimitMaxRequests,
    maxRequestBodyBytes,
    maxAmountSol,
    minDelayMs,
    maxDelayMs,
    serializeSendRequests,
  };
}

export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) {
    return true;
  }

  if (allowedOrigins.length === 0) {
    return true;
  }

  return allowedOrigins.includes(normalizeOrigin(origin));
}

export function buildCorsHeaders(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };

  if (allowedOrigins.length === 0) {
    return headers;
  }

  if (origin && isOriginAllowed(origin, allowedOrigins)) {
    headers["Access-Control-Allow-Origin"] = normalizeOrigin(origin);
    headers.Vary = "Origin";
  }

  return headers;
}

function extractBearerToken(
  authorizationHeader: string | undefined,
): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }

  const parts = authorizationHeader.trim().split(/\s+/, 2);
  if (parts.length !== 2) {
    return undefined;
  }

  const [scheme, token] = parts;
  if (scheme.toLowerCase() !== "bearer" || token.length === 0) {
    return undefined;
  }

  return token;
}

function assertApiAuthTokenIsProductionReady(apiAuthToken: string): void {
  const normalized = apiAuthToken.trim().toLowerCase();
  if (
    normalized === "replace-me" ||
    normalized === "changeme" ||
    normalized === "change-me" ||
    normalized === "secret-token"
  ) {
    throw new Error(
      "LOWKIE_API_AUTH_TOKEN must be replaced with a production secret before startup.",
    );
  }

  if (apiAuthToken.length < 16) {
    throw new Error(
      "LOWKIE_API_AUTH_TOKEN must be at least 16 characters for public deployments.",
    );
  }
}

function compareBearerToken(
  providedToken: string | undefined,
  expectedToken: string | undefined,
): boolean {
  if (!providedToken || !expectedToken) {
    return false;
  }

  const provided = Buffer.from(providedToken, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}

export function isAuthorized(
  authorizationHeader: string | undefined,
  config: ApiSecurityConfig,
): boolean {
  if (!config.requireApiAuth) {
    return true;
  }

  return compareBearerToken(
    extractBearerToken(authorizationHeader),
    config.apiAuthToken,
  );
}

export function createFixedWindowRateLimiter(config: {
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
}) {
  const hits = new Map<string, { count: number; resetAtMs: number }>();
  let callsSinceLastPrune = 0;

  return (key: string, nowMs = Date.now()): RateLimitResult => {
    // Lazily prune expired entries to prevent unbounded memory growth
    callsSinceLastPrune += 1;
    if (callsSinceLastPrune >= 100) {
      callsSinceLastPrune = 0;
      for (const [k, v] of hits) {
        if (nowMs >= v.resetAtMs) hits.delete(k);
      }
    }

    const current = hits.get(key);
    if (!current || nowMs >= current.resetAtMs) {
      const next = {
        count: 1,
        resetAtMs: nowMs + config.rateLimitWindowMs,
      };
      hits.set(key, next);
      return {
        allowed: true,
        remaining: config.rateLimitMaxRequests - 1,
        retryAfterSec: Math.ceil(config.rateLimitWindowMs / 1000),
        resetAtMs: next.resetAtMs,
      };
    }

    current.count += 1;
    const remaining = Math.max(0, config.rateLimitMaxRequests - current.count);
    const allowed = current.count <= config.rateLimitMaxRequests;

    return {
      allowed,
      remaining,
      retryAfterSec: Math.max(1, Math.ceil((current.resetAtMs - nowMs) / 1000)),
      resetAtMs: current.resetAtMs,
    };
  };
}
