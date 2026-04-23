import { RelayRequest, RelayResult } from "./relayProtocol";

export interface RemoteRelayerConfig {
  url: string;
  authToken?: string;
  timeoutMs: number;
}

export class RemoteRelayerError extends Error {
  readonly status: number;
  readonly responseBody: unknown;

  constructor(message: string, status: number, responseBody: unknown) {
    super(message);
    this.name = "RemoteRelayerError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function resolveRemoteRelayerConfig(
  env: NodeJS.ProcessEnv = process.env,
): RemoteRelayerConfig | null {
  const configuredUrl = env.LOWKIE_RELAYER_URL?.trim();
  if (!configuredUrl) {
    return null;
  }

  const timeoutMs = Number.parseInt(
    env.LOWKIE_RELAYER_TIMEOUT_MS ?? "30000",
    10,
  );
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("LOWKIE_RELAYER_TIMEOUT_MS must be a positive integer.");
  }

  return {
    url: normalizeBaseUrl(configuredUrl),
    authToken: env.LOWKIE_RELAYER_AUTH_TOKEN?.trim() || undefined,
    timeoutMs,
  };
}

function isRelayResult(value: unknown): value is RelayResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RelayResult>;
  return (
    typeof candidate.initialDelayMs === "number" &&
    Array.isArray(candidate.compactedDenominations) &&
    Array.isArray(candidate.withdrawals) &&
    typeof candidate.recipientBalanceBeforeLamports === "string" &&
    typeof candidate.recipientBalanceAfterLamports === "string" &&
    typeof candidate.totalReceivedLamports === "string"
  );
}

export async function submitRelayRequest(
  request: RelayRequest,
  config: RemoteRelayerConfig | null = resolveRemoteRelayerConfig(),
): Promise<RelayResult> {
  if (!config) {
    throw new Error(
      "LOWKIE_RELAYER_URL is not configured. Remote relayer execution is unavailable.",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.url}/api/relay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.authToken
          ? { authorization: `Bearer ${config.authToken}` }
          : {}),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    const rawText = await response.text();
    const payload = rawText.length > 0 ? JSON.parse(rawText) : null;

    if (!response.ok) {
      const message =
        payload && typeof payload.error === "string"
          ? payload.error
          : `Remote relayer returned HTTP ${response.status}.`;
      throw new RemoteRelayerError(message, response.status, payload);
    }

    const result =
      payload && typeof payload === "object" && "success" in payload
        ? (payload as { success?: boolean } & RelayResult)
        : payload;
    if (!isRelayResult(result)) {
      throw new Error("Remote relayer returned an invalid response payload.");
    }

    return result;
  } catch (error) {
    if (error instanceof RemoteRelayerError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Remote relayer request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}