/**
 * Lowkie — Frontend Application Logic
 *
 * Handles the demo form, status animation, and backend health checks.
 */

// ── Constants ───────────────────────────────────────────────────────────────
const API_BASE = window.location.origin;
const HEALTH_ENDPOINT = `${API_BASE}/api/health`;
const SEND_ENDPOINT = `${API_BASE}/api/send`;

// ── DOM Elements ────────────────────────────────────────────────────────────
const healthEl = document.getElementById("health");
const logEl = document.getElementById("log");
const form = document.getElementById("deposit-form");
const submitBtn = document.getElementById("submit-btn");
const delayInput = document.getElementById("delay-input");
const delayValue = document.getElementById("delay-value");
let currentBackendStatus = null;

// ── Status Steps ────────────────────────────────────────────────────────────
const steps = [
  "step-split",
  "step-encrypt",
  "step-mpc",
  "step-relay",
  "step-done",
];

function setStepState(stepId, state) {
  const el = document.querySelector(`#${stepId} .step-indicator`);
  if (!el) return;
  el.className = `step-indicator ${state}`;
}

function resetSteps() {
  steps.forEach((id) => setStepState(id, "pending"));
}

function activateStep(index) {
  for (let i = 0; i < steps.length; i++) {
    if (i < index) setStepState(steps[i], "done");
    else if (i === index) setStepState(steps[i], "active");
    else setStepState(steps[i], "pending");
  }
}

function completeAllSteps() {
  steps.forEach((id) => setStepState(id, "done"));
}

// ── Logging ─────────────────────────────────────────────────────────────────
function scrollLogToBottom() {
  logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
}

function createLogLine(includeTimestamp = true) {
  const line = document.createElement("div");
  line.className = "log-line";

  if (includeTimestamp) {
    const ts = new Date().toLocaleTimeString();
    const prefix = document.createElement("span");
    prefix.className = "log-prefix";
    prefix.textContent = `[${ts}] `;
    line.append(prefix);
  }

  return line;
}

function resetLog(msg) {
  logEl.replaceChildren();
  const line = createLogLine(false);
  line.textContent = msg;
  logEl.append(line);
  scrollLogToBottom();
}

function appendLog(msg) {
  const line = createLogLine();
  line.append(document.createTextNode(msg));
  logEl.append(line);
  scrollLogToBottom();
}

function lamportsToSol(lamports) {
  return Number(lamports) / 1_000_000_000;
}

function getSolscanUrl(signature) {
  const network = currentBackendStatus?.network;

  if (!signature || typeof signature !== "string") {
    return null;
  }

  if (network === "mainnet" || network === "mainnet-beta") {
    return `https://solscan.io/tx/${signature}`;
  }

  if (network === "devnet" || network === "testnet") {
    return `https://solscan.io/tx/${signature}?cluster=${encodeURIComponent(network)}`;
  }

  return null;
}

function appendTransactionLog(index, lamports, signature) {
  const line = createLogLine();
  line.append(
    document.createTextNode(`   ${index}. ${lamportsToSol(lamports)} SOL -> `),
  );

  const signatureText = document.createElement("span");
  signatureText.className = "log-signature";
  signatureText.textContent = signature;
  line.append(signatureText);

  const solscanUrl = getSolscanUrl(signature);
  if (solscanUrl) {
    line.append(document.createTextNode(" "));

    const link = document.createElement("a");
    link.className = "log-link";
    link.href = solscanUrl;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = "[Solscan]";
    line.append(link);
  }

  logEl.append(line);
  scrollLogToBottom();
}

// ── Delay Slider ────────────────────────────────────────────────────────────
if (delayInput && delayValue) {
  delayInput.addEventListener("input", () => {
    delayValue.textContent = `${delayInput.value}s`;
  });
}

// ── Health Check ────────────────────────────────────────────────────────────
async function checkHealth() {
  try {
    const res = await fetch(HEALTH_ENDPOINT, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    currentBackendStatus = data;
    healthEl.textContent = JSON.stringify(data, null, 2);
    healthEl.style.color = "#34d399";
  } catch (e) {
    currentBackendStatus = null;
    healthEl.textContent = `Backend offline — ${e.message}\n\nStart the backend server:\n  ts-node scripts/frontend-server.ts`;
    healthEl.style.color = "#f87171";
  }
}

checkHealth();
setInterval(checkHealth, 15000);

// ── Form Submission ─────────────────────────────────────────────────────────
if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const recipient = document.getElementById("recipient-input").value.trim();
    const amount = parseFloat(document.getElementById("amount-input").value);
    const delay = parseInt(delayInput.value) * 1000;

    if (!recipient || recipient.length < 32) {
      appendLog("❌ Invalid recipient address");
      return;
    }

    // Disable form
    submitBtn.querySelector(".btn-text").hidden = true;
    submitBtn.querySelector(".btn-loading").hidden = false;
    submitBtn.disabled = true;
    resetSteps();

    resetLog("Starting Lowkie transfer...");
    appendLog(`Recipient: ${recipient.slice(0, 8)}...${recipient.slice(-4)}`);
    appendLog(`Amount: ${amount} SOL`);
    appendLog("Supported pools: 1.0 / 0.1 / 0.01 SOL");

    try {
      // Step 1: Denomination routing
      activateStep(0);
      appendLog(`🧩 Routing ${amount} SOL into fixed denomination notes...`);
      await sleep(500);

      // Step 2: Encrypt & deposit
      activateStep(1);
      appendLog("🔐 Encrypting amounts for Arcium MPC...");

      const res = await fetch(SEND_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient, amountSol: amount, delayMs: delay }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(err);
      }

      // Step 3: MPC
      activateStep(2);
      appendLog("⏳ Arcium MPC cluster processing encrypted state...");

      // Step 4: Relayer
      activateStep(3);
      appendLog(
        `🔁 Relayer withdrawal in ~${delay / 1000}s with random jitter...`,
      );

      const data = await res.json();
      activateStep(4);

      if (data.success) {
        completeAllSteps();
        appendLog(`✅ Transfer complete!`);
        if (
          Array.isArray(data.compactedDenominations) &&
          data.compactedDenominations.length > 0
        ) {
          appendLog(
            `🧹 Demo registry compaction: ${data.compactedDenominations.map((lamports) => `${lamportsToSol(lamports)} SOL`).join(", ")}`,
          );
        }

        if (
          Array.isArray(data.depositReceipts) &&
          data.depositReceipts.length > 0
        ) {
          appendLog(`📤 Deposit txs:`);
          data.depositReceipts.forEach((receipt, index) => {
            appendTransactionLog(
              index + 1,
              receipt.denominationLamports,
              receipt.depositSig,
            );
          });
        }

        if (Array.isArray(data.withdrawals) && data.withdrawals.length > 0) {
          appendLog(`📥 Withdraw txs:`);
          data.withdrawals.forEach((receipt, index) => {
            appendTransactionLog(
              index + 1,
              receipt.denominationLamports,
              receipt.withdrawSig,
            );
          });
        }

        if (data.totalReceivedLamports) {
          appendLog(
            `💸 Recipient received ${lamportsToSol(data.totalReceivedLamports)} SOL`,
          );
        }
        appendLog(
          `🛡️ Block explorer shows: NO amount, NO recipient, NO inner instructions`,
        );
      } else {
        appendLog(`⚠️ Transfer status: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      appendLog(`❌ Error: ${err.message}`);
      appendLog(`\nMake sure the backend server is running:`);
      appendLog(`  ts-node scripts/frontend-server.ts`);
    } finally {
      submitBtn.querySelector(".btn-text").hidden = false;
      submitBtn.querySelector(".btn-loading").hidden = true;
      submitBtn.disabled = false;
    }
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Smooth scroll for nav links ─────────────────────────────────────────────
document.querySelectorAll('.nav-link[href^="#"]').forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    const target = document.querySelector(link.getAttribute("href"));
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});
