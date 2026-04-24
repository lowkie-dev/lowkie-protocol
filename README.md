# Lowkie

**Confidential pool state for SOL transfers on Solana using Arcium MXE encrypted state.**

Lowkie is a denomination-routed SOL pool protocol. The pool's internal running balances, each note's stored amount, the note-secret verification snapshot, and the denomination-scoped nullifier registry are all kept as `Enc<Mxe, ...>` ciphertexts that only the Arcium MXE cluster can decrypt.

This matters for positioning: Lowkie is a **confidential-state protocol**, not full transaction anonymity for native SOL. Sender, relayer, and recipient addresses are still visible on-chain. Deposit transfers are visible. Withdrawal callbacks avoid a System Program transfer CPI, but a determined observer can still infer the lamports moved from account balance changes.

Works on **localnet**, **devnet** (cluster offset `456`), and **mainnet-alpha** (cluster offset `2026`) with the current `arcium-anchor` / `@arcium-hq/client` toolchain.

---

## Contents

1. [What this is](#1-what-this-is)
2. [System shape](#2-system-shape)
3. [End-to-end flow](#3-end-to-end-flow)
4. [The four Arcium circuits](#4-the-four-arcium-circuits)
5. [On-chain account model](#5-on-chain-account-model)
6. [Confidentiality model](#6-confidentiality-model)
7. [Toolchain and supported denominations](#7-toolchain-and-supported-denominations)
8. [Quick start — localnet](#8-quick-start--localnet)
9. [Backend API, SDK, and test frontend](#9-backend-api-sdk-and-test-frontend)
10. [Deploying to devnet](#10-deploying-to-devnet)
11. [Deploying to mainnet-alpha](#11-deploying-to-mainnet-alpha)
12. [Project structure](#12-project-structure)
13. [For LLMs expanding this codebase](#13-for-llms-expanding-this-codebase)

For the implementation-level walkthrough, see [ARCHITECTURE.md](./ARCHITECTURE.md).

For repository workflow and branch naming, see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## 1. What this is

Lowkie is a pool-and-note protocol built around **confidential internal state** for native SOL settlement.

Each transfer is split into supported fixed denominations. Every denomination routes through its own pool PDA, vault PDA, and encrypted nullifier registry. Deposits move native SOL into the vault immediately, while Arcium MPC callbacks update the pool's encrypted accounting and the note's encrypted metadata asynchronously.

The protocol stores and operates on:

- `PoolState.encrypted_balance` as `Enc<Mxe, u64>`
- `NoteAccount.encrypted_amount` as `Enc<Mxe, u64>`
- `NoteAccount.encrypted_secret_lo` and `encrypted_secret_hi` as `Enc<Mxe, u128>`
- `NullifierRegistryState.encrypted_nullifiers` as the flattened ciphertext words of `Enc<Mxe, [u128; N]>`

What Lowkie does **not** hide for native SOL:

- deposit sender address
- relayer signer address
- withdrawal recipient address
- deposit transfer amount
- denomination routing
- withdrawal lamport delta for observers willing to compare balances

The relayer still helps operationally and for unlinkability: it uses a different keypair from the sender, submits the withdrawal later with randomized jitter, and can run locally or as a separate `/api/relay` service.

---

## 2. System shape

The deployed system is now split into four runtime surfaces:

```text
Browser / App / Operator CLI
  |
  | 1. Build deposits or request send
  v
apps/backend/server.ts
  - GET /api/health
  - POST /api/build-deposits
  - POST /api/submit-deposits
  - POST /api/send
  - POST /api/relay
  |
  | 2. Uses local relayer key or forwards to LOWKIE_RELAYER_URL
  v
apps/backend/src/core/*.ts
  - deposit orchestration
  - relay request serialization
  - withdrawal execution
  - recovery and readiness checks
  |
  | 3. Anchor instructions + Arcium queueing
  v
programs/lowkie_pool/src/lib.rs
  - protocol config
  - init/deposit/withdraw callbacks
  - note cleanup and failed-deposit refunds
  |
  | 4. Confidential compute
  v
encrypted-ixs/circuits.rs + Arcium MXE cluster
```

There are two common client modes:

1. **Server-side signer mode** via `POST /api/send`
   The backend holds `SENDER_WALLET`, builds deposits, signs them, submits them, then executes relay locally or remotely.

2. **Browser-signed deposit mode** via `POST /api/build-deposits` + `POST /api/submit-deposits`
   The backend builds unsigned versioned transactions, a browser wallet signs them, and the backend later submits them and hands the note material to the relayer path.

The optional remote relayer uses the same relay payload format as the local relayer and listens on `POST /api/relay`.

---

## 3. End-to-end flow

### Phase 0 — Bootstrap

`yarn bootstrap:program` does the protocol bring-up for the deployed program:

1. Ensures `ProtocolConfig` exists.
2. Sets or updates the maintenance authority used for `compact_registry`.
3. Registers all four computation definitions.
4. Creates and initializes every denomination pool and vault.
5. Verifies the deployment is send-ready.

Readiness requires:

- `ProtocolConfig`
- MXE account
- computation definitions for `init_pool_balance`, `deposit_to_pool`, `withdraw_from_pool`, and `compact_registry`
- initialized pools for all supported denominations

### Phase 1 — Build deposits

For an amount like `1.61 SOL`, the backend decomposes the transfer into supported pool notes, for example:

```text
1.0 SOL + 0.5 SOL + 0.1 SOL + 0.01 SOL
```

For each sub-note it generates:

1. `note_secret` as 32 random bytes
2. `withdraw_key` as 32 random bytes
3. `note_hash = SHA256(note_secret || recipient || amount_lamports_le)`
4. `recipient_hash = SHA256(withdraw_key || recipient_pubkey)`
5. `nullifier_hash = H(note_secret)`

The amount and the two secret limbs are encrypted client-side as `Enc<Shared, ...>` inputs for Arcium.

### Phase 2 — Deposit transaction

Each deposit transaction:

1. transfers SOL from sender to the denomination vault PDA
2. creates the `NoteAccount` PDA and the `NullifierRecord` PDA
3. stores sender, `recipient_hash`, `nullifier_hash`, `lamports_for_transfer`, and zeroed encrypted fields
4. queues `deposit_to_pool`

On callback, `deposit_to_pool_callback`:

1. updates `PoolState.encrypted_balance`
2. stores `encrypted_amount`, `encrypted_secret_lo`, `encrypted_secret_hi`, and `encrypted_pool_at_deposit`
3. stores the shared nonce for those ciphertexts
4. flips `pool_credit_applied = true`
5. marks the note `Ready`

### Phase 3 — Relay and withdraw

After the configured delay plus jitter, the relayer handles each sub-note.

The relayer path:

1. loads the recovery data or relay payload
2. checks whether the denomination registry is full and compacts it if allowed
3. derives the note, nullifier record, pool, registry, and vault PDAs
4. verifies recipient ownership on-chain with `SHA256(withdraw_key || recipient_pubkey)`
5. encrypts the claimed note secret limbs as fresh `Enc<Shared, u128>` values
6. queues `withdraw_from_pool` with the full `DepositOutput` and `WithdrawOutput` layouts preserved

On callback, `withdraw_from_pool_callback`:

1. updates `PoolState.encrypted_balance`
2. updates the encrypted nullifier registry snapshot
3. marks `NullifierRecord.spent = true` on accepted withdraws
4. directly debits vault lamports and credits recipient lamports
5. sets `NoteAccount.status = Withdrawn`
6. clears `lamports_for_transfer`

After a successful callback, the relayer calls `compact_spent_note` to close the note PDA. If the deposit callback failed before encrypted pool credit was applied, the sender can instead use `refund_failed_deposit`.

---

## 4. The four Arcium circuits

All four live in [encrypted-ixs/circuits.rs](./encrypted-ixs/circuits.rs).

### init_pool_balance

Bootstraps the encrypted state for a denomination by returning one MXE-owned struct that contains:

- `pool_balance = 0`
- a zeroed nullifier registry snapshot

Only the Arcium cluster can create this `Enc<Mxe, ...>` output.

### deposit_to_pool

Consumes:

- `transfer: Enc<Shared, u64>`
- `pool: Enc<Mxe, u64>`
- `secret_lo: Enc<Shared, u128>`
- `secret_hi: Enc<Shared, u128>`

Returns `Enc<Mxe, DepositOutput>` containing:

- updated encrypted pool balance
- encrypted note amount
- encrypted low and high note-secret limbs

### withdraw_from_pool

Consumes:

- the full encrypted deposit snapshot
- the current encrypted pool balance
- the full encrypted nullifier registry snapshot
- freshly encrypted claimed secret limbs

Returns:

- an updated `Enc<Mxe, WithdrawOutput>`
- a status code for accepted, already-spent nullifier, registry full, or secret mismatch

### compact_registry

Preserves the encrypted pool balance while zeroing the encrypted nullifier registry snapshot. This is maintenance-only and gated by `ProtocolConfig.maintenance_authority`.

---

## 5. On-chain account model

### ProtocolConfig `PDA: [b"protocol_config"]`

- `admin`: allowed to initialize and update computation-definition config
- `maintenance_authority`: allowed to queue `compact_registry`
- `bump`

### PoolState `PDA: [b"pool", denomination_lamports_le]`

- `encrypted_balance: [u8; 32]`
- `balance_nonce: u128`
- `denomination_lamports: u64`
- `is_initialized: bool`
- `bump`, `vault_bump`

### VaultAccount `PDA: [b"vault", denomination_lamports_le]`

- holds native SOL for one denomination pool
- program-owned, so withdraw callback can manipulate lamports directly
- stores only `bump`

### NullifierRegistryState `PDA: [b"nullifier_registry", denomination_lamports_le]`

- `encrypted_nullifiers: [[u8; 32]; N]`
- `registry_nonce: u128`
- `pool_snapshot_ct: [u8; 32]`
- `bump`

### NullifierRecord `PDA: [b"nullifier", nullifier_hash]`

- stores the note's public nullifier commitment
- tracks whether that nullifier has been spent
- keeps replay protection stable even after note closure and registry compaction

### NoteAccount `PDA: [b"note", note_hash]`

- `note_hash`
- `status`
- `sender`
- `recipient_hash`
- `nullifier_hash`
- `encrypted_amount`
- `encrypted_secret_lo`
- `encrypted_secret_hi`
- `encrypted_pool_at_deposit`
- `amount_nonce`
- `pool_credit_applied`
- `lamports_for_transfer`
- `bump`

Lifecycle:

```text
PendingMpc -> Ready -> Withdrawn -> closed
                  \-> Failed -> refund or cleanup path
```

---

## 6. Confidentiality model

### Confidential inside MXE-managed state

- the pool running total for each denomination
- the stored note amount
- the stored low and high note-secret limbs
- the encrypted nullifier registry contents

### Visible on-chain

- sender signer for each deposit
- relayer signer for each withdrawal
- recipient account on withdrawal
- denomination pool selected for each note
- deposit transfer amount
- note and nullifier commitments while their accounts exist

### Withdrawal amount nuance

`withdraw()` does not carry a plaintext amount argument, and the callback does not emit a System Program transfer CPI. That reduces what standard explorers display, but it does **not** make the SOL movement opaque to an observer comparing balances.

### Unlinkability behavior

- the relayer key must differ from the sender key
- the relayer applies randomized delay and per-note jitter
- note PDAs are closed after successful withdrawal

This gives Lowkie a better unlinkability posture than a same-signer send/receive flow, but it is still not the same thing as full transaction anonymity for native SOL.

---

## 7. Toolchain and supported denominations

### Supported denominations

Current pool tiers:

- `10.0 SOL`
- `5.0 SOL`
- `2.0 SOL`
- `1.0 SOL`
- `0.5 SOL`
- `0.1 SOL`
- `0.05 SOL`
- `0.01 SOL`

### Toolchain versions

| Tool                      | Version    |
| ------------------------- | ---------- |
| arcium CLI                | `0.6.3`    |
| `arcium-anchor`           | `0.9.5`    |
| `anchor-lang`             | `0.32.1`   |
| `anchor-spl`              | `0.32.1`   |
| `@arcium-hq/client`       | `^0.9.5`   |
| `@coral-xyz/anchor`       | `^0.32.0`  |
| Solana CLI                | `2.3.0`    |
| Node.js                   | `20.18.0`  |

### Relation to Arcium C-SPL

Lowkie already uses the same `Enc<Mxe>` account-update pattern that C-SPL will standardize. When Arcium ships formal confidential token accounts, the main swap is expected to be the custody layer, not the confidential compute pattern.

---

## 8. Quick start — localnet

```bash
# Terminal 1
arcium localnet

# Terminal 2
cp .env.example .env
yarn install
arcium build

# Static checks
yarn -s ci:check

# Integration tests against the running localnet
export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET=$HOME/.config/solana/id.json
export ARCIUM_CLUSTER_OFFSET=0
yarn -s test

# One-command local validation
yarn -s local:validate
```

Deploy and bootstrap:

```bash
arcium deploy \
  --program-name lowkie_pool \
  --program-keypair target/deploy/lowkie_pool-keypair.json \
  --keypair-path ~/.config/solana/id.json \
  --cluster-offset 0 \
  --recovery-set-size 4 \
  --rpc-url localnet

# Update Anchor.toml, Arcium.toml, and .env with the printed program ID.

yarn bootstrap:program
```

Useful commands after bootstrap:

```bash
yarn backend
yarn test-frontend
yarn send
yarn relay
yarn check:pool
```

Local defaults in `.env`:

```bash
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
ARCIUM_CLUSTER_OFFSET=0
ANCHOR_WALLET=~/.config/solana/id.json
RELAYER_KEYPAIR_PATH=~/.config/solana/relayer.json
```

Production safety defaults matter even on devnet-style demos:

- `RELAYER_KEYPAIR_PATH` must differ from `SENDER_WALLET`
- `LOWKIE_AUTO_COMPACT_REGISTRY` is localnet-only unless you explicitly opt into unsafe demo behavior
- plaintext note-file export is disabled unless you opt into it

---

## 9. Backend API, SDK, and test frontend

### Start the backend

```bash
yarn backend
```

### Start the demo frontend

```bash
yarn test-frontend
```

If the frontend runs on a different origin:

```bash
LOWKIE_API_BASE=http://127.0.0.1:5174
```

### API modes

#### `POST /api/send`

Uses a backend-held sender wallet. Good for operator-controlled flows and testing.

```json
{
  "recipient": "<base58-pubkey>",
  "amountSol": 0.1,
  "delayMs": 15000
}
```

#### `POST /api/build-deposits`

Builds unsigned deposit transactions for browser wallets.

```json
{
  "sender": "<base58-pubkey>",
  "recipient": "<base58-pubkey>",
  "amountSol": 0.1,
  "delayMs": 15000
}
```

#### `POST /api/submit-deposits`

Accepts the signed deposit transactions and then triggers local or remote relayer execution.

```json
{
  "recoveryId": "lowkie-...",
  "signedTransactionsBase64": ["..."]
}
```

### API endpoints

- `GET /api/health`
- `GET /api/relayer/health`
- `GET /api/denominations`
- `GET /api/pool/status`
- `POST /api/build-deposits`
- `POST /api/submit-deposits`
- `POST /api/send`
- `GET /api/recoverable`
- `POST /api/recover`
- `POST /api/relay`

### Remote relayer mode

Set these on the backend host to forward relay execution elsewhere:

```bash
LOWKIE_RELAYER_URL=https://relayer.example.com
LOWKIE_RELAYER_AUTH_TOKEN=<shared-secret>
LOWKIE_RELAYER_TIMEOUT_MS=30000
```

If `LOWKIE_RELAYER_URL` is unset, the backend expects `RELAYER_KEYPAIR_PATH` and executes relay locally.

### Recommended internet-facing backend env

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

Use [packages/lowkie-sdk/src/index.ts](./packages/lowkie-sdk/src/index.ts) as the typed client for frontend integration.

---

## 10. Deploying to devnet

Devnet uses **cluster offset `456`**.

```bash
# 1. Fund your deployer wallet
solana airdrop 2 <your-pubkey> --url devnet

# 2. Deploy
arcium deploy \
  --cluster-offset 456 \
  --recovery-set-size 4 \
  --keypair-path ~/.config/solana/id.json \
  --rpc-url <your-helius-or-quicknode-devnet-rpc>

# 3. Update config
# - Arcium.toml [clusters.devnet] offset = 456
# - Anchor.toml [provider] cluster = "devnet"
# - .env LOWKIE_PROGRAM_ID=<deployed-program-id>
# - .env ARCIUM_CLUSTER_OFFSET=456

# 4. Bootstrap protocol config, comp defs, and all pools
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ARCIUM_CLUSTER_OFFSET=456 \
LOWKIE_PROGRAM_ID=<deployed-program-id> \
yarn bootstrap:program
```

For larger circuit artifacts, you can host the `build/*.arcis` files off-chain and bootstrap against those URLs instead of paying rent for full on-chain uploads.

```bash
LOWKIE_CIRCUIT_SOURCE_MODE=offchain
LOWKIE_OFFCHAIN_CIRCUIT_BASE_URL=https://cdn.example.com/lowkie/
```

Validation:

```bash
arcium test --cluster devnet
yarn devnet:test
yarn check:pool
```

If deployment stops after a partial success:

```bash
arcium deploy --cluster-offset 456 ... --resume
```

---

## 11. Deploying to mainnet-alpha

Mainnet-alpha uses **cluster offset `2026`**.

```bash
arcium deploy \
  --cluster-offset 2026 \
  --recovery-set-size 4 \
  --keypair-path ~/.config/solana/id.json \
  --rpc-url <your-mainnet-rpc>

# Arcium.toml [clusters.mainnet] offset = 2026
# .env ARCIUM_CLUSTER_OFFSET=2026
# .env LOWKIE_PROGRAM_ID=<deployed-program-id>

yarn bootstrap:program
```

For any non-loopback backend or relayer deployment:

- require bearer auth
- restrict allowed origins
- disable unsafe local-demo flags
- keep sender and relayer keypairs separate

---

## 12. Project structure

```text
lowkie/
├── .github/
│   ├── copilot-instructions.md
│   └── skills/solana-dev/
├── apps/
│   ├── backend/
│   │   ├── server.ts
│   │   ├── lib/security.ts
│   │   ├── scripts/
│   │   │   ├── bootstrap-program.ts
│   │   │   ├── check-pool.ts
│   │   │   └── local-validate.ts
│   │   └── src/core/
│   │       ├── deposit.ts
│   │       ├── send.ts
│   │       ├── relayer.ts
│   │       ├── relayProtocol.ts
│   │       ├── readiness.ts
│   │       ├── recover.ts
│   │       ├── programContext.ts
│   │       ├── runtimeSafety.ts
│   │       └── utils.ts
│   └── test-frontend/
│       ├── server.ts
│       └── frontend/
├── encrypted-ixs/
│   └── circuits.rs
├── packages/
│   └── lowkie-sdk/
│       └── src/index.ts
├── programs/
│   └── lowkie_pool/
│       └── src/lib.rs
├── tests/
│   ├── lowkie.ts
│   ├── relayProtocol.unit.ts
│   ├── runtimeSafety.unit.ts
│   └── frontendBridgeSecurity.unit.ts
└── README.md / ARCHITECTURE.md / TECHNICAL_SPEC.md
```

---

## 13. For LLMs expanding this codebase

### Critical invariants

**`ArgBuilder` order must match the circuit parameter order exactly.**

For `Enc<Shared, T>`: `x25519_pubkey` + `plaintext_u128(nonce)` + encrypted payload.

For `Enc<Mxe, T>`: `plaintext_u128(nonce)` + encrypted payload.

**Callback custom account order must match the `CallbackAccount` slice exactly.**

This is especially important for `withdraw_from_pool_callback`, which expects:

```text
note, nullifier_record, pool, nullifier_registry, vault, recipient
```

**Full encrypted struct layouts must be preserved.**

`withdraw_from_pool` must receive the complete `DepositOutput` and `WithdrawOutput` ciphertext arrays. Re-indexing fields changes CTR positions and breaks decryption.

**Nonces always travel with their ciphertexts.**

`balance_nonce`, `amount_nonce`, and `registry_nonce` must be read and passed together with the stored ciphertexts.

**`recipient_hash` uses `withdraw_key`, not `note_secret`.**

Recipient verification is `SHA256(withdraw_key || recipient_pubkey)`. The note hash remains `SHA256(note_secret || recipient || amount)`.

**Replay protection is split across two layers.**

- the encrypted nullifier registry inside MXE state
- the persistent `NullifierRecord` PDA on-chain

**Registry compaction is maintenance-authority gated.**

`compact_registry` requires `ProtocolConfig.maintenance_authority`.

---

## Licence

MIT