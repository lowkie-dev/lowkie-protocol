# Lowkie

**Privacy-preserving pool state for SOL transfers on Solana using Arcium MXE encrypted state.**

Sender and recipient wallet addresses are public (Solana requirement). Native SOL transfer amounts are visible at transaction level, while the pool's running balance and each spend note's amount are stored as `Enc<Mxe, u64>` ciphertexts — 32 opaque bytes only the Arcium MXE cluster can decrypt.

Works on **localnet**, **devnet** (cluster offset 456), and **mainnet-alpha** (cluster offset 2026) using the standard `arcium-anchor`/`@arcium-hq/client` toolchain.

---

## Contents

1. [What this is](#1-what-this-is)
2. [Architecture](#2-architecture)
3. [The four Arcium circuits](#3-the-four-arcium-circuits)
4. [On-chain account design](#4-on-chain-account-design)
5. [Privacy properties](#5-privacy-properties)
6. [Relation to Arcium C-SPL](#6-relation-to-arcium-c-spl)
7. [Toolchain versions](#7-toolchain-versions)
8. [Quick start — localnet](#8-quick-start--localnet)
9. [Deploying to devnet](#9-deploying-to-devnet)
10. [Deploying to mainnet-alpha](#10-deploying-to-mainnet-alpha)
11. [Project structure](#11-project-structure)
12. [For LLMs expanding this codebase](#12-for-llms-expanding-this-codebase)

For the detailed protocol architecture and execution flow, see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 1. What this is

A pool-and-spend-note privacy protocol built on Arcium's MXE framework.

**What is hidden:** Transfer amounts. `PoolState.encrypted_balance` and `NoteAccount.encrypted_amount` are `Enc<Mxe, u64>` ciphertexts. The Arcium MPC cluster performs arithmetic on these ciphertexts using secret sharing — no single ARX node ever sees a plaintext value. Observers on-chain see 32 bytes of apparent noise.

**What is not hidden:** Sender and recipient wallet addresses. SOL flowing into the vault at deposit time. This is unavoidable for native SOL custody on Solana.

**Address unlinkability:** The relayer (a separate keypair from the sender) signs the withdrawal transaction. Combined with a randomised delay, there is no on-chain link between the deposit transaction and the withdrawal transaction.

---

## 2. Architecture

```
SENDER
  │
  │  1. note_secret  = random 32 bytes
  │  2. withdraw_key = random 32 bytes
  │  3. note_hash      = SHA256(note_secret ║ recipient ║ amount)
  │  4. recipient_hash = SHA256(withdraw_key ║ recipient)
  │  5. Encrypt:
  │       • amount     as Enc<Shared, u64>
  │       • secret_lo  as Enc<Shared, u128>
  │       • secret_hi  as Enc<Shared, u128>
  │  6. Read PoolState.encrypted_balance from chain [Enc<Mxe, u64>]
  │
  └─► TRANSACTION A  (signed by sender_wallet)
        • SOL: sender → vault PDA
    • NoteAccount created:
      {note_hash, recipient_hash, status: PendingMpc,
       lamports_for_transfer, zeroed encrypted fields}
        • Arcium MPC queued:
      deposit_to_pool(
        transfer:  Enc<Shared, u64>,
        pool:      Enc<Mxe, u64>,
        secret_lo: Enc<Shared, u128>,
        secret_hi: Enc<Shared, u128>,
      )

                        ▼ Arcium MPC cluster
              Circuit: deposit_to_pool
        amount       = transfer.to_arcis()
        pool_balance = pool.to_arcis()
        → Enc<Mxe, DepositOutput {
          new_pool_balance,
          note_amount,
          note_secret_lo,
          note_secret_hi,
          }>
            ▼ deposit_to_pool_callback

    • PoolState.encrypted_balance ← output[0]
    • NoteAccount.encrypted_amount ← output[1]
    • NoteAccount.encrypted_secret_lo ← output[2]
    • NoteAccount.encrypted_secret_hi ← output[3]
    • NoteAccount.encrypted_pool_at_deposit ← output[0]
    • NoteAccount.amount_nonce ← output.nonce
    • NoteAccount.status ← Ready

          ── randomised delay (15s default) ──

RELAYER  (different keypair from sender)
  │
  │  1. Verify SHA256(withdraw_key ║ recipient) == note.recipient_hash
  │  2. Encrypt claimed note_secret limbs as Enc<Shared, u128>
  │  3. Read:
  │       • NoteAccount deposit snapshot  [Enc<Mxe, DepositOutput>]
  │       • PoolState.encrypted_balance   [Enc<Mxe, u64>]
  │       • NullifierRegistryState        [Enc<Mxe, WithdrawOutput>]
  │
  └─► TRANSACTION B  (signed by relayer_wallet)
        • Arcium MPC queued:
      withdraw_from_pool(
        deposit_data:       Enc<Mxe, DepositOutput>,
        pool:               Enc<Mxe, u64>,
        registry_data:      Enc<Mxe, WithdrawOutput>,
        claimed_secret_lo:  Enc<Shared, u128>,
        claimed_secret_hi:  Enc<Shared, u128>,
      )

                        ▼ Arcium MPC cluster
              Circuit: withdraw_from_pool
        • verifies note_secret inside MPC
        • rejects duplicate nullifiers
        • subtracts note_amount only on accepted withdraw
        • returns (Enc<Mxe, WithdrawOutput>, status_code)
            ▼ withdraw_from_pool_callback

    • PoolState.encrypted_balance ← new ciphertext
    • NullifierRegistryState ← updated encrypted registry snapshot
    • If status_code == accepted:
      vault lamports -= note.lamports_for_transfer
      recipient lamports += note.lamports_for_transfer
      NoteAccount.status ← Withdrawn
      NoteAccount.lamports_for_transfer ← 0
    • If status_code == duplicate:
      NoteAccount.status ← Failed
    • If status_code == registry_full or secret_mismatch:
      NoteAccount.status ← Ready
    • Relayer calls compact_spent_note to close successful notes
    • If the registry fills up, the relayer can queue compact_registry to
      zero the encrypted nullifier set while preserving pool balance

Chain observers still see Tx A and Tx B as two transactions from different
wallets. The persistent encrypted state now also carries the secret-verification
snapshot and denomination-scoped nullifier registry needed for private spends.
```

---

## 3. The four Arcium circuits

All in `encrypted-ixs/circuits.rs`.

### init_pool_balance

```rust
#[instruction]
pub fn init_pool_balance(dummy: Enc<Shared, u64>) -> Enc<Mxe, PoolInitOutput> {
  let _ = dummy;
  Mxe::get().from_arcis(PoolInitOutput {
    pool_balance: 0u64,
    nullifier_registry: [0u128; NULLIFIER_REGISTRY_WORDS],
  })
}
```

Bootstraps both encrypted denomination-scoped state values in one MPC output: the zero pool balance and the zeroed nullifier registry snapshot. Only the MXE cluster can produce valid `Enc<Mxe>` ciphertexts; this cannot be created client-side.

### deposit_to_pool

```rust
#[instruction]
pub fn deposit_to_pool(
  transfer:  Enc<Shared, u64>,
  pool:      Enc<Mxe, u64>,
  secret_lo: Enc<Shared, u128>,
  secret_hi: Enc<Shared, u128>,
) -> Enc<Mxe, DepositOutput> {
    let amount       = transfer.to_arcis();
    let pool_balance = pool.to_arcis();
  let new_pool     = pool_balance + amount;
  let s_lo         = secret_lo.to_arcis();
  let s_hi         = secret_hi.to_arcis();
  pool.owner.from_arcis(DepositOutput {
    new_pool_balance: new_pool,
    note_amount:      amount,
    note_secret_lo:   s_lo,
    note_secret_hi:   s_hi,
  })
}
```

MPC arithmetic on secret shares. Neither the transfer amount, the current pool balance, nor the split note secret are reconstructed at any single node. The callback persists the full deposit snapshot into the note account for the future withdrawal.

### withdraw_from_pool

```rust
#[instruction]
pub fn withdraw_from_pool(
  deposit_data: Enc<Mxe, DepositOutput>,
  pool: Enc<Mxe, u64>,
  registry_data: Enc<Mxe, WithdrawOutput>,
  claimed_secret_lo: Enc<Shared, u128>,
  claimed_secret_hi: Enc<Shared, u128>,
) -> (Enc<Mxe, WithdrawOutput>, u8)
```

This circuit verifies the claimed secret inside MPC, checks the encrypted nullifier registry for double-spends, inserts the nullifier on success, and subtracts the note amount from the pool only when the withdrawal is accepted. The returned `u8` status distinguishes accepted, duplicate nullifier, full registry, and secret mismatch.

### compact_registry

```rust
#[instruction]
pub fn compact_registry(pool: Enc<Mxe, u64>) -> Enc<Mxe, WithdrawOutput> {
  let pool_balance = pool.to_arcis();
  pool.owner.from_arcis(WithdrawOutput {
    new_pool_balance: pool_balance,
    nullifier_registry: [0u128; NULLIFIER_REGISTRY_WORDS],
  })
}
```

This preserves the encrypted pool balance while resetting the encrypted nullifier registry. It is a relayer-side maintenance circuit used when the bounded registry fills up.

---

## 4. On-chain account design

### PoolState `PDA: [b"pool", denomination_lamports_le]`

| Field                   | Type       | What it stores                                                                                                    |
| ----------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `encrypted_balance`     | `[u8; 32]` | `Enc<Mxe, u64>` — pool's running total. Only MXE can decrypt.                                                     |
| `balance_nonce`         | `u128`     | Output nonce from last MPC computation. Required to pass ciphertext back as `Enc<Mxe>` input to next computation. |
| `denomination_lamports` | `u64`      | Fixed lamport denomination served by this pool tier.                                                              |
| `is_initialized`        | `bool`     | Set by `init_pool_callback`. Blocks deposits until valid `Enc<Mxe,0>` is established.                             |
| `bump`, `vault_bump`    | `u8`       | PDA bumps.                                                                                                        |

### NullifierRegistryState `PDA: [b"nullifier_registry", denomination_lamports_le]`

| Field                  | Type            | What it stores                                                                                                                         |
| ---------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `encrypted_nullifiers` | `[[u8; 32]; N]` | `Enc<Mxe, [u128; N]>` flattened into registry words. Word 0 is the active entry count; remaining words are 2-limb nullifier entries.   |
| `registry_nonce`       | `u128`          | Nonce shared by the encrypted registry output.                                                                                         |
| `pool_snapshot_ct`     | `[u8; 32]`      | Element 0 of the `WithdrawOutput` struct. Stored so the full output layout can be passed back into MPC without changing CTR positions. |
| `bump`                 | `u8`            | PDA bump.                                                                                                                              |

### NoteAccount `PDA: [b"note", note_hash]`

| Field                       | Type       | What it stores                                                                                                                              |
| --------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `note_hash`                 | `[u8; 32]` | `SHA256(secret ║ recipient ║ amount_lamports_le)` — commitment, reveals nothing without preimage.                                           |
| `status`                    | enum       | `PendingMpc → Ready → Withdrawn` (transient) before relayer cleanup closes the spent note account, or `Failed` after a duplicate withdraw.  |
| `recipient_hash`            | `[u8; 32]` | `SHA256(withdraw_key ║ recipient_pubkey)` — recipient commitment, verified during withdraw without revealing `note_secret`.                 |
| `encrypted_amount`          | `[u8; 32]` | `Enc<Mxe, u64>` — this note's amount. Set by `deposit_callback`. Only MXE can decrypt.                                                      |
| `encrypted_secret_lo`       | `[u8; 32]` | `Enc<Mxe, u128>` — lower 128 bits of the note secret, stored for MPC-side secret verification.                                              |
| `encrypted_secret_hi`       | `[u8; 32]` | `Enc<Mxe, u128>` — upper 128 bits of the note secret, stored for MPC-side secret verification.                                              |
| `encrypted_pool_at_deposit` | `[u8; 32]` | Pool-balance snapshot from element 0 of the `DepositOutput` struct. Preserved so the full struct layout survives CTR-mode indexing.         |
| `amount_nonce`              | `u128`     | Shared nonce for every `Enc<Mxe>` field emitted by the deposit callback. Required to pass the full deposit snapshot back into withdraw MPC. |
| `lamports_for_transfer`     | `u64`      | Set during deposit when the native SOL transfer is already visible, then cleared after a successful withdrawal callback.                    |
| `bump`                      | `u8`       | PDA bump.                                                                                                                                   |

---

## 5. Privacy properties

**Hidden from on-chain observers:**

- Transfer amounts — `Enc<Mxe, u64>` ciphertexts in `NoteAccount.encrypted_amount`
- Pool running total — `Enc<Mxe, u64>` ciphertext in `PoolState.encrypted_balance`

**Visible to on-chain observers:**

- Sender wallet (signs deposit tx)
- Relayer wallet (signs withdrawal tx — different from sender)
- Recipient wallet (receives SOL)
- SOL amount entering the vault at deposit time
- SOL amount transferred out from vault at withdrawal time
- `note_hash` — 32 opaque bytes, nothing without the preimage

**Events:** Deposit and withdraw events now emit pool-level metadata only. They no longer log note hashes, encrypted note amounts, or note nonces.

**Current implementation note:** `withdraw()` does not receive a plaintext amount argument. The callback reads `lamports_for_transfer` from the note account, clears it after a successful withdrawal, and the relayer cleanup step closes the spent note account so it does not persist in live chain state.

**Unlinkability:** The only on-chain artefact shared between deposit and withdrawal is the `NoteAccount` PDA, seeded by `note_hash`. Without knowing the 32-byte `noteSecret`, an observer cannot determine which deposit corresponds to which withdrawal. SHA256 preimage resistance (2^256 work) makes brute-force infeasible.

**MPC security:** Arcium's Cerberus protocol requires only one honest ARX node for security. If all nodes in a cluster collude, encrypted amounts could be recovered. This is a trust assumption about the Arcium network.

---

## 6. Relation to Arcium C-SPL

C-SPL (Confidential SPL) is Arcium's forthcoming token standard that formalises the exact pattern this project implements — `Enc<Mxe>` ciphertexts in program-owned accounts, MPC arithmetic updating them, callbacks writing new ciphertexts back.

**What the claim "C-SPL on devnet uses cluster offset 456" means:** C-SPL programs are regular Arcium MXEs using confidential token primitives. They deploy via `arcium deploy --cluster-offset 456` on devnet, the same as any other MXE. There is no separate C-SPL cluster or SDK — the `arcium-anchor` crate and `@arcium-hq/client` are the toolchain.

**Confirmed from official Arcium deployment docs:**

- Devnet cluster offset: **456**
- Mainnet-alpha cluster offset: **2026**
- Same `arcium build` / `arcium deploy` / `arcium test` workflow for both

**What Lowkie is:** The MXE pattern that C-SPL will standardise, implemented now using the current toolchain. When C-SPL ships a formal token interface (confidential mints, program-owned confidential ATAs), upgrading Lowkie is a custody layer swap — the MPC circuits and the `Enc<Mxe>` state pattern stay identical.

---

## 7. Toolchain versions

All confirmed from official sources.

| Tool                      | Version    | Source                          |
| ------------------------- | ---------- | ------------------------------- |
| arcium CLI                | 0.6.3      | `setup-arcium` GitHub Action    |
| `arcium-anchor` (Rust)    | **0.9.5**  | crates.io/crates/arcium-anchor  |
| `anchor-lang` (Rust)      | **0.32.1** | Required by arcium-anchor 0.9.5 |
| `anchor-spl` (Rust)       | **0.32.1** | Same                            |
| `@arcium-hq/client` (npm) | `^0.9.5`   | npmjs.com                       |
| `@coral-xyz/anchor` (npm) | `^0.32.0`  | —                               |
| Solana CLI                | 2.3.0      | `setup-arcium` GitHub Action    |
| Node.js                   | 20.18.0    | `setup-arcium` GitHub Action    |

---

## 8. Quick start — localnet

```bash
# Terminal 1 — Arcium localnet (sets ARCIUM_CLUSTER_OFFSET automatically)
arcium localnet
# Wait for: "ARX nodes ready"

# Terminal 2
git clone <repo> && cd lowkie
cp .env.example .env
yarn install
arcium build

# Static checks (no localnet required)
yarn ci:check

# One-command local validation
# Prereqs in this shell:
#   export ARCIUM_CLUSTER_OFFSET=<value printed by arcium localnet>
#   export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
yarn local:validate

# Deploy — copy the printed program ID
arcium deploy \
  --program-name lowkie_pool \
  --program-keypair target/deploy/lowkie_pool-keypair.json \
  --keypair-path ~/.config/solana/id.json \
  --cluster-offset 0 \
  --recovery-set-size 4 \
  --rpc-url localnet
# → update Anchor.toml, Arcium.toml, .env with the printed program ID

# One-time comp def init + pool init (run tests — they do this)
# Requires target/idl from arcium build and a running localnet/provider env
arcium test

# Manual send (after pool is initialised)
RECIPIENT=<base58> AMOUNT_SOL=0.1 ts-node client/send.ts

# Production safety:
# - RELAYER_KEYPAIR_PATH must be set and must differ from ANCHOR_WALLET.
# - Plaintext note-file export is disabled by default.
# - LOWKIE_AUTO_COMPACT_REGISTRY stays disabled unless you explicitly opt into
#   unsafe local-demo behavior with LOWKIE_ALLOW_UNSAFE_LOCALNET=true.
```

## Testing: How To Run

### 1) Prepare env

```bash
cp .env.example .env
```

Local defaults in `.env`:

```bash
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
ARCIUM_CLUSTER_OFFSET=0
ANCHOR_WALLET=~/.config/solana/id.json
RELAYER_KEYPAIR_PATH=~/.config/solana/relayer.json
```

### 2) Install dependencies

```bash
yarn install
```

### 3) Start localnet (terminal A)

```bash
arcium localnet
```

Keep this terminal running.

### 4) Run tests (terminal B)

```bash
export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET=$HOME/.config/solana/id.json
export ARCIUM_CLUSTER_OFFSET=0
yarn -s test
```

### 5) Run full local validation

```bash
yarn -s local:validate
```

`local:validate` runs:

1. Type checking (`yarn -s ci:check`)
2. RPC health check
3. Integration tests (`yarn -s test`)

## Backend API, SDK, And Test Frontend

The deployable shape is now:

- `apps/backend/` — the API your real React frontend can call
- `packages/lowkie-sdk/` — a typed client for frontend integration
- `apps/test-frontend/` — a demo UI for local/devnet testing only

### Start backend API

```bash
yarn --cwd apps/backend start
```

### Start test frontend

```bash
yarn --cwd apps/test-frontend start
```

If the test frontend runs on a different origin, set:

```bash
LOWKIE_API_BASE=http://127.0.0.1:5174
```

### Endpoints

- `GET /api/health`
- `POST /api/send` with JSON body (`POST /api/deposit` is kept as a compatibility alias):

```json
{
  "recipient": "<base58-pubkey>",
  "amountSol": 0.1,
  "delayMs": 15000
}
```

Notes:

1. Keys remain server-side. The backend uses `SENDER_WALLET` and `RELAYER_KEYPAIR_PATH`.
2. The backend supports bearer-token auth, CORS origin allowlists, fixed-window rate limiting, request-size bounds, and serialized `/api/send` execution.
3. If `BACKEND_HOST` is not loopback, startup requires `LOWKIE_REQUIRE_API_AUTH=true`, `LOWKIE_API_AUTH_TOKEN`, and `LOWKIE_ALLOWED_ORIGINS`.
4. Relayer key must differ from sender key.

### API endpoints

- `GET /api/health`
- `GET /api/relayer/health`
- `POST /api/send`
- `GET /api/recoverable`
- `POST /api/recover`
- `POST /api/relay`

Recommended internet-facing backend env:

```bash
LOWKIE_REQUIRE_API_AUTH=true
LOWKIE_API_AUTH_TOKEN=<long-random-secret>
LOWKIE_ALLOWED_ORIGINS=https://app.example.com
LOWKIE_API_RATE_LIMIT_WINDOW_MS=60000
LOWKIE_API_RATE_LIMIT_MAX_REQUESTS=10
LOWKIE_SERIALIZE_SEND_REQUESTS=true
LOWKIE_AUTO_COMPACT_REGISTRY=false
LOWKIE_WRITE_NOTE_FILE=false
LOWKIE_ALLOW_PLAINTEXT_NOTE_FILE=false
```

### SDK

Use `packages/lowkie-sdk/src/index.ts` as the typed client for your future React frontend.

---

## 9. Deploying to devnet

Devnet uses **cluster offset 456** — the same Arcium cluster infrastructure.

```bash
# 1. Fund your wallet
solana airdrop 2 <your-pubkey> --url devnet

# 2. Deploy  (use a reliable RPC — default devnet drops transactions)
arcium deploy \
  --cluster-offset 456 \
  --recovery-set-size 4 \
  --keypair-path ~/.config/solana/id.json \
  --rpc-url <your-helius-or-quicknode-devnet-rpc>

# 3. Update Arcium.toml — uncomment:
# [clusters.devnet]
# offset = 456

# 4. Update Anchor.toml [provider] cluster = "devnet"
#    Update .env LOWKIE_PROGRAM_ID with the deployed program ID
#    Update .env ARCIUM_CLUSTER_OFFSET=456

# 5. For large circuits (> ~200KB), host build/*.arcis on IPFS/S3/CDN and
#    point bootstrap at them instead of paying rent for raw on-chain uploads.
#    Example:
#    LOWKIE_CIRCUIT_SOURCE_MODE=offchain
#    LOWKIE_OFFCHAIN_CIRCUIT_BASE_URL=https://cdn.example.com/lowkie/
#    Or provide per-circuit URLs if your host returns different file paths.
#    LOWKIE_OFFCHAIN_INIT_POOL_BALANCE_URL=https://files.example/init.arcis
#    LOWKIE_OFFCHAIN_DEPOSIT_TO_POOL_URL=https://files.example/deposit.arcis
#    LOWKIE_OFFCHAIN_WITHDRAW_FROM_POOL_URL=https://files.example/withdraw.arcis
#    LOWKIE_OFFCHAIN_COMPACT_REGISTRY_URL=https://files.example/compact.arcis

# 6. Run tests on devnet
arcium test --cluster devnet

# or via package script
yarn devnet:test

# 7. Bootstrap computation definitions + pool state on the deployed program
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ARCIUM_CLUSTER_OFFSET=456 \
LOWKIE_PROGRAM_ID=<deployed-program-id> \
LOWKIE_OFFCHAIN_CIRCUIT_BASE_URL=https://cdn.example.com/lowkie/ \
yarn bootstrap:program

# The program is not send-ready until bootstrap creates all four computation
# definitions and every denomination pool PDA. If send/front-end health reports
# missing pools or comp defs, your .env is still pointing at a partial deploy.

# LOWKIE_CIRCUIT_SOURCE_MODE now accepts auto/onchain/offchain.
# If LOWKIE_OFFCHAIN_CIRCUIT_BASE_URL or LOWKIE_OFFCHAIN_*_URL is set,
# auto mode selects offchain automatically.

# 8. Manual send on devnet
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ARCIUM_CLUSTER_OFFSET=456 \
RECIPIENT=<base58> AMOUNT_SOL=0.1 \
ts-node client/send.ts
```

**If deployment fails mid-way:**

```bash
arcium deploy --cluster-offset 456 ... --resume
```

---

## 10. Deploying to mainnet-alpha

Mainnet-alpha uses **cluster offset 2026**. Real SOL required; no airdrops.

```bash
arcium deploy \
  --cluster-offset 2026 \
  --recovery-set-size 4 \
  --keypair-path ~/.config/solana/id.json \
  --rpc-url <your-mainnet-rpc>

# Arcium.toml — uncomment:
# [clusters.mainnet]
# offset = 2026

arcium test --cluster mainnet
```

---

## 11. Project structure

```
lowkie/
├── .github/
│   ├── copilot-instructions.md  Workspace guidance for this repo
│   └── skills/solana-dev/       Repo-tailored Solana best-practice skill
│
├── Arcium.toml                 Arcium CLI config (cluster offsets)
├── Anchor.toml                 Anchor config
├── Cargo.toml                  Rust workspace
├── package.json
├── tsconfig.json
├── .env.example
│
├── encrypted-ixs/
│   └── circuits.rs             Four Arcium MPC circuits
│
├── programs/lowkie_pool/
│   ├── Cargo.toml              arcium-anchor = "0.9.5", anchor-lang = "0.32.1"
│   └── src/lib.rs              Comp-def init, queue/callback, note cleanup, registry compaction
│
├── client/
│   ├── arciumAccounts.ts       PDA derivation helpers
│   ├── constants.ts            Shared program and denomination constants
│   ├── privacyLogging.ts       Log redaction helpers
│   ├── programContext.ts       Shared RPC/provider/program bootstrap
│   ├── relayer.ts              Relayed withdrawal + registry compaction flow
│   ├── runtimeSafety.ts        Localnet/demo safety gates
│   ├── send.ts                 Sender flow and denomination splitting
│   └── utils.ts                Hashing, splitting, and amount helpers
│
├── scripts/
│   ├── bootstrap-program.ts    Comp-def registration and pool bootstrap
│   ├── frontend-server.ts      Demo UI + API bridge
│   ├── frontendBridgeSecurity.ts Security, auth, and rate limiting
│   └── local-validate.ts       Local typecheck/build/test entry point
│
└── tests/
  └── lowkie.ts               Integration and helper coverage
```

---

## 12. For LLMs expanding this codebase

### Critical invariants

**`ArgBuilder` order must match circuit parameter order exactly.**

For `Enc<Shared, T>`: `x25519_pubkey` + `plaintext_u128(nonce)` + `encrypted_u{N}`.
For `Enc<Mxe, T>`: `plaintext_u128(nonce)` + `encrypted_u{N}` (no pubkey — MXE key is fixed).

This repo uses `ArgBuilder::new()` to emit the underlying `Argument` sequence. Getting the order wrong causes the ARX nodes to decrypt garbage, and the computation fails silently or with a generic error.

**Callback custom account order must match `CallbackAccount` vec order.**

The struct fields after the 6 standard Arcium accounts must appear in the identical sequence as the `&[CallbackAccount{...}]` slice passed to `callback_ix()`. Mismatch silently mutates the wrong account.

**Full deposit/withdraw output layouts must be preserved.**

`withdraw_from_pool` must receive the complete `DepositOutput` and `WithdrawOutput` ciphertext arrays, not cherry-picked fields. Re-indexing ciphertexts changes CTR-mode positions and breaks decryption.

**`balance_nonce`, `amount_nonce`, and `registry_nonce` are always stored with their ciphertexts.**

They must be read together when constructing the next `Enc<Mxe>` input. A stale nonce makes the ARX nodes fail to decrypt the ciphertext.

**`recipient_hash` uses `withdraw_key`, not `note_secret`.**

Recipient verification is `SHA256(withdraw_key ∥ recipient_pubkey)`. The note hash remains `SHA256(note_secret ∥ recipient ∥ amount)`, so the recipient preimage and note-secret preimage are deliberately separated.

### Arcium API reference (arcium-anchor 0.9.5)

```rust
// queue_computation signature
queue_computation(
    ctx.accounts,     // &mut impl QueueCompAccs
    computation_offset: u64,
    args: Vec<Argument>,
    server_addr: Option<SocketAddr>,  // None = on-chain callback
    callbacks: Vec<CallbackInstruction>,
    num_callback_txs: u8,
    cu_price_micro: u64,
)?;

// Argument enum variants
Argument::ArcisPubkey([u8; 32])      // x25519 pubkey — before Enc<Shared> ciphertext
Argument::PlaintextU128(u128)        // nonce — before any Enc ciphertext
Argument::EncryptedU64([u8; 32])     // Enc<*, u64>
Argument::EncryptedU8([u8; 32])      // Enc<*, u8>
Argument::EncryptedU16([u8; 32])     // Enc<*, u16>
Argument::EncryptedU32([u8; 32])     // Enc<*, u32>
Argument::EncryptedU128([u8; 32])    // Enc<*, u128>
Argument::EncryptedBool([u8; 32])    // Enc<*, bool>

// init_comp_def signature
init_comp_def(
    ctx.accounts,          // &mut impl InitCompDefAccs
    circuit_source: Option<CircuitSource>,  // None = inline
    cu_amount: Option<u64>,
)?;
```

### Adding a new circuit

1. Add `#[instruction]` function to `encrypted-ixs/circuits.rs`
2. Add `const COMP_DEF_OFFSET_NEW: u32 = comp_def_offset("new_fn");` in `lib.rs`
3. Add `init_new_comp_def` with `#[init_computation_definition_accounts("new_fn", payer)]`
4. Add queue instruction + callback instruction + their account structs
5. `arcium build` — auto-generates `NewFnOutput` type
6. Call `init_new_comp_def` once after deploy

### Upgrading when C-SPL ships

When Arcium publishes C-SPL token primitives:

1. Replace the SOL vault + lamport transfer with C-SPL confidential token accounts
2. The Arcis circuits (`deposit_to_pool`, `withdraw_from_pool`) stay nearly identical — they operate on `Enc<Mxe, u64>` regardless of whether that represents SOL or a token balance
3. The note hash commitment pattern is unchanged
4. The relayer pattern is unchanged

---

## Licence

MIT
