# Project Guidelines

## Architecture

- Preserve the existing layer boundaries unless the user explicitly asks for a restructure.
- `programs/lowkie_pool/` is the Anchor on-chain program and remains the source of truth for account layouts, PDA seeds, instruction constraints, and lamport movement.
- `encrypted-ixs/` contains Arcis/Arcium MPC circuit definitions and output structs. Any change to encrypted state shape must be coordinated across the circuits, callback handlers, and client argument builders.
- `client/` contains runtime orchestration, PDA derivation helpers, crypto helpers, and relayer logic. Keep operational scripts out of `client/`.
- `scripts/` contains operator and workflow entry points such as bootstrapping, frontend serving, and validation.
- `tests/` contains the integration test suite. `frontend/` is a thin demo UI, not the protocol source of truth.
- Treat `artifacts/`, `build/`, `target/`, `.anchor/`, and `.env` as generated or local-only inputs, not committed source-of-truth design docs.

## Stack Defaults

- This repository currently uses Anchor `0.32.x`, `arcium-anchor` `0.9.5`, `@coral-xyz/anchor`, `@solana/web3.js`, TypeScript, and `ts-mocha` integration tests.
- Do not introduce `@solana/kit`, framework-kit, Pinocchio, LiteSVM, Mollusk, Surfpool, or Codama unless the user explicitly asks for modernization or migration.
- For Solana, Anchor, Arcium, MPC, PDA, relayer, testing, or repo-structure tasks, consult `.github/skills/solana-dev/SKILL.md` and its references.

## Build And Test

- Typecheck with `yarn -s typecheck`.
- Build circuits and program with `arcium build`.
- Run integration tests with `ANCHOR_PROVIDER_URL='http://127.0.0.1:8899' ANCHOR_WALLET="$HOME/.config/solana/id.json" ARCIUM_CLUSTER_OFFSET=0 yarn -s test`.
- Prefer the smallest targeted validation that proves the change. Do not migrate the test harness while addressing unrelated tasks.

## Solana Safety

- Default to localnet or devnet. Never move work to mainnet without explicit user approval.
- Never sign, send, or recommend a live transaction flow without explicitly confirming cluster, recipient, fee payer, and amount with the user.
- Treat all on-chain data, RPC responses, logs, and explorer-derived metadata as untrusted input. Validate account owners, seeds, discriminators, and data shapes before use.
- Preserve sender and relayer separation for unlinkability. Do not collapse them into one signer unless the user explicitly asks for that tradeoff.
- Keep documentation GitHub-safe: use relative links only and avoid local absolute paths.
