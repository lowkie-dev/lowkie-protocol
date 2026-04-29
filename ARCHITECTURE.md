# Lowkie — Architecture

> Confidential internal pool state for native SOL settlement using Arcium MXE callbacks.

---

## Table of Contents

1. [Overview](#overview)
2. [Runtime components](#runtime-components)
3. [Protocol flow](#protocol-flow)
4. [On-chain state graph](#on-chain-state-graph)
5. [Arcium circuit boundaries](#arcium-circuit-boundaries)
6. [Confidentiality and observability](#confidentiality-and-observability)
7. [Operational model](#operational-model)
8. [Repository mapping](#repository-mapping)

---

## Overview

Lowkie is a denomination-scoped SOL pooling protocol with **confidential accounting**, not full native-SOL anonymity.

The system keeps these values under Arcium MXE encryption:

- pool running balance per denomination
- note amount snapshot
- note-secret limbs used for MPC-side spend authorization
- nullifier registry snapshot used for double-spend prevention

The system still exposes:

- deposit sender signer
- withdrawal relayer signer
- withdrawal recipient account
- deposit amount
- pool denomination routing
- withdrawal lamport movement to anyone comparing balances

That split is the core architectural fact: Lowkie hides the **internal state machine**, while native SOL custody still leaves an observable settlement surface.

---

## Runtime components

```text
┌──────────────────────────────────────────────────────────────────────┐
│                         CLIENT SURFACES                              │
│                                                                      │
│  apps/test-frontend        external frontend        operator CLI      │
│  packages/lowkie-sdk       custom app               yarn send/relay   │
└───────────────┬───────────────────────┬───────────────────────┬──────┘
                │                       │                       │
                └───────────────┬───────┴───────────────────────┘
                                v
┌──────────────────────────────────────────────────────────────────────┐
│                     apps/backend/server.ts                           │
│                                                                      │
│  Build mode:  POST /api/build-deposits                               │
│  Submit mode: POST /api/submit-deposits                              │
│  Managed mode: POST /api/send                                        │
│  Relay mode:   POST /api/relay                                       │
│  Health/readiness: /api/health, /api/relayer/health, /api/pool/status│
└───────────────────────────────┬──────────────────────────────────────┘
                                v
┌──────────────────────────────────────────────────────────────────────┐
│                  apps/backend/src/core/*.ts                          │
│                                                                      │
│  deposit.ts        build deposit transactions and recovery files      │
│  send.ts           build/submit orchestration                         │
│  relayer.ts        local relay execution and compaction               │
│  relayClient.ts    optional remote relay forwarding                   │
│  recover.ts        retry withdraw or refund                           │
│  readiness.ts      send-ready deployment checks                       │
└───────────────────────────────┬──────────────────────────────────────┘
                                v
┌──────────────────────────────────────────────────────────────────────┐
│                programs/lowkie_pool/src/lib.rs                       │
│                                                                      │
│  ProtocolConfig      init / update admin and maintenance authority    │
│  init_pool           create pool, vault, registry and queue bootstrap │
│  deposit             move SOL into vault and queue deposit_to_pool    │
│  withdraw            verify recipient hash and queue withdraw circuit │
│  compact_spent_note  close successful note PDAs                       │
│  refund_failed_deposit return SOL if deposit callback failed          │
│  compact_registry    maintenance-only registry reset                  │
└───────────────────────────────┬──────────────────────────────────────┘
                                v
┌──────────────────────────────────────────────────────────────────────┐
│               encrypted-ixs/circuits.rs + Arcium MXE                 │
│                                                                      │
│  init_pool_balance    zero pool + zero registry snapshot             │
│  deposit_to_pool      add note amount to encrypted pool state        │
│  withdraw_from_pool   verify secret, update pool, update registry    │
│  compact_registry     keep balance, zero registry snapshot           │
└──────────────────────────────────────────────────────────────────────┘
```

Two relayer topologies are supported:

1. **Local relayer**: backend reads `RELAYER_KEYPAIR_PATH` and executes relay itself.
2. **Remote relayer**: backend forwards the serialized relay payload to `LOWKIE_RELAYER_URL` with optional bearer auth.

---

## Protocol flow

### 0. Bring-up

`apps/backend/scripts/bootstrap-program.ts` brings the deployment to a usable state:

1. initialize or update `ProtocolConfig`
2. register all computation definitions
3. initialize every denomination pool
4. verify that all pools and comp-def accounts exist and decode correctly

This step is required before any deposit path is send-ready.

### 1. Build deposit notes

For a requested transfer amount, the backend decomposes lamports into supported fixed denominations.

For each sub-note it creates:

- `note_secret` for note commitment and secret verification
- `withdraw_key` for recipient authorization
- `note_hash = SHA256(note_secret || recipient || amount)`
- `recipient_hash = SHA256(withdraw_key || recipient_pubkey)`
- `nullifier_hash = H(note_secret)`

The amount and secret limbs are encrypted against the MXE public key as `Enc<Shared, ...>` inputs.

### 2. Deposit submission

The deposit path differs slightly by client mode:

#### Managed backend signer

`POST /api/send` builds, signs, and submits deposits using the configured `SENDER_WALLET`.

#### Browser wallet signer

`POST /api/build-deposits` returns unsigned versioned transactions. A browser wallet signs them, then `POST /api/submit-deposits` submits the signed payloads.

The on-chain `deposit` instruction for each sub-note:

1. transfers SOL from sender to the vault PDA
2. initializes `NoteAccount` and `NullifierRecord`
3. stores sender, `recipient_hash`, `nullifier_hash`, and `lamports_for_transfer`
4. queues `deposit_to_pool`

The callback `deposit_to_pool_callback` then:

1. writes the new encrypted pool balance
2. writes the encrypted note amount and encrypted secret limbs
3. stores the output nonce needed for future MXE inputs
4. marks `pool_credit_applied = true`
5. sets the note status to `Ready`

### 3. Relay execution

After the configured delay plus jitter, the relayer processes each ready sub-note.

The relayer:

1. checks whether registry compaction is needed
2. derives the note, pool, registry, vault, and nullifier PDAs
3. verifies `recipient_hash` on-chain using `withdraw_key`
4. encrypts the claimed note-secret limbs as fresh `Enc<Shared, u128>` values
5. queues `withdraw_from_pool`

The withdraw instruction does **not** carry a plaintext amount argument. It reads the stored amount from `NoteAccount.lamports_for_transfer`, which was already exposed at deposit time.

### 4. Withdraw callback and cleanup

`withdraw_from_pool_callback`:

1. updates the encrypted pool balance
2. updates the encrypted nullifier registry snapshot
3. marks the `NullifierRecord` as spent when accepted
4. directly debits the vault PDA and credits the recipient account
5. marks the note `Withdrawn`
6. clears `lamports_for_transfer`

After success, the relayer calls `compact_spent_note` to close the note PDA.

If a deposit callback failed before encrypted pool credit was applied, the sender can call `refund_failed_deposit` and recover the vault lamports for that note.

---

## On-chain state graph

Every denomination has its own pool triple plus transient notes and persistent nullifier records.

```text
ProtocolConfig PDA
  - admin
  - maintenance_authority

For each supported denomination:
  PoolState PDA
    - encrypted_balance
    - balance_nonce
    - denomination_lamports
    - is_initialized

  VaultAccount PDA
    - native SOL custody for that denomination

  NullifierRegistryState PDA
    - encrypted nullifier words
    - registry_nonce
    - pool_snapshot_ct

For each live note:
  NoteAccount PDA
    - note_hash
    - sender
    - recipient_hash
    - nullifier_hash
    - encrypted_amount
    - encrypted_secret_lo / hi
    - encrypted_pool_at_deposit
    - amount_nonce
    - pool_credit_applied
    - lamports_for_transfer
    - status

Persistent replay guard:
  NullifierRecord PDA
    - nullifier_hash
    - spent
```

Important implications:

- replay protection does not rely only on the encrypted registry; `NullifierRecord` survives note closure
- registry compaction can reset the encrypted registry snapshot without losing the public spent bit
- notes are intentionally transient and removed after a successful withdraw

---

## Arcium circuit boundaries

### `init_pool_balance`

Input:

- dummy shared ciphertext used only to satisfy circuit initialization

Output:

- encrypted pool balance at zero
- encrypted zeroed nullifier registry snapshot

### `deposit_to_pool`

Input:

- shared encrypted transfer amount
- current MXE encrypted pool balance
- shared encrypted low and high secret limbs

Output:

- new encrypted pool balance
- encrypted note amount
- encrypted low and high note-secret limbs

### `withdraw_from_pool`

Input:

- full `DepositOutput` ciphertext layout
- current encrypted pool balance
- full `WithdrawOutput` ciphertext layout for the registry snapshot
- shared encrypted claimed secret limbs

Output:

- updated encrypted `WithdrawOutput`
- status code for accepted, already spent, registry full, or secret mismatch

### `compact_registry`

Input:

- current encrypted pool balance

Output:

- preserved encrypted pool balance
- zeroed encrypted registry snapshot

This is why callback account ordering and ciphertext layout preservation are non-negotiable: both the on-chain program and the relayer path must feed Arcium exactly the struct shape the circuits expect.

---

## Confidentiality and observability

### Confidential state

Lowkie keeps these values opaque to normal on-chain inspection:

- pool running balance
- note amount stored after callback
- secret verification snapshot
- nullifier registry contents

### Observable state

Lowkie still leaves these visible or inferable:

- sender, relayer, and recipient accounts
- deposit lamports moved into the vault
- note and nullifier commitments while accounts exist
- denomination used for each note
- withdrawal lamports by balance-delta analysis

### Explorer behavior

The withdraw callback uses direct lamport mutation on the program-owned vault PDA instead of a System Program transfer CPI. Many explorers therefore show less explicit transfer detail than on deposit, but the underlying lamport movement is still there.

### Unlinkability contribution

Lowkie improves unlinkability through:

- sender and relayer key separation
- configurable delay plus per-note jitter
- post-withdraw note closure

That improves correlation resistance, but it should not be described as native-SOL anonymity.

---

## Operational model

### Readiness gates

The backend refuses send execution until `readiness.ts` verifies:

- `ProtocolConfig` exists and is owned by the program
- MXE account exists and is owned by the Arcium program
- all four computation definitions exist
- every supported denomination pool exists and is initialized

### Recovery paths

Local recovery files keep sub-note material so operators can:

- retry withdrawals with `POST /api/recover`
- list pending recoveries with `GET /api/recoverable`
- refund failed deposits when encrypted pool credit never landed

### Remote relayer deployment

Set `LOWKIE_RELAYER_URL` on the backend host to forward relay payloads to a separate relayer service. That service can keep the relayer key isolated from the pool-facing API host.

### Safety defaults

- loopback-only deployments may disable auth explicitly for local demos
- public hosts must require bearer auth and allowed origins
- automatic registry compaction is gated by runtime safety flags and is not intended as a broad production default

---

## Repository mapping

```text
apps/backend/server.ts                  API surface
apps/backend/src/core/send.ts          deposit orchestration entrypoint
apps/backend/src/core/deposit.ts       deposit note building and submission
apps/backend/src/core/relayer.ts       withdraw orchestration and compaction
apps/backend/src/core/readiness.ts     deployment readiness checks
apps/backend/scripts/bootstrap-program.ts protocol bootstrap
packages/lowkie-sdk/src/index.ts       typed client for frontend callers
apps/test-frontend/                    demo UI and browser signer flow
programs/lowkie_pool/src/lib.rs        Anchor program and callbacks
encrypted-ixs/circuits.rs              Arcium circuit definitions
tests/                                 integration and unit coverage
```

The repo boundary is now clear:

- `programs/lowkie_pool/` is the source of truth for accounts, instructions, and lamport movement
- `encrypted-ixs/` is the source of truth for confidential compute shape
- `apps/backend/src/core/` is the orchestration layer
- `packages/lowkie-sdk/` is the integration surface for external frontends
- `apps/test-frontend/` is only a demo client
