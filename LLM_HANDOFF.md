# Lowkie Project State & Handoff Note

**Date**: April 2026
**Project**: Lowkie — Arcium MXE Privacy Pool (Solana)

This document serves as a memory/handoff state for any LLM continuing work on this project.

## 1. Project Overview & Architecture

Lowkie is a privacy protocol on Solana that breaks the link between sender and receiver. It uses Arcium's Multi-Party Computation (MPC) to maintain encrypted state (`Enc<Mxe, u64>`) for the pool balance, preventing observers from correlating deposits and withdrawals via on-chain amounts.

### Recent Privacy Hardening Implemented:

1. **Recipient Encryption (On-chain & Client)**:
   - `NoteAccount.recipient` was converted to `NoteAccount.recipient_hash` (stores `SHA256(secret || pubkey)`).
   - The recipient is kept invisible on-chain during deposit and is only verified via hash during the withdrawal transaction.
   - Prevents observers from seeing who will receive funds.
2. **Client-Side Note Splitting**:
   - `client/utils.ts -> randomSplit()` splits user deposits into 2-4 random sub-amounts.
   - Each sub-note has a different delay/timing, breaking amount correlation (e.g., depositing 10 SOL doesn't result in a single 10 SOL withdrawal).
3. **Temporal Decorrelation**:
   - `client/relayer.ts` processes withdrawals with randomized inter-note delays.
4. **Silent Withdrawals**:
   - Uses direct lamport manipulation (no CPI logs) to prevent withdrawal amounts from appearing in block explorer inner instruction logs.

## 2. Frontend Status

A premium, hackathon-ready frontend dashboard was built.

- **Location**: `frontend/index.html` & `frontend/styles.css`
- **Features**: Dark-themed, glassmorphism, dynamic animations, live status tracing, and a "Privacy Comparison" visual.
- **Server**: A backend script at `scripts/frontend-server.ts` handles the UI serving and `POST /api/send` API to trigger deposits/withdrawals.

## 3. Environment & Deployment Status

### Localnet Verification

- **Status**: ✅ PASSED test suite (6/6 passing).
- Tests verify MPC init, recipient hash deposit, silent withdrawal, double-spend rejection, and wrong-recipient rejection.

### Devnet Deployment

- **Status**: ✅ DEPLOYED.
- **RPC URL**: `https://api.devnet.solana.com`
- **Arcium Cluster Offset**: `456`
- **Deployed Program ID**: `6Jub3sVovG5EjKCs6bUVjX6buLKLBDZ5L6zNt659xmLH`
- **IDL Account**: `HiLit4UvRtUsyZro8E7zK8DjRNMkBSSepUtddjw3ALpd`
- **Main Wallet**: `~/.config/solana/id.json` (Balance: ~4.57 SOL devnet)
- **Relayer Keypair**: `~/.config/solana/relayer.json` (`Bz9w6Z3eB1vHNF8oPjgUd8xaiFU6wtVduHHV8CHFpfHv` - Balance: 0.5 SOL devnet)
- **.env**: Has been successfully configured for Devnet.

## 4. How to Run & Test on Devnet

### Running the Frontend Server

The frontend server proxies requests to the real devnet program. It is currently running, or can be started with:

```bash
npx ts-node scripts/frontend-server.ts
```

- Navigate to `http://127.0.0.1:5174`
- The backend health status should show connected to devnet.

### Running the CLI Tests against Devnet

If you want to run the test suite against devnet:

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ARCIUM_CLUSTER_OFFSET=456 \
ANCHOR_WALLET=~/.config/solana/id.json \
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/lowkie.ts
```

_(Note: Devnet MPC interactions may depend on Arcium Devnet node availability. If the nodes are offline or processing slowly, the MPC callback may pend)._

## 5. Next Steps / Action Items

1. **Frontend E2E Test**: Execute a real transfer using the `http://127.0.0.1:5174` frontend UI. Ensure that the form submits the `/api/send` request successfully and that the funds are deposited and subsequently withdrawn by the relayer.
2. **Review Devnet Explorer Logs**: Check the generated transactions on Solscan/Explorer (Devnet) to visually prove that the privacy guarantees hold true (no amount in logs, no recipient in deposit).
3. **Record Demo Video**: Record the frontend walkthrough showing the privacy comparison and an end-to-end devnet transaction for hackathon submission.
4. **Cleanup & Polish**: Remove any stray `console.log` statements and finalize the `README.md` based on this new architecture before submission.
