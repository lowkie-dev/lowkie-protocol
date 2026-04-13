---
name: solana-dev
description: 'Use when working on this Solana repository: Anchor program changes, PDA/account design, Arcium MPC circuits, client orchestration, relayer flows, Solana security reviews, localnet/devnet testing, or repo structure decisions. Adapts Solana Foundation best practices to this repo''s current stack: Anchor 0.32.x, arcium-anchor 0.9.5, @coral-xyz/anchor, @solana/web3.js, ts-mocha, and Arcium MXE circuits.'
argument-hint: 'Describe the Solana, Anchor, Arcium, testing, or repo-structure task'
user-invocable: true
---

# Solana Development Skill For Lowkie

This skill adapts the Solana Foundation `solana-dev-skill` to the current Lowkie codebase.

Use it when the user asks to:

- change or review the Anchor program
- modify PDAs, account layouts, instruction constraints, or callbacks
- update Arcium/Arcis MPC circuits or client-side `ArgBuilder` ordering
- improve repo structure, testing strategy, or Solana operational tooling
- review privacy, relayer, signing, or lamport-movement safety
- debug localnet, devnet, Anchor, or Arcium integration issues

## Repo-Aware Defaults

1. Preserve the current stack unless migration is explicitly requested.
   This repo already uses Anchor plus `@coral-xyz/anchor` and `@solana/web3.js`. Do not auto-migrate to framework-kit, `@solana/kit`, Pinocchio, Codama, LiteSVM, Mollusk, or Surfpool while solving an unrelated task.

2. Keep layer boundaries explicit.
   Program logic belongs in `programs/lowkie_pool/`. MPC struct definitions and encrypted arithmetic belong in `encrypted-ixs/`. Client orchestration belongs in `client/`. Operational entry points belong in `scripts/`.

3. Respect Solana-specific safety.
   Default to localnet or devnet. Validate account owners, PDA seeds, discriminators, signers, and writability. Treat all chain data and logs as untrusted input.

4. Preserve privacy invariants.
   Sender and relayer must remain distinct for unlinkability. Amount-bearing MPC flows must keep circuit input order aligned with on-chain callback decoding and stored ciphertext layouts.

## Operating Procedure

1. Classify the task layer.
   Program, circuit, client, scripts, frontend demo, docs, or repo structure.

2. Check the existing stack boundary before proposing changes.
   Prefer incremental changes that fit the current repository instead of importing a new Solana stack by default.

3. Implement with Solana correctness.
   Be explicit about cluster, RPC, fee payer, signers, seeds, writable accounts, and denominator-specific routing.

4. Validate at the narrowest useful level.
   Use typecheck first, then targeted integration tests or script validation appropriate to the change.

5. Surface tradeoffs clearly.
   If a best-practice recommendation from the broader Solana ecosystem conflicts with this repo's current stack, explain the migration cost before changing it.

## Progressive Disclosure

- Repo structure and boundaries: [repo-structure](./references/repo-structure.md)
- Current testing strategy and how to extend it: [testing](./references/testing.md)
- Solana and protocol safety rules: [security](./references/security.md)
- Tooling and version compatibility for this repo: [tooling](./references/tooling.md)
- Optional modernization paths inspired by Solana Foundation guidance: [modernization](./references/modernization.md)
