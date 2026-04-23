# Lowkie — Architecture

> Privacy-preserving SOL transfers on Solana using Arcium MXE encrypted state.

---

## Table of Contents

1. [Overview](#overview)
2. [System Components](#system-components)
3. [End-to-End Protocol Flow](#end-to-end-protocol-flow)
4. [On-Chain Account Model](#on-chain-account-model)
5. [Arcium MPC Circuits](#arcium-mpc-circuits)
6. [Client-Side Components](#client-side-components)
7. [Privacy Model](#privacy-model)
8. [Denomination & Note Splitting](#denomination--note-splitting)
9. [Nullifier Registry & Compaction](#nullifier-registry--compaction)
10. [CipherOwl Compliance Integration](#cipherowl-compliance-integration)
11. [Security Considerations](#security-considerations)
12. [Project Structure](#project-structure)
13. [Known Limitations](#known-limitations)
14. [Toolchain](#toolchain)

---

## Overview

Lowkie is a pool-and-spend-note privacy protocol. Users deposit SOL into a shared
vault; the pool's internal accounting is maintained as `Enc<Mxe, u64>` ciphertexts
that only the Arcium MPC cluster can decrypt. A separate relayer keypair signs the
withdrawal transaction, breaking the on-chain link between sender and recipient.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        LOWKIE PROTOCOL FLOW                            │
│                                                                        │
│  SENDER                    ARCIUM MPC                    RECIPIENT     │
│    │                         CLUSTER                         │         │
│    │  1. Encrypt amount        │                             │         │
│    │  2. Compute note_hash     │                             │         │
│    │  3. SOL → vault           │                             │         │
│    │  4. Queue deposit MPC ───►│                             │         │
│    │                           │ 5. Compute on secret shares │         │
│    │                           │ 6. Callback:                │         │
│    │                           │    • Update pool Enc<Mxe>   │         │
│    │                           │    • Set note Enc<Mxe>      │         │
│    │                           │                             │         │
│    │  ~~~ randomised delay ~~~ │                             │         │
│    │                           │                             │         │
│  RELAYER (different key)       │                             │         │
│    │  7. Prove SHA256 preimage │                             │         │
│    │  8. Queue withdraw MPC ──►│                             │         │
│    │                           │ 9. Compute new pool balance │         │
│    │                           │10. Callback:                │         │
│    │                           │    • SOL vault → recipient ─┼────►│   │
│    │                           │    • Update pool Enc<Mxe>   │         │
│    │                           │    • Mark note Withdrawn    │         │
│    │                           │    • Close spent note PDA   │         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## System Components

Lowkie is composed of four distinct layers, each with a well-defined boundary:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          SYSTEM COMPONENT MAP                               │
│                                                                              │
│  ┌─────────────────────┐   ┌──────────────────────┐   ┌──────────────────┐  │
│  │     FRONTEND        │   │   FRONTEND BRIDGE     │   │    RELAYER CLI   │  │
│  │  frontend/index.html│──►│ scripts/frontend-     │──►│  client/send.ts  │  │
│  │  frontend/app.js    │   │   server.ts           │   │  client/relayer.ts│  │
│  │  (browser)          │   │  HTTP :5177           │   │                  │  │
│  └─────────────────────┘   └──────────────────────┘   └────────┬─────────┘  │
│                                                                 │            │
│            ┌────────────────────────────────────────────────────┘            │
│            ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                     SOLANA BLOCKCHAIN (Devnet / Mainnet)                │ │
│  │                                                                         │ │
│  │  ┌──────────────────────────────────────────────────────────────────┐  │ │
│  │  │          lowkie_pool PROGRAM (2mnSg2aKoKqz...)                   │  │ │
│  │  │                                                                  │  │ │
│  │  │  Instructions:       PDA Accounts (per denomination):            │  │ │
│  │  │  ─ init_pool         ┌─────────────┐  ┌──────────────┐           │  │ │
│  │  │  ─ deposit           │  PoolState  │  │ VaultAccount │           │  │ │
│  │  │  ─ withdraw          │ [pool, dnom]│  │[vault, dnom] │           │  │ │
│  │  │  ─ *_callback x3     └─────────────┘  └──────────────┘           │  │ │
│  │  │  ─ compact_registry  ┌─────────────────────────────────┐          │  │ │
│  │  │                      │    NullifierRegistryState        │          │  │ │
│  │  │                      │    [nullifier_registry, dnom]    │          │  │ │
│  │  │                      └─────────────────────────────────┘          │  │ │
│  │  │                      ┌──────────────────┐                          │  │ │
│  │  │                      │   NoteAccount    │ (one per transfer note)  │  │ │
│  │  │                      │  [note, hash]    │                          │  │ │
│  │  │                      └──────────────────┘                          │  │ │
│  │  └──────────────────────────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│            │                                                                 │
│            │ Queue MPC computation                                           │
│            ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                  ARCIUM MPC CLUSTER (Cerberus Protocol)                 │ │
│  │                                                                         │ │
│  │  Cluster offset 456 (devnet) / 2026 (mainnet)                          │ │
│  │  Minimum 2 ARX nodes — threshold honest-majority secret sharing        │ │
│  │                                                                         │ │
│  │  Circuits:                                                              │ │
│  │  ─ init_pool_balance       (initialise Enc<Mxe, 0>)                    │ │
│  │  ─ deposit_to_pool         (pool + deposit, re-encrypt note)            │ │
│  │  ─ withdraw_from_pool      (pool − note amount)                        │ │
│  │  ─ compact_registry        (compaction of spent nullifiers)             │ │
│  │                                                                         │ │
│  │  ARX Node 0 ──┐                                                        │ │
│  │  ARX Node 1 ──┼── Secret-share compute ──► Signed callback tx          │ │
│  │               │   (Cerberus)               submitted back on-chain      │ │
│  └───────────────┴────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                  CIPHEROWL COMPLIANCE LAYER                            │ │
│  │                                                                         │ │
│  │  Pre-deposit:  screen sender + recipient addresses                     │ │
│  │  Pre-withdraw: screen recipient again at withdrawal time               │ │
│  │  API: https://svc.cipherowl.ai/api/screen/v1/chains/solana/addresses/  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Layer responsibilities

| Layer            | Files                             | Responsibility                                                              |
| ---------------- | --------------------------------- | --------------------------------------------------------------------------- |
| Frontend UI      | `frontend/`                       | Browser form — collect recipient + amount, display result                   |
| Frontend Bridge  | `scripts/frontend-server.ts`      | HTTP API gateway, request serialisation, rate-limiting, CipherOwl screening |
| Client SDK       | `client/send.ts`, `relayer.ts`    | Build & submit Solana transactions; orchestrate deposit → MPC → withdraw    |
| On-chain Program | `programs/lowkie_pool/src/lib.rs` | Anchor program; owns all PDAs; queues and receives MPC callbacks            |
| Arcium MPC       | `encrypted-ixs/circuits.rs`       | Confidential arithmetic on encrypted SOL amounts                            |
| Compliance       | CipherOwl SRR API                 | Sanctions & risk screening of sender/recipient before any transfer          |

---

## End-to-End Protocol Flow

This section walks through every step in exact order — from the moment a user submits
an amount in the browser to the moment lamports appear in the recipient's wallet.

### Phase 0 — Bootstrap (one-time, per denomination)

```
Operator runs: yarn bootstrap:program
                         │
                         ├─ 1. Register init_pool_balance comp-def on-chain
                         ├─ 2. Register deposit_to_pool comp-def on-chain
                         ├─ 3. Register withdraw_from_pool comp-def on-chain
                         ├─ 4. Register compact_registry comp-def on-chain
                         │
                         └─ For each denomination (1 SOL / 0.5 SOL / 0.1 SOL / 0.05 SOL / 0.01 SOL):
                              ├─ 5. init_pool instruction
                              │      ├─ Creates PoolState PDA  [pool, denom_le_bytes]
                              │      ├─ Creates VaultAccount PDA [vault, denom_le_bytes]
                              │      ├─ Creates NullifierRegistryState PDA
                              │      └─ Queues init_pool_balance MPC
                              │
                              └─ 6. init_pool_balance_callback (async, from Arcium cluster)
                                     └─ PoolState.encrypted_balance ← Enc<Mxe, 0>
```

### Phase 1 — Deposit

```
User browser           Frontend Bridge           client/send.ts         Solana
─────────────         ─────────────────         ──────────────         ──────
POST /api/send
  { recipient,    ──► 1. CipherOwl screen
    amountSol,         sender + recipient
    delayMs }          (OFAC / sanctions)
                       ↓ if clean
                   2. Acquire serial mutex ──► 3. decomposeIntoDenominations()
                                                   e.g. 1.11 SOL →
                                                   [1 SOL, 0.5 SOL, 0.1 SOL, 0.05 SOL, 0.01 SOL]
                                                   (shuffled, random order)
                                                   ↓
                                               For each sub-note:
                                               4. Generate 32-byte noteSecret
                                               5. compute note_hash =
                                                  SHA256(secret ‖ recipient ‖ amount_le)
                                               6. compute recipient_hash =
                                                  SHA256(secret ‖ recipient_pubkey)
                                               7. Encrypt amount under MXE pubkey:
                                                  Enc<Shared, u64>(amount_lamports)
                                               8. Build deposit tx:
                                                  ├─ system_program::transfer(
                                                  │    sender → vault, amount)  ◄ CPI logged
                                                  ├─ Create NoteAccount PDA
                                                  │    note_hash, recipient_hash,
                                                  │    lamports_for_transfer = amount
                                                  │    status = PendingMpc
                                                  └─ Queue deposit_to_pool MPC
                                               9. Sign + send (senderKp)
                                                    ↓ confirmed
                                              10. Arcium cluster runs circuit:
                                                  deposit_to_pool(
                                                    transfer: Enc<Shared, u64>,
                                                    pool:     Enc<Mxe, u64>)
                                                  → DepositOutput {
                                                      new_pool_balance: Enc<Mxe,u64>,
                                                      note_amount:      Enc<Mxe,u64>
                                                    }
                                              11. deposit_to_pool_callback tx
                                                  (signed by Arcium, not sender)
                                                  ├─ PoolState.encrypted_balance ← [0]
                                                  ├─ NoteAccount.encrypted_amount ← [1]
                                                  └─ NoteAccount.status ← Ready
                                              ──────────────────────────────────────
                                              Repeat for each denomination sub-note,
                                              with DEPOSIT_SPREAD_DELAY_MS gap (2 s)
```

### Phase 2 — Relayed Withdrawal

```
client/send.ts               client/relayer.ts              Solana
──────────────               ─────────────────              ──────
After all deposits confirmed:
await sleep(delayMs ± 30% jitter)    ← timing decorrelation
                         │
                    lowkieWithdraw(
                      note, relayerProvider,
                      relayerProgram)
                         │
                         ├─ 1. Check nullifier registry capacity
                         │      if full → compact_registry MPC first
                         │               (see Phase 3)
                         │
                         ├─ 2. Build withdraw tx (signed by RELAYER keypair):
                         │      ├─ Provide note_secret (proves preimage)
                         │      ├─ On-chain verify:
                         │      │    SHA256(secret ‖ recipient ‖ stored_amount)
                         │      │                == note_hash  ✓
                         │      │    SHA256(secret ‖ recipient.key())
                         │      │                == recipient_hash  ✓
                         │      ├─ NoteAccount.status ← PendingMpc
                         │      └─ Queue withdraw_from_pool MPC
                         │
                         ├─ 3. Arcium cluster runs circuit:
                         │      withdraw_from_pool(
                         │        note: Enc<Mxe,u64>,  pool: Enc<Mxe,u64>)
                         │      → Enc<Mxe,u64>  (new balance = pool − note)
                         │
                         └─ 4. withdraw_from_pool_callback
                                (signed by Arcium, not relayer)
                                ├─ PoolState.encrypted_balance ← new ciphertext
                                ├─ NoteAccount.status ← Withdrawn
                                ├─ NoteAccount.lamports_for_transfer ← 0
                                ├─ vault.lamports  -= amount   ◄ NO CPI log!
                                └─ recipient.lamports += amount ◄ NO CPI log!
```

### Phase 3 — Registry Compaction (automatic when full)

The `NullifierRegistryState` holds a bounded array of encrypted nullifiers that
prevent double-spending. When the capacity (currently 4 slots per denomination) is
exhausted the relayer automatically triggers compaction before the next withdrawal:

```
relayer detects registry full
           │
           ├─ 1. Queue compact_registry MPC
           │      Input:  current Enc<Mxe, [nullifier×N]>
           │      Output: Enc<Mxe, []>  (empty — spent notes already closed)
           │
           └─ 2. compact_registry_callback
                    NullifierRegistryState.encrypted_nullifiers ← Enc<Mxe, []>
                    (all spent NoteAccount PDAs were already closed at withdrawal)
```

---

## On-Chain Account Model

The Lowkie program is NOT a monolithic vault. Each denomination has its own
independent triple of PDAs. The program ID acts purely as a controller; all state
lives in these accounts.

```
PROGRAM: lowkie_pool (2mnSg2aKoKqzEUHPQTGwnKFnyjML8eSWefsinrfN4zfQ)
  │
  ├── PoolState          PDA seeds: ["pool",  denomination_le_bytes(8)]
  │                      One per denomination
  │
  ├── VaultAccount       PDA seeds: ["vault", denomination_le_bytes(8)]
  │                      One per denomination — holds actual SOL lamports
  │                      Program-owned → direct lamport manipulation (no CPI)
  │
  ├── NullifierRegistry  PDA seeds: ["nullifier_registry", denomination_le_bytes(8)]
  │                      One per denomination — stores encrypted nullifiers
  │
  └── NoteAccount        PDA seeds: ["note", note_hash(32)]
                         One per active transfer note — closed after withdrawal
```

### PoolState — `[b"pool", denomination_le_bytes]`

Stores the encrypted running balance for one denomination tier.

```
┌──────────────────────────────┬────────────┬──────────────────────────────────────┐
│ Field                        │ Type       │ Description                          │
├──────────────────────────────┼────────────┼──────────────────────────────────────┤
│ encrypted_balance            │ [u8; 32]   │ Enc<Mxe, u64> — encrypted SOL total  │
│ balance_nonce                │ u128       │ Nonce for passing ciphertext to MPC   │
│ denomination_lamports        │ u64        │ This pool's denomination (lamports)  │
│ is_initialized               │ bool       │ Set after init_pool_balance callback  │
│ bump                         │ u8         │ PDA canonical bump                   │
│ vault_bump                   │ u8         │ Vault PDA canonical bump             │
└──────────────────────────────┴────────────┴──────────────────────────────────────┘
  Total space: 8 (discriminator) + 32 + 16 + 8 + 1 + 1 + 1 = 67 bytes
```

### VaultAccount — `[b"vault", denomination_le_bytes]`

The SOL custodian. Minimal data; all value is in the account's native lamports.

```
┌──────────────────────────────┬────────────┬──────────────────────────────────────┐
│ Field                        │ Type       │ Description                          │
├──────────────────────────────┼────────────┼──────────────────────────────────────┤
│ bump                         │ u8         │ PDA canonical bump                   │
└──────────────────────────────┴────────────┴──────────────────────────────────────┘
  Total space: 8 (discriminator) + 1 = 9 bytes
```

> Because VaultAccount is **program-owned** (not System Program–owned) the
> withdraw callback can write directly to `vault_info.try_borrow_mut_lamports()`
> without any `system_program::transfer` CPI — leaving no inner-instruction log.

### NullifierRegistryState — `[b"nullifier_registry", denomination_le_bytes]`

Tracks spent notes per denomination to prevent double-spends.

```
┌──────────────────────────────┬────────────────┬────────────────────────────────┐
│ Field                        │ Type           │ Description                    │
├──────────────────────────────┼────────────────┼────────────────────────────────┤
│ encrypted_nullifiers         │ [[u8;32]; W×4] │ Enc<Mxe> array (W words each  │
│                              │                │ encoding up to 4 nullifiers)   │
│ bump                         │ u8             │ PDA canonical bump             │
└──────────────────────────────┴────────────────┴────────────────────────────────┘
  Current capacity: 4 nullifiers (W=1, tuned to avoid MPC timeout on devnet)
```

### NoteAccount — `[b"note", note_hash(32)]`

Represents a single transfer note. Created at deposit, closed at withdrawal.

```
┌──────────────────────────────┬────────────┬──────────────────────────────────────┐
│ Field                        │ Type       │ Description                          │
├──────────────────────────────┼────────────┼──────────────────────────────────────┤
│ note_hash                    │ [u8; 32]   │ SHA256(secret ‖ recipient ‖ amount)  │
│ status                       │ enum       │ PendingMpc | Ready | Withdrawn       │
│ recipient_hash               │ [u8; 32]   │ SHA256(secret ‖ recipient_pubkey)    │
│ encrypted_amount             │ [u8; 32]   │ Enc<Mxe, u64> — set by callback     │
│ amount_nonce                 │ u128       │ Nonce for encrypted_amount           │
│ lamports_for_transfer        │ u64        │ Plaintext amount (zeroed post-use)   │
│ bump                         │ u8         │ PDA canonical bump                   │
└──────────────────────────────┴────────────┴──────────────────────────────────────┘
  Total space: 8 + 32 + 1 + 32 + 32 + 16 + 8 + 1 = 130 bytes
```

> **Recipient privacy:** `recipient_hash = SHA256(noteSecret ‖ recipient_pubkey)`.
> The actual recipient pubkey is never stored in the NoteAccount — block explorers
> see only an opaque 32-byte hash until the withdrawal transaction supplies it for
> on-chain verification.

### Account Lifecycle Diagram

```
                        ┌──────────────────────────┐
                        │   NoteAccount created    │
                        │   status: PendingMpc     │
                        │   lamports_for_transfer  │
                        │   recipient_hash         │
                        └────────────┬─────────────┘
                                     │ deposit_to_pool_callback
                                     ▼
                        ┌──────────────────────────┐
                        │   status: Ready          │
                        │   encrypted_amount set   │
                        └────────────┬─────────────┘
                                     │ withdraw (preimage provided)
                                     ▼
                        ┌──────────────────────────┐
                        │   status: PendingMpc     │
                        └────────────┬─────────────┘
                                     │ withdraw_from_pool_callback
                                     ▼
                        ┌──────────────────────────┐
                        │   status: Withdrawn      │
                        │   lamports_for_transfer  │◄──── zeroed out
                        └────────────┬─────────────┘
                                     │ compact_spent_note (relayer)
                                     ▼
                               [Account closed]
                          (lamports returned to relayer)
```

---

## Arcium MPC Circuits

All circuits live in `encrypted-ixs/circuits.rs`. They are written in the Arcis
DSL and compiled to circuit definitions registered on-chain. The Arcium cluster
executes them using Cerberus threshold secret-sharing — no individual ARX node
ever holds plaintext values.

### Circuit interaction diagram

```
          ┌──────────────────────────────────────────────────────────┐
          │                 ARCIUM MPC EXECUTION                     │
          │                                                          │
          │  On-chain queue tx                                       │
          │    ├─ Passes Enc<Shared,u64> inputs (shared-key cipher)  │
          │    └─ References comp-def account (registered circuit)   │
          │                       │                                  │
          │                       ▼                                  │
          │  ARX Node 0 ──┐                                          │
          │  ARX Node 1 ──┤  Cerberus 2-of-2 secret-share compute   │
          │               │  (threshold: 1 honest node sufficient)   │
          │               │                                          │
          │               └──► Signed callback tx sent back on-chain │
          │                    (Arcium signer, not sender/relayer)   │
          └──────────────────────────────────────────────────────────┘
```

### `init_pool_balance`

```
Input:  dummy   Enc<Shared, u64>   (Arcis requires ≥1 input; value discarded)
Output: balance Enc<Mxe, u64>      (encrypts 0 — pool starting balance)
```

Written-back to: `PoolState.encrypted_balance`

### `deposit_to_pool`

```
Input:  transfer Enc<Shared, u64>   sender-encrypted deposit amount
        pool     Enc<Mxe, u64>      current encrypted pool balance
                                    (read from PoolState, passed via pool_snapshot_ct)
Output: Enc<Mxe, DepositOutput>
          .new_pool_balance          Enc<Mxe, u64>  pool + transfer
          .note_amount               Enc<Mxe, u64>  transfer, re-encrypted under MXE
```

Written-back to:

- `PoolState.encrypted_balance` → `ciphertexts[0]`
- `NoteAccount.encrypted_amount` → `ciphertexts[1]`

> The full encrypted pool struct (`pool_snapshot_ct`) is passed into the circuit
> rather than re-derived to avoid CTR-mode position issues.

### `withdraw_from_pool`

```
Input:  note  Enc<Mxe, u64>    note's encrypted amount (from NoteAccount)
        pool  Enc<Mxe, u64>    current encrypted pool balance
Output: Enc<Mxe, u64>          new balance = pool − note
```

Written-back to: `PoolState.encrypted_balance`

### `compact_registry`

```
Input:  registry Enc<Mxe, [nullifiers]>   current encrypted nullifier array
Output: Enc<Mxe, []>                      empty encrypted array (all spent)
```

Written-back to: `NullifierRegistryState.encrypted_nullifiers`

---

## Client-Side Components

### `client/constants.ts`

Single source of truth for all shared values. Key constants:

```typescript
export const SUPPORTED_DENOMINATION_LAMPORTS = [
  1_000_000_000n, // 1.0 SOL
  500_000_000n, // 0.5 SOL
  100_000_000n, // 0.1 SOL
  50_000_000n, // 0.05 SOL
  10_000_000n, // 0.01 SOL
] as const;

export const CLUSTER_OFFSETS = {
  localnet: 0,
  devnet: 456,
  mainnet: 2026,
} as const;
```

### `client/arciumAccounts.ts`

PDA derivation helpers. All seeds use 8-byte little-endian denomination encoding:

```typescript
// [b"pool", denomination_lamports_le_8_bytes]
derivePoolPda(programId, denominationLamports);

// [b"vault", denomination_lamports_le_8_bytes]
deriveVaultPda(programId, denominationLamports);

// [b"nullifier_registry", denomination_lamports_le_8_bytes]
deriveNullifierRegistryPda(programId, denominationLamports);

// [b"note", note_hash_32_bytes]
deriveNotePda(programId, noteHash);
```

### `client/utils.ts` — Note splitting

`decomposeIntoDenominations()` greedy-decomposes any SOL amount into the smallest
number of fixed-denomination notes, then shuffles the result:

```
Input:  amountLamports = 1_110_000_000n  (1.11 SOL)
  denominations  = [1e9, 5e8, 1e8, 5e7, 1e7]

Step 1: 1_110_000_000 ÷ 1_000_000_000 = 1 note  → remaining 110_000_000
Step 2:   110_000_000 ÷   100_000_000 = 1 note  → remaining  10_000_000
Step 3:    10_000_000 ÷    10_000_000 = 1 note  → remaining           0

Output (shuffled): [100_000_000n, 1_000_000_000n, 10_000_000n]
```

The shuffle means a 1.11 SOL transfer generates three on-chain deposits in random
order, decorrelating them from the withdrawal order.

### `client/send.ts` — Sender orchestration

Key privacy design in fee payer separation:

```typescript
// Sender's provider — only used for deposit txs
const senderProvider = new AnchorProvider(conn, senderWallet, opts);
const senderProgram  = new Program(IDL, PROG, senderProvider);

// Relayer's provider — used exclusively for withdraw txs
// Critical: prevents sender appearing in recipient's explorer history
const relayerProvider = new AnchorProvider(conn, relayerWallet, opts);
const relayerProgram  = new Program(IDL, PROG, relayerProvider);

await lowkieWithdraw(note, relayerKp, relayerProgram, ...);
//                                    ^^^^^^^^^^^^^^
//                   relayer is fee payer, NOT sender
```

### `client/relayer.ts` — Withdrawal execution

The relayer signs and submits all withdrawal transactions. It never learns the
plaintext amount — the note hash serves as the only secret-knowledge proof.

---

## Privacy Model

### What is hidden

| Data                    | Protection                                                         |
| ----------------------- | ------------------------------------------------------------------ |
| Pool running balance    | `Enc<Mxe, u64>` — 32 opaque bytes on-chain                         |
| Individual note amounts | `Enc<Mxe, u64>` — MPC cluster-only decryption                      |
| Deposit↔Withdraw link   | Different signers + SHA256 preimage resistance                     |
| Recipient identity      | `SHA256(secret ∥ recipient)` — hash only on-chain until withdrawal |
| Amount correlation      | Client-side note splitting (2–4 random sub-amounts per deposit)    |

### What is visible

| Data                    | Why                                                                 |
| ----------------------- | ------------------------------------------------------------------- |
| Sender wallet           | Signs the deposit transaction                                       |
| SOL deposit sub-amounts | Native SOL `system_program::transfer` CPI (split into random parts) |
| Relayer wallet          | Signs the withdraw transaction                                      |

> **Note:** Withdrawal amounts do NOT appear in transaction instruction data or
> inner instruction logs. The vault uses direct lamport manipulation. The amount
> can only be derived by comparing pre/post balance snapshots — requiring custom
> tooling, not standard block explorers.
>
> **Recipient** is stored only as `SHA256(note_secret ∥ recipient_pubkey)` on the
> NoteAccount. The actual pubkey is invisible until the withdrawal transaction
> provides it for on-chain verification.

### Amount privacy by operation

| Operation    | Instruction data                     | CPI inner logs                       | Balance-diff analysis               |
| ------------ | ------------------------------------ | ------------------------------------ | ----------------------------------- |
| **Deposit**  | ⚠️ `amount_lamports` visible (split) | ⚠️ `system_program::transfer` logged | ⚠️ Observable                       |
| **Withdraw** | ✅ No amount                         | ✅ No transfer CPI                   | ⚠️ Observable (custom tooling only) |

The **deposit** instruction includes `amount_lamports` because the native SOL
`system_program::transfer` CPI requires a plaintext `u64`. Client-side note
splitting decorrelates these amounts: a 3.7 SOL transfer might appear as
three unrelated deposits of [1.2, 0.8, 1.7] SOL.

The **withdraw** instruction contains **NO plaintext amount** anywhere:

- Not in instruction data (reads from NoteAccount set at deposit time)
- Not in inner instruction logs (direct lamport manipulation, no CPI)
- `lamports_for_transfer` is zeroed out immediately after the transfer

### Comparison with other privacy approaches

| Privacy Feature             | Normal SOL |  Tornado-style  |            **Lowkie**            |
| --------------------------- | :--------: | :-------------: | :------------------------------: |
| Withdraw amount hidden      |     ✗      | ✓ (fixed denom) |        **✓** (no CPI log)        |
| Recipient hidden at deposit |     ✗      |        ✗        |       **✓** (SHA256 hash)        |
| Deposit↔Withdraw unlinkable |     ✗      |        ✓        | **✓** (separate signer + timing) |
| Amount decorrelation        |     ✗      | ✓ (fixed denom) |      **✓** (random splits)       |
| On-chain state encrypted    |     ✗      |     Partial     |         **✓** (Enc<Mxe>)         |
| Regulatory compliant        |    N/A     |        ✗        |      **✓** (MPC auditable)       |

> **Path to full encryption:** When Solana re-enables the ZK ElGamal Proof
> Program (currently disabled for security audit), the native SOL custody
> layer can be replaced with C-SPL confidential tokens. The MPC circuits and
> note commitment pattern remain identical.

---

## Denomination & Note Splitting

Five independent denomination pools operate in parallel. The client's greedy
decomposition ensures that any SOL amount expressible in multiples of 0.01 SOL can
be sent in at most one pass:

```
Denominations: [1 SOL,  0.5 SOL,  0.1 SOL,  0.05 SOL,  0.01 SOL]

Examples:
  0.01 SOL → [0.01]
  0.11 SOL → [0.1, 0.01]          (shuffled: [0.01, 0.1])
  0.55 SOL → [0.5, 0.05]          (shuffled: [0.05, 0.5])
  1.11 SOL → [1, 0.1, 0.01]       (shuffled: [0.1, 1, 0.01])
  3.37 SOL → [1, 1, 1, 0.1, 0.1,
              0.1, 0.05, 0.01,
              0.01]
```

Each sub-note produces:

- An independent deposit transaction (with `DEPOSIT_SPREAD_DELAY_MS` gap)
- An independent `NoteAccount` PDA
- An independent MPC computation

This means an observer on-chain sees multiple unrelated-looking deposits of
standard denominations, with no easily machine-detectable grouping.

---

## Nullifier Registry & Compaction

Each denomination pool has a `NullifierRegistryState` PDA that records encrypted
identifiers for spent notes. This prevents double-spends without revealing which
notes have been spent.

```
Registry lifecycle (per denomination):

New registry (empty)               Full registry
┌─────────────────────┐            ┌─────────────────────┐
│ slot 0: empty       │            │ slot 0: spent_note_A │
│ slot 1: empty       │  ──────►   │ slot 1: spent_note_B │
│ slot 2: empty       │            │ slot 2: spent_note_C │
│ slot 3: empty       │            │ slot 3: spent_note_D │◄── full
└─────────────────────┘            └─────────────────────┘
                                              │
                                    compact_registry MPC
                                              │
                                              ▼
                                   ┌─────────────────────┐
                                   │ slot 0: empty       │◄── reset
                                   │ slot 1: empty       │    (spent PDAs
                                   │ slot 2: empty       │     already closed)
                                   │ slot 3: empty       │
                                   └─────────────────────┘
```

The registry capacity (currently 4 slots on devnet) is intentionally small to
avoid MPC timeout. Production deployments should increase this value and tune the
Arcium cluster compute budget accordingly.

---

### What is hidden

| Data                    | Protection                                                         |
| ----------------------- | ------------------------------------------------------------------ |
| Pool running balance    | `Enc<Mxe, u64>` — 32 opaque bytes on-chain                         |
| Individual note amounts | `Enc<Mxe, u64>` — MPC cluster-only decryption                      |
| Deposit↔Withdraw link   | Different signers + SHA256 preimage resistance                     |
| Recipient identity      | `SHA256(secret ∥ recipient)` — hash only on-chain until withdrawal |
| Amount correlation      | Client-side note splitting (2–4 random sub-amounts per deposit)    |

### What is visible

| Data                    | Why                                                                 |
| ----------------------- | ------------------------------------------------------------------- |
| Sender wallet           | Signs the deposit transaction                                       |
| SOL deposit sub-amounts | Native SOL `system_program::transfer` CPI (split into random parts) |
| Relayer wallet          | Signs the withdraw transaction                                      |

> **Note:** Withdrawal amounts do NOT appear in transaction instruction data or
> inner instruction logs. The vault uses direct lamport manipulation. The amount
> can only be derived by comparing pre/post balance snapshots — requiring custom
> tooling, not standard block explorers.
>
> **Recipient** is stored only as `SHA256(note_secret ∥ recipient_pubkey)` on the
> NoteAccount. The actual pubkey is invisible until the withdrawal transaction
> provides it for on-chain verification.

### Amount privacy by operation

| Operation    | Instruction data                     | CPI inner logs                       | Balance-diff analysis               |
| ------------ | ------------------------------------ | ------------------------------------ | ----------------------------------- |
| **Deposit**  | ⚠️ `amount_lamports` visible (split) | ⚠️ `system_program::transfer` logged | ⚠️ Observable                       |
| **Withdraw** | ✅ No amount                         | ✅ No transfer CPI                   | ⚠️ Observable (custom tooling only) |

The **deposit** instruction includes `amount_lamports` because the native SOL
`system_program::transfer` CPI requires a plaintext `u64`. Client-side note
splitting decorrelates these amounts: a 3.7 SOL transfer might appear as
three unrelated deposits of [1.2, 0.8, 1.7] SOL.

The **withdraw** instruction contains **NO plaintext amount** anywhere:

- Not in instruction data (reads from NoteAccount set at deposit time)
- Not in inner instruction logs (direct lamport manipulation, no CPI)
- `lamports_for_transfer` is zeroed out immediately after the transfer

### Comparison with other privacy approaches

| Privacy Feature             | Normal SOL |  Tornado-style  |            **Lowkie**            |
| --------------------------- | :--------: | :-------------: | :------------------------------: |
| Withdraw amount hidden      |     ✗      | ✓ (fixed denom) |        **✓** (no CPI log)        |
| Recipient hidden at deposit |     ✗      |        ✗        |       **✓** (SHA256 hash)        |
| Deposit↔Withdraw unlinkable |     ✗      |        ✓        | **✓** (separate signer + timing) |
| Amount decorrelation        |     ✗      | ✓ (fixed denom) |      **✓** (random splits)       |
| On-chain state encrypted    |     ✗      |     Partial     |         **✓** (Enc<Mxe>)         |
| Regulatory compliant        |    N/A     |        ✗        |      **✓** (MPC auditable)       |

> **Path to full encryption:** When Solana re-enables the ZK ElGamal Proof
> Program (currently disabled for security audit), the native SOL custody
> layer can be replaced with C-SPL confidential tokens. The MPC circuits and
> note commitment pattern remain identical.

---

## CipherOwl Compliance Integration

Lowkie integrates the [CipherOwl SRR API](https://readme.cipherowl.ai/reference/introduction)
to screen addresses against OFAC sanctions lists, darknet market exposure, mixer
history, and other risk categories before any transfer is processed. This makes
Lowkie a privacy protocol that is also regulatorily defensible — not an anonymity
tool for adversarial actors.

### Why compliance screening fits the privacy model

Lowkie hides _how much_ was sent and _when_, but it does not aim to help sanctioned
parties move funds. The MPC encrypted state is MPC-auditable: law enforcement with
a court order can compel the Arcium cluster operators to decrypt the pool balance
or a specific note amount. CipherOwl screening acts as the preventative gate
_before_ funds enter the pool.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                   CIPHEROWL SCREENING CHECKPOINTS                         │
│                                                                            │
│  Browser / API caller                                                      │
│       │                                                                    │
│       │  POST /api/send  { recipient, amountSol }                          │
│       ▼                                                                    │
│  Frontend Bridge (scripts/frontend-server.ts)                              │
│       │                                                                    │
│       ├─ CHECKPOINT 1: Screen SENDER address                               │
│       │    GET /api/screen/v1/chains/solana/addresses/{sender}             │
│       │    foundRisk == true  →  reject, return 403                        │
│       │                                                                    │
│       ├─ CHECKPOINT 2: Screen RECIPIENT address                            │
│       │    GET /api/screen/v1/chains/solana/addresses/{recipient}          │
│       │    foundRisk == true  →  reject, return 403                        │
│       │                                                                    │
│       ▼  (both pass)                                                       │
│  client/send.ts  →  deposit + withdraw flow proceeds                       │
│                                                                            │
│       (optional) CHECKPOINT 3: Re-screen recipient at withdrawal time      │
│       Protects against OFAC additions between deposit and withdrawal       │
└────────────────────────────────────────────────────────────────────────────┘
```

### CipherOwl API integration details

**Base URL:** `https://svc.cipherowl.ai/api/`  
**Authentication:** OAuth 2.0 Bearer token (configured via `CIPHEROWL_API_KEY` env var)  
**Chain identifier for Solana:** `solana`

#### Single address screening

```http
GET https://svc.cipherowl.ai/api/screen/v1/chains/solana/addresses/{address}
Authorization: Bearer <CIPHEROWL_API_KEY>
Accept: application/json
```

Response schema:

```json
{
  "config": "string",
  "chain": "solana",
  "address": "3UQr2DLne7zJxNS85n5jRGvPttVc6Wo1y8QhyDwZQ5Gb",
  "foundRisk": false,
  "version": "string",
  "explanations": {
    "sanctions": "No match",
    "mixer": "No match"
  }
}
```

`foundRisk: true` means the address matched at least one risk category (sanctions,
known mixer, darknet market, stolen funds, etc.). The `explanations` object gives
human-readable category labels for audit logs.

#### Batch screening (sender + recipient in one request)

```http
POST https://svc.cipherowl.ai/api/screen/v1/chains/solana/batch
Authorization: Bearer <CIPHEROWL_API_KEY>
Content-Type: application/json

{
  "addresses": [
    "3UQr2DLne7zJxNS85n5jRGvPttVc6Wo1y8QhyDwZQ5Gb",
    "5pusChUqLUkEAfLswZBBqNCDPafnqtxDnWGR46sbiyjv"
  ],
  "namespace": "lowkie.deposit"
}
```

Response:

```json
{
  "config": "string",
  "chain": "solana",
  "results": [
    { "address": "3UQr2...Q5Gb", "foundRisk": false },
    { "address": "5pus...yjv", "foundRisk": false }
  ],
  "version": "string"
}
```

The `namespace` field is used for audit trail attribution. Recommended values:

| Flow                            | Namespace                 |
| ------------------------------- | ------------------------- |
| Pre-deposit check               | `lowkie.deposit`          |
| Pre-withdrawal check            | `lowkie.withdraw`         |
| Re-screen on delayed withdrawal | `lowkie.withdraw.delayed` |

#### Implementation pattern in `scripts/frontend-server.ts`

```typescript
async function cipherOwlScreen(address: string): Promise<void> {
  const apiKey = process.env.CIPHEROWL_API_KEY;
  if (!apiKey) return; // screening is advisory if key not configured

  const res = await fetch(
    `https://svc.cipherowl.ai/api/screen/v1/chains/solana/addresses/${address}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    },
  );

  if (!res.ok) {
    // Non-2xx: treat as screening unavailable (log and continue or block — operator choice)
    console.warn(
      `[compliance] CipherOwl returned ${res.status} for ${address}`,
    );
    return;
  }

  const data = await res.json();
  if (data.foundRisk) {
    throw new Error(
      `Transfer blocked: address ${address} flagged by CipherOwl compliance screening`,
    );
  }
}

// Called before every /api/send invocation:
await cipherOwlScreen(senderAddress);
await cipherOwlScreen(recipientAddress);
```

### Compliance vs Privacy: reconciliation

| Concern                             | Lowkie answer                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| Can Lowkie hide illicit flows?      | No — CipherOwl blocks sanctioned/risk addresses at entry                                     |
| Can law enforcement trace amounts?  | Yes — MPC cluster is court-compellable                                                       |
| Is the recipient identity hidden?   | Yes — until withdrawal, only a SHA256 hash is on-chain                                       |
| Is the sender hidden at withdrawal? | Yes — relayer is fee payer, sender wallet never appears in the withdraw tx                   |
| Are tx amounts hidden?              | Deposit amounts: partially (note-split, not encrypted). Withdrawal amounts: yes (no CPI log) |
| Audit trail                         | CipherOwl `namespace` field + Solana tx history on deposit side                              |

### Environment variables required for compliance

```
# CipherOwl API key — obtain from https://cipherowl.ai
CIPHEROWL_API_KEY=your_oauth_bearer_token

# Set to "block" (default) or "warn" — controls server behaviour when API is unreachable
CIPHEROWL_FAILURE_MODE=block
```

If `CIPHEROWL_API_KEY` is unset the frontend bridge logs a warning and continues
without screening. **Production deployments must set this variable.**

---

## Project Structure

```
lowkie/
├── ARCHITECTURE.md              ← this file
├── Arcium.toml                  Arcium CLI config (cluster offsets)
├── Anchor.toml                  Anchor config
├── Cargo.toml                   Rust workspace
├── package.json                 Node.js dependencies
├── tsconfig.json
├── .env.example
│
├── encrypted-ixs/
│   └── circuits.rs              Three Arcis MPC circuits
│
├── programs/lowkie_pool/
│   ├── Cargo.toml               arcium-anchor 0.9.5, anchor-lang 0.32.1
│   └── src/lib.rs               9 instructions (3 comp-def, 3 queue, 3 callback)
│
├── client/
│   ├── constants.ts             Shared constants (program ID, defaults)
│   ├── utils.ts                 Shared utilities (keypair, crypto, env)
│   ├── arciumAccounts.ts        PDA derivation + Arcium account helpers
│   ├── send.ts                  Sender CLI — deposit + trigger relay
│   └── relayer.ts               Relayer CLI — withdraw (no plaintext amount)
│
├── tests/
│   └── lowkie.ts                Integration tests (4 scenarios)
│
├── scripts/
│   ├── frontend-server.ts       Dev frontend bridge (HTTP API → send flow)
│   └── local-validate.ts        Local CI script (typecheck + RPC + tests)
│
├── frontend/
│   ├── index.html               Devnet console UI
│   ├── styles.css
│   └── app.js
│
├── artifacts/                   Arcium build artifacts (circuits, accounts)
├── build/                       Anchor build output
└── target/                      Rust/Anchor build output (IDL, .so)
```

---

## Security Considerations

### MPC Trust Model

Arcium's Cerberus protocol guarantees confidentiality as long as **at least one
ARX node** in the cluster is honest. If all nodes collude, encrypted amounts
can be recovered. This is a trust assumption about the Arcium network.

- **Localnet:** 2-node cluster (trivial to compromise — dev only)
- **Devnet:** Cluster offset 456
- **Mainnet-alpha:** Cluster offset 2026 (production-grade cluster)

### Double-Spend Prevention

The `NoteStatus` state machine (`PendingMpc → Ready → Withdrawn`) prevents
a note from being withdrawn more than once while it still exists. After a
successful withdrawal, relayer cleanup closes the spent note PDA, so replay
attempts fail because the note account no longer exists.

### Recipient Binding

The recipient public key is locked in the `NoteAccount` at deposit time and
enforced via an Anchor constraint in the `Withdraw` accounts struct:

```rust
#[account(mut, constraint = recipient.key() == note_registry.recipient)]
pub recipient: SystemAccount<'info>,
```

### Note Preimage Security

The `note_hash = SHA256(secret ∥ recipient ∥ amount)` commitment binds all
three values. Without the 32-byte `noteSecret`, brute-forcing the preimage
requires 2^256 work (computationally infeasible).

---

## Known Limitations

1. **Deposit amounts are visible** — native SOL `system_program::transfer` CPI
   requires plaintext lamports. Withdrawal amounts are NOT visible in tx data
   (direct lamport manipulation), but can be derived via balance-diff analysis.
   Full encryption requires C-SPL confidential tokens.

2. **Concurrency** — `PoolState` is a single account. Simultaneous deposits or
   withdrawals may race on `encrypted_balance` + `balance_nonce`. The HTTP
   bridge now serializes `/api/send` requests by default, but protocol-level
   concurrency is still limited by the single shared pool account.

3. **Current registry settings are not production-grade yet** — the encrypted
   nullifier registry exists, but the current MVP capacity is very small and the
   local demo flow can opt into unsafe registry compaction to keep tests and
   local demos moving. Production deployments must keep compaction disabled and
   provision a real spent-set capacity strategy.

4. **No relayer network** — the relayer is currently a CLI tool or the sender
   process itself. Production needs an independent relayer service with fees.

5. **Timing correlation** — with low pool usage, the ±30% delay jitter may not
   provide sufficient decorrelation between deposit and withdrawal timestamps.

6. **Fixed denomination leakage** — the current implementation supports only
   `1.0`, `0.1`, and `0.01` SOL pools, so observers still learn the note-count
   and denomination pattern of each deposit batch.

---

## Toolchain

| Tool                | Version    | Source                          |
| ------------------- | ---------- | ------------------------------- |
| arcium CLI          | 0.6.3      | `setup-arcium` GitHub Action    |
| `arcium-anchor`     | **0.9.5**  | crates.io                       |
| `anchor-lang`       | **0.32.1** | Required by arcium-anchor 0.9.5 |
| `@arcium-hq/client` | `^0.9.5`   | npmjs.com                       |
| `@coral-xyz/anchor` | `^0.32.0`  | npmjs.com                       |
| Solana CLI          | 2.3.0      | `setup-arcium` GitHub Action    |
| Node.js             | 20.18.0    | `setup-arcium` GitHub Action    |
