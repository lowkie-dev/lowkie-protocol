/**
 * Lowkie Test Dashboard — Frontend JavaScript
 *
 * Inline SDK client (browser-compatible) that exercises all backend API endpoints.
 * This mirrors the LowkieSdkClient from @lowkie/sdk for browser use.
 */

// ── API Base URL ─────────────────────────────────────────────────────────────

const API_BASE =
  typeof window.LOWKIE_API_BASE === "string" && window.LOWKIE_API_BASE
    ? window.LOWKIE_API_BASE.replace(/\/+$/, "")
    : "";

// ── Inline SDK Client ────────────────────────────────────────────────────────

class LowkieClient {
  constructor(baseUrl, authToken) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authToken = authToken || null;
  }

  async request(path, init) {
    const headers = {};
    const authTokenInput = document.getElementById("input-auth-token");
    const currentToken = authTokenInput
      ? authTokenInput.value.trim()
      : this.authToken;
    if (currentToken) headers["authorization"] = `Bearer ${currentToken}`;
    if (init && init.body) headers["content-type"] = "application/json";

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers || {}) },
    });

    const text = await response.text();
    const payload = text.length > 0 ? JSON.parse(text) : null;

    if (!response.ok) {
      const message = payload?.error || `HTTP ${response.status}`;
      const err = new Error(message);
      err.status = response.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  health() {
    return this.request("/api/health");
  }
  relayerHealth() {
    return this.request("/api/relayer/health");
  }
  denominations() {
    return this.request("/api/denominations");
  }
  poolStatus() {
    return this.request("/api/pool/status");
  }

  sendTransfer(req) {
    return this.request("/api/send", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  buildDeposits(req) {
    return this.request("/api/build-deposits", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  submitDeposits(req) {
    return this.request("/api/submit-deposits", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  listRecoverable() {
    return this.request("/api/recoverable");
  }

  recover(req) {
    return this.request("/api/recover", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }
}

// ── State ────────────────────────────────────────────────────────────────────

const client = new LowkieClient(API_BASE || window.location.origin);
let logLines = [];

const TEST_SENDER_STORAGE_KEY = "lowkie.testSenderSecretKey";

function loadPersistedTestSenderWallet() {
  try {
    const raw = window.localStorage.getItem(TEST_SENDER_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(parsed));
      }
    }
  } catch (err) {
    console.warn("Failed to load persisted test sender wallet:", err);
  }

  const generated = solanaWeb3.Keypair.generate();

  try {
    window.localStorage.setItem(
      TEST_SENDER_STORAGE_KEY,
      JSON.stringify(Array.from(generated.secretKey)),
    );
  } catch (err) {
    console.warn("Failed to persist generated test sender wallet:", err);
  }

  return generated;
}

// Persist the browser-side sender so funded test wallets survive refreshes.
const testSenderWallet = loadPersistedTestSenderWallet();
document.addEventListener("DOMContentLoaded", () => {
  const senderInput = document.getElementById("input-sender");
  if (senderInput) senderInput.value = testSenderWallet.publicKey.toBase58();
});

// ── DOM Helpers ──────────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/** Escape HTML entities to prevent XSS when inserting API data into innerHTML. */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

function appendLog(label, data) {
  const timestamp = new Date().toLocaleTimeString();
  const entry = `[${timestamp}] ${label}\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`;
  logLines.push(entry);
  if (logLines.length > 50) logLines = logLines.slice(-50);
  $("#log-output").textContent = logLines.join("\n\n");
  $("#log-output").scrollTop = $("#log-output").scrollHeight;
}

function setStatus(state, text) {
  const dot = $("#status-dot");
  const textEl = $("#status-text");
  dot.className = `status-dot ${state}`;
  textEl.textContent = text;
}

function showResult(el, type, content) {
  el.className = `result-box ${type}`;
  el.textContent =
    typeof content === "string" ? content : JSON.stringify(content, null, 2);
  el.classList.remove("hidden");
}

// ── Health Check ─────────────────────────────────────────────────────────────

async function refreshHealth() {
  setStatus("loading", "Checking...");
  const body = $("#health-body");

  try {
    const data = await client.health();
    appendLog("GET /api/health", data);

    const rows = [
      [
        "Status",
        data.ok ? "Online" : "Issues detected",
        data.ok ? "ok" : "warn",
      ],
      ["Network", data.network, ""],
      ["Program", data.programId, ""],
      ["Cluster", String(data.clusterOffset), ""],
      [
        "Sender",
        data.senderWalletConfigured
          ? data.senderWalletAddress || "configured"
          : "not configured",
        data.senderWalletConfigured ? "ok" : "error",
      ],
      [
        "Relayer",
        data.relayerMode === "remote"
          ? `remote`
          : data.relayerWalletConfigured
            ? "local"
            : "not configured",
        data.relayerExecutionConfigured ? "ok" : "error",
      ],
      ["Auth", data.authRequired ? "Required" : "Disabled", ""],
    ];

    body.innerHTML = `<div class="kv-grid">${rows
      .map(
        ([label, value, cls]) =>
          `<div class="kv-row"><span class="kv-label">${escapeHtml(label)}</span><span class="kv-value ${escapeHtml(cls)}">${escapeHtml(value)}</span></div>`,
      )
      .join("")}</div>`;

    setStatus(
      data.ok ? "ok" : "error",
      data.ok ? `Connected · ${data.network}` : "Issues detected",
    );
    $("#footer-network").textContent = `Network: ${data.network}`;
  } catch (err) {
    body.innerHTML = `<div class="placeholder-text" style="color: var(--accent-red);">Failed: ${escapeHtml(err.message)}</div>`;
    setStatus("error", "Connection failed");
    appendLog("GET /api/health — ERROR", err.message);
  }
}

// ── Pool Status ──────────────────────────────────────────────────────────────

async function refreshPools() {
  const body = $("#pools-body");
  body.innerHTML = `<div class="placeholder-text">Loading...</div>`;

  try {
    const data = await client.poolStatus();
    appendLog("GET /api/pool/status", data);

    if (!data.pools || data.pools.length === 0) {
      body.innerHTML = `<div class="placeholder-text">No pools found</div>`;
      return;
    }

    body.innerHTML = `<div class="pool-list">${data.pools
      .map((pool) => {
        const dotClass = pool.initialized
          ? "init"
          : pool.exists
            ? "uninit"
            : "missing";
        return `<div class="pool-chip" title="${escapeHtml(pool.address)}"><span class="dot ${dotClass}"></span>${escapeHtml(pool.denominationDisplay)}</div>`;
      })
      .join("")}</div>`;
  } catch (err) {
    // Fallback to /api/denominations
    try {
      const dData = await client.denominations();
      appendLog("GET /api/denominations (fallback)", dData);
      body.innerHTML = `<div class="pool-list">${dData.denominations
        .map(
          (d) =>
            `<div class="pool-chip"><span class="dot missing"></span>${escapeHtml(d.display)}</div>`,
        )
        .join("")}</div>`;
    } catch (err2) {
      body.innerHTML = `<div class="placeholder-text" style="color: var(--accent-red);">Failed: ${escapeHtml(err.message)}</div>`;
      appendLog("GET /api/pool/status — ERROR", err.message);
    }
  }
}

// ── Send Transfer ────────────────────────────────────────────────────────────

async function handleSend(e) {
  e.preventDefault();

  const btn = $("#btn-send");
  const resultEl = $("#send-result");
  resultEl.classList.add("hidden");

  const sender = testSenderWallet.publicKey.toBase58();
  const recipient = $("#input-recipient").value.trim();
  const amountSol = parseFloat($("#input-amount").value);
  const delayMs = parseInt($("#input-delay").value) || 15000;

  if (!recipient || isNaN(amountSol) || amountSol <= 0) {
    showResult(resultEl, "error", "Please enter a valid recipient and amount.");
    return;
  }

  btn.classList.add("loading");
  btn.disabled = true;

  try {
    // 1. Build Deposits
    appendLog("POST /api/build-deposits", {
      sender,
      recipient,
      amountSol,
      delayMs,
    });
    const buildData = await client.buildDeposits({
      sender,
      recipient,
      amountSol,
      delayMs,
    });
    appendLog("POST /api/build-deposits — RESPONSE", buildData);

    // 2. Sign Transactions
    appendLog(
      "FRONTEND SIGNING",
      `Simulating non-custodial wallet signature for ${buildData.transactionsBase64.length} transactions...`,
    );
    const signedTransactionsBase64 = buildData.transactionsBase64.map(
      (txB64) => {
        const txBuffer = Uint8Array.from(atob(txB64), (c) => c.charCodeAt(0));
        const tx = solanaWeb3.VersionedTransaction.deserialize(txBuffer);
        tx.sign([testSenderWallet]);
        return btoa(String.fromCharCode.apply(null, tx.serialize()));
      },
    );

    // 3. Submit Deposits
    appendLog("POST /api/submit-deposits", {
      recoveryId: buildData.recoveryId,
      signedTransactionsBase64,
    });
    const data = await client.submitDeposits({
      recoveryId: buildData.recoveryId,
      signedTransactionsBase64,
    });
    appendLog("POST /api/submit-deposits — RESPONSE", data);

    const summary = [
      `✅ Transfer Complete`,
      `Recipient: ${data.recipient}`,
      `Total: ${data.totalLamports} lamports`,
      `Deposits: ${data.depositReceipts?.length || 0}`,
      `Withdrawals: ${data.withdrawals?.length || 0}`,
      data.partialFailure ? `⚠️ Partial: ${data.partialFailure}` : null,
      data.recoveryId ? `Recovery ID: ${data.recoveryId}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    showResult(resultEl, "success", summary);
  } catch (err) {
    appendLog("SEND FLOW — ERROR", err.payload || err.message);
    const msg = err.payload?.error || err.message;
    showResult(resultEl, "error", `❌ ${msg}`);
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}

// ── Recovery ─────────────────────────────────────────────────────────────────

async function listRecoverable() {
  const listEl = $("#recoverable-list");
  const actionsEl = $("#recovery-actions");

  try {
    const data = await client.listRecoverable();
    appendLog("GET /api/recoverable", data);

    if (!data.transfers || data.transfers.length === 0) {
      listEl.innerHTML = `<div class="placeholder-text">No recoverable transfers found ✓</div>`;
      actionsEl.style.display = "none";
      return;
    }

    listEl.innerHTML = data.transfers
      .map((t) => {
        const safeId = escapeHtml(t.id);
        return (
          `<div class="recoverable-item" data-id="${safeId}">` +
          `<span class="ri-id">${safeId}</span>` +
          `<span class="ri-meta">${escapeHtml(t.noteCount)} note(s) · ${(Number(t.totalLamports) / 1e9).toFixed(2)} SOL</span>` +
          `</div>`
        );
      })
      .join("");

    // Attach click handlers safely (avoids inline onclick XSS)
    listEl.querySelectorAll(".recoverable-item").forEach((el) => {
      el.addEventListener("click", () => selectRecovery(el.dataset.id));
    });

    actionsEl.style.display = "";
  } catch (err) {
    appendLog("GET /api/recoverable — ERROR", err.message);
    listEl.innerHTML = `<div class="placeholder-text" style="color: var(--accent-red);">Failed: ${escapeHtml(err.message)}</div>`;
  }
}

function selectRecovery(id) {
  $("#input-recovery-id").value = id;
  $$(".recoverable-item").forEach((el) => {
    el.style.borderColor = el.dataset.id === id ? "var(--accent-violet)" : "";
  });
}

async function executeRecovery(mode) {
  const recoveryId = $("#input-recovery-id").value.trim();
  const resultEl = $("#recovery-result");
  resultEl.classList.add("hidden");

  if (!recoveryId) {
    showResult(resultEl, "error", "Enter or select a recovery ID.");
    return;
  }

  try {
    appendLog(`POST /api/recover (${mode})`, { recoveryId, mode });
    const data = await client.recover({ recoveryId, mode });
    appendLog(`POST /api/recover — RESPONSE`, data);

    const summary = [
      `${data.cleaned ? "✅" : "⚠️"} Recovery ${mode}: ${data.succeeded?.length || 0} succeeded, ${data.failed?.length || 0} failed`,
      data.cleaned
        ? "Recovery file cleaned up."
        : "Some notes still need attention.",
    ].join("\n");

    showResult(resultEl, data.failed?.length ? "error" : "success", summary);
    // Refresh the list
    listRecoverable();
  } catch (err) {
    appendLog(`POST /api/recover — ERROR`, err.payload || err.message);
    showResult(resultEl, "error", `❌ ${err.payload?.error || err.message}`);
  }
}

// ── Event Listeners ──────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  $("#btn-refresh-health").addEventListener("click", refreshHealth);
  $("#btn-refresh-pools").addEventListener("click", refreshPools);
  $("#send-form").addEventListener("submit", handleSend);
  $("#btn-list-recoverable").addEventListener("click", listRecoverable);
  $("#btn-recover-withdraw").addEventListener("click", () =>
    executeRecovery("withdraw"),
  );
  $("#btn-recover-refund").addEventListener("click", () =>
    executeRecovery("refund"),
  );
  $("#btn-clear-log").addEventListener("click", () => {
    logLines = [];
    $("#log-output").textContent = "Log cleared.";
  });

  // Auto-check health on load
  refreshHealth();
  refreshPools();
});
