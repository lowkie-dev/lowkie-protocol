# Contributing

## Default Branch

`main` is the default branch and should always reflect the latest deployable state.

To make `main` the default branch on GitHub:

1. Open the repository on GitHub.
2. Go to `Settings`.
3. Open `Branches`.
4. Under `Default branch`, click the switch action.
5. Select `main`.
6. Save the change.

After that, add branch protection rules for `main` so direct pushes are limited.

## Branch Convention

Use the following branch model:

- `main`: production-ready branch and GitHub default branch
- `staging`: pre-production verification branch for release candidates
- `dev`: main integration branch for ongoing work
- `feature/<short-name>`: new product or protocol work
- `fix/<short-name>`: non-urgent bug fixes
- `hotfix/<short-name>`: urgent fixes that need to land quickly
- `release/<version-or-date>`: optional release preparation branch when you need a freeze window
- `security/<short-name>`: security-sensitive or isolated hardening work when it should not begin directly on `dev`

## Recommended Flow

For normal product work:

1. Branch from `dev` using `feature/*` or `fix/*`.
2. Open a pull request into `dev`.
3. Merge `dev` into `staging` when you want a release candidate.
4. Merge `staging` into `main` after final verification.

For urgent production fixes:

1. Branch from `main` using `hotfix/*`.
2. Merge back into `main`.
3. Back-merge the same fix into `dev` and `staging` if they exist.

## Practical Rules

- Keep `main` and `staging` protected.
- Prefer pull requests over direct pushes.
- Rebase or merge from `main` into long-running branches regularly.
- Keep branch names short and descriptive.
- Delete merged feature branches.

## Suggested Protections

For `main`:

- require pull requests
- require at least one review
- require branch to be up to date before merge
- restrict force pushes
- restrict branch deletion

For `staging`:

- require pull requests
- optionally require one review

For `dev`:

- allow faster iteration, but still prefer pull requests