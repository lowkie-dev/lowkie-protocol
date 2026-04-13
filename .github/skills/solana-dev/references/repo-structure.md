# Repo Structure

## Current Source-Of-Truth Layout

- `programs/lowkie_pool/`: Anchor program, PDA/account definitions, instruction constraints, callback logic, events, errors.
- `encrypted-ixs/`: Arcis MPC circuits and encrypted struct shapes used by the Arcium runtime.
- `client/`: runtime orchestration for sender and relayer flows, PDA derivation, cryptographic helpers, privacy logging, runtime safety checks.
- `scripts/`: operator workflows such as bootstrapping computation definitions, serving the demo frontend, and local validation.
- `tests/`: integration coverage against localnet and Arcium flows.
- `frontend/`: minimal demonstration UI and browser-side glue. It should not become the protocol source of truth.
- `ARCHITECTURE.md`: deep technical walkthrough.
- `README.md`: public-facing overview and practical usage.

## Placement Rules

- Add new on-chain state, PDA seeds, constraints, or callback behavior in `programs/lowkie_pool/`.
- Add or change encrypted struct shapes only when the corresponding circuit and on-chain callback paths are updated together.
- Put shared TypeScript helpers in `client/` when they are used by sender, relayer, or scripts.
- Put operational commands, deployment flows, and one-off orchestration into `scripts/`, not `client/`.
- Keep generated outputs out of committed source directories. `artifacts/`, `build/`, and `target/` are not architectural boundaries.

## Structure Guidance For Future Growth

- If a reusable public client SDK becomes necessary, add a dedicated package only when the user asks for it instead of overloading `client/`.
- If the frontend becomes more than a demo, split it into its own app boundary with explicit API contracts instead of mixing browser and protocol logic.
- Keep protocol-specific docs public in `README.md` and `ARCHITECTURE.md`. Keep internal-only notes out of the public repo.
