// ── Denominations ────────────────────────────────────────────────────────────

/** Supported fixed pool denominations, in lamports. */
export const SUPPORTED_DENOMINATIONS = [
  { lamports: "10000000000", display: "10.0 SOL" },
  { lamports: "5000000000", display: "5.0 SOL" },
  { lamports: "2000000000", display: "2.0 SOL" },
  { lamports: "1000000000", display: "1.0 SOL" },
  { lamports: "500000000", display: "0.5 SOL" },
  { lamports: "100000000", display: "0.1 SOL" },
  { lamports: "50000000", display: "0.05 SOL" },
  { lamports: "10000000", display: "0.01 SOL" },
] as const;

// ── API Envelope Types ───────────────────────────────────────────────────────

export interface ApiSuccessEnvelope {
  success: true;
  message?: string;
}

export interface ApiErrorEnvelope {
  success: false;
  error: string;
}

// ── Health ────────────────────────────────────────────────────────────────────

export interface LowkieHealthResponse {
  ok: boolean;
  rpc: string;
  programId: string;
  clusterOffset: number | string;
  network: string;
  senderWalletConfigured: boolean;
  senderWalletAddress: string | null;
  senderWalletSource: string;
  relayerMode: "local" | "remote";
  relayerRemoteUrl?: string;
  relayerExecutionConfigured: boolean;
  relayerWalletConfigured: boolean;
  relayerWalletAddress?: string | null;
  readiness?: unknown;
}

export interface RelayerHealthResponse {
  ok: boolean;
  network: string;
  rpc: string;
  relayerMode: "local" | "remote";
  relayerRemoteUrl?: string;
  relayerWalletConfigured: boolean;
  relayerWalletAddress?: string | null;
}

// ── Denominations ────────────────────────────────────────────────────────────

export interface DenominationInfo {
  lamports: string;
  display: string;
}

export interface DenominationsResponse {
  denominations: DenominationInfo[];
}

// ── Pool Status ──────────────────────────────────────────────────────────────

export interface PoolStatusEntry {
  denominationLamports: string;
  denominationDisplay: string;
  address: string;
  exists: boolean;
  initialized: boolean;
}

export interface PoolStatusResponse {
  programId: string;
  network: string;
  pools: PoolStatusEntry[];
  issues: string[];
}

// ── Send Transfer ────────────────────────────────────────────────────────────

export interface SendTransferRequest {
  recipient: string;
  amountSol: number;
  delayMs?: number;
}

export interface SendTransferResponse extends ApiSuccessEnvelope {
  recipient: string;
  totalLamports: string;
  delayMs: number;
  clusterOffset: number;
  partialFailure?: string;
  recoveryId?: string;
  depositReceipts: Array<{
    noteHashHex: string;
    notePda: string;
    denominationLamports: string;
    depositSig: string;
  }>;
  initialDelayMs: number;
  compactedDenominations: string[];
  withdrawals: Array<{
    noteHashHex: string;
    denominationLamports: string;
    withdrawSig: string;
    compactSig: string;
  }>;
  recipientBalanceBeforeLamports: string;
  recipientBalanceAfterLamports: string;
  totalReceivedLamports: string;
}

// ── Dynamic Send (Client-Side Signing) ──────────────────────────────────────

export interface BuildDepositsRequest {
  sender: string;
  recipient: string;
  amountSol: number;
  delayMs?: number;
}

export interface BuildDepositsResponse extends ApiSuccessEnvelope {
  recoveryId: string;
  transactionsBase64: string[];
}

export interface SubmitDepositsRequest {
  recoveryId: string;
  signedTransactionsBase64: string[];
}

export interface SubmitDepositsResponse extends SendTransferResponse {}

// ── Recovery ─────────────────────────────────────────────────────────────────

export interface RecoverableTransfer {
  id: string;
  createdAt: string;
  recipient: string;
  totalLamports: string;
  noteCount: number;
}

export interface RecoverRequest {
  recoveryId: string;
  mode?: "withdraw" | "refund";
}

export interface RecoverResponse extends ApiSuccessEnvelope {
  recoveryId: string;
  action: "withdraw" | "refund";
  succeeded: string[];
  failed: Array<{ noteHash: string; error: string }>;
  cleaned: boolean;
}

// ── Relay ─────────────────────────────────────────────────────────────────────

export interface RelayRequest {
  sender?: string;
  recipient: string;
  totalLamports: string;
  delayMs: number;
  clusterOffset: number;
  programId?: string;
  rpcUrl?: string;
  subNotes: Array<{
    noteSecret: number[];
    withdrawKey: number[];
    noteHash: number[];
    denominationLamports: string;
    amountLamports: string;
  }>;
}

export interface RelayResponse extends ApiSuccessEnvelope {
  initialDelayMs: number;
  compactedDenominations: string[];
  withdrawals: Array<{
    noteHashHex: string;
    denominationLamports: string;
    withdrawSig: string;
    compactSig: string;
  }>;
  recipientBalanceBeforeLamports: string;
  recipientBalanceAfterLamports: string;
  totalReceivedLamports: string;
}

// ── SDK Client ───────────────────────────────────────────────────────────────

export interface LowkieSdkOptions {
  baseUrl: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

export class LowkieApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "LowkieApiError";
    this.status = status;
    this.payload = payload;
  }
}

export class LowkieSdkClient {
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LowkieSdkOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(this.authToken
          ? { authorization: `Bearer ${this.authToken}` }
          : {}),
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });

    const text = await response.text();
    const payload = text.length > 0 ? JSON.parse(text) : null;
    if (!response.ok) {
      const message =
        payload && typeof payload.error === "string"
          ? payload.error
          : `Request failed with HTTP ${response.status}`;
      throw new LowkieApiError(message, response.status, payload);
    }

    return payload as T;
  }

  // ── Health ───────────────────────────────────────────────────────────────

  health(): Promise<LowkieHealthResponse> {
    return this.request<LowkieHealthResponse>("/api/health");
  }

  relayerHealth(): Promise<RelayerHealthResponse> {
    return this.request<RelayerHealthResponse>("/api/relayer/health");
  }

  // ── Pool Info ────────────────────────────────────────────────────────────

  denominations(): Promise<DenominationsResponse> {
    return this.request<DenominationsResponse>("/api/denominations");
  }

  poolStatus(): Promise<PoolStatusResponse> {
    return this.request<PoolStatusResponse>("/api/pool/status");
  }

  // ── Transfers ────────────────────────────────────────────────────────────

  sendTransfer(request: SendTransferRequest): Promise<SendTransferResponse> {
    return this.request<SendTransferResponse>("/api/send", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  // ── Dynamic Transfers (Client-Side Signing) ───────────────────────────────

  buildDeposits(request: BuildDepositsRequest): Promise<BuildDepositsResponse> {
    return this.request<BuildDepositsResponse>("/api/build-deposits", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  submitDeposits(
    request: SubmitDepositsRequest,
  ): Promise<SubmitDepositsResponse> {
    return this.request<SubmitDepositsResponse>("/api/submit-deposits", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  // ── Recovery ─────────────────────────────────────────────────────────────

  listRecoverable(
    walletAddress?: string,
  ): Promise<ApiSuccessEnvelope & { transfers: RecoverableTransfer[] }> {
    const params = walletAddress
      ? `?wallet=${encodeURIComponent(walletAddress)}`
      : "";
    return this.request<
      ApiSuccessEnvelope & {
        transfers: RecoverableTransfer[];
      }
    >(`/api/recoverable${params}`);
  }

  recover(request: RecoverRequest): Promise<RecoverResponse> {
    return this.request<RecoverResponse>("/api/recover", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  dismissRecovery(id: string): Promise<ApiSuccessEnvelope> {
    return this.request<ApiSuccessEnvelope>(
      `/api/recovery/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
      },
    );
  }

  // ── Relay ────────────────────────────────────────────────────────────────

  relay(request: RelayRequest): Promise<RelayResponse> {
    return this.request<RelayResponse>("/api/relay", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }
}

// ── Convenience Factory ──────────────────────────────────────────────────────

/**
 * Create a Lowkie SDK client with minimal config.
 *
 * @example
 * ```ts
 * const client = createLowkieClient("http://localhost:5174");
 * const health = await client.health();
 * ```
 */
export function createLowkieClient(
  baseUrl: string,
  authToken?: string,
): LowkieSdkClient {
  return new LowkieSdkClient({ baseUrl, authToken });
}
