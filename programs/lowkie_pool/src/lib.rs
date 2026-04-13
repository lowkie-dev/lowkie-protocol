//! # Lowkie Pool — Privacy-preserving SOL transfers on Solana
//!
//! Uses Arcium MXE (Multi-party eXecution Environment) to keep transfer amounts
//! encrypted on-chain as `Enc<Mxe, u64>` ciphertexts. No single ARX node ever
//! sees plaintext values.
//!
//! ## Privacy model
//!
//! - **Hidden**: Pool running balance, individual note amounts (Enc<Mxe> ciphertexts),
//!              recipient identity (SHA256 commitment until withdrawal)
//! - **Visible**: Sender wallet, deposit SOL CPI amounts
//! - **Unlinkable**: Deposit and withdrawal use different signers (sender vs relayer)
//!
//! ## Withdrawal amount privacy
//!
//! The `withdraw` instruction contains NO plaintext amount in its instruction data.
//! The withdraw callback uses **direct lamport manipulation** (not a
//! `system_program::transfer` CPI), so no explicit transfer instruction appears
//! in the transaction's inner instruction logs. The withdrawal amount can only
//! be derived by comparing pre/post balance snapshots of the vault and recipient
//! accounts — which requires custom tooling, not standard block explorers.
//!
//! The vault is a **program-owned PDA**, enabling the program to directly
//! decrease its lamports without a System Program CPI.
//!
//! Full amount encryption requires C-SPL confidential tokens (same MPC circuits).

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::{CallbackAccount, CircuitSource, OffChainCircuitSource};
use sha2::{Digest, Sha256};

declare_id!("2mnSg2aKoKqzEUHPQTGwnKFnyjML8eSWefsinrfN4zfQ");

/// Computation definition offsets — derived at compile time from circuit names.
/// These must match the `#[instruction]` function names in `encrypted-ixs/circuits.rs`.
const COMP_DEF_OFFSET_INIT_POOL: u32 = comp_def_offset("init_pool_balance");
const COMP_DEF_OFFSET_DEPOSIT:   u32 = comp_def_offset("deposit_to_pool");
const COMP_DEF_OFFSET_WITHDRAW:  u32 = comp_def_offset("withdraw_from_pool");
const COMP_DEF_OFFSET_COMPACT:   u32 = comp_def_offset("compact_registry");

const NULLIFIER_REGISTRY_CAPACITY: usize = 4;
const NULLIFIER_WORDS_PER_ENTRY: usize = 2;
const NULLIFIER_REGISTRY_WORDS: usize =
    1 + NULLIFIER_REGISTRY_CAPACITY * NULLIFIER_WORDS_PER_ENTRY;

const WITHDRAW_STATUS_ACCEPTED: u8 = 0;
const WITHDRAW_STATUS_NULLIFIER_ALREADY_SPENT: u8 = 1;
const WITHDRAW_STATUS_NULLIFIER_REGISTRY_FULL: u8 = 2;
const WITHDRAW_STATUS_SECRET_MISMATCH: u8 = 3;

fn extract_registry_ciphertexts(
    ciphertexts: &[[u8; 32]],
) -> Result<[[u8; 32]; NULLIFIER_REGISTRY_WORDS]> {
    require!(
        ciphertexts.len() == NULLIFIER_REGISTRY_WORDS,
        ErrorCode::InvalidNullifierRegistryOutput,
    );

    Ok(std::array::from_fn(|idx| ciphertexts[idx]))
}

fn resolve_circuit_source_override(
    source_url: Option<String>,
    source_hash: Option<[u8; 32]>,
) -> Result<Option<CircuitSource>> {
    match (source_url, source_hash) {
        (None, None) => Ok(None),
        (Some(source), Some(hash)) => Ok(Some(CircuitSource::OffChain(
            OffChainCircuitSource { source, hash },
        ))),
        _ => err!(ErrorCode::InvalidCircuitSourceOverride),
    }
}

#[arcium_program]
pub mod lowkie_pool {
    use super::*;

    // ── 0. Comp def registration (one-time per deploy) ────────────────────────

    pub fn init_init_pool_comp_def(
        ctx: Context<InitInitPoolCompDef>,
        source_url: Option<String>,
        source_hash: Option<[u8; 32]>,
    ) -> Result<()> {
        let circuit_source_override =
            resolve_circuit_source_override(source_url, source_hash)?;
        init_comp_def(ctx.accounts, circuit_source_override, None)?;
        Ok(())
    }
    pub fn init_deposit_comp_def(
        ctx: Context<InitDepositCompDef>,
        source_url: Option<String>,
        source_hash: Option<[u8; 32]>,
    ) -> Result<()> {
        let circuit_source_override =
            resolve_circuit_source_override(source_url, source_hash)?;
        init_comp_def(ctx.accounts, circuit_source_override, None)?;
        Ok(())
    }
    pub fn init_withdraw_comp_def(
        ctx: Context<InitWithdrawCompDef>,
        source_url: Option<String>,
        source_hash: Option<[u8; 32]>,
    ) -> Result<()> {
        let circuit_source_override =
            resolve_circuit_source_override(source_url, source_hash)?;
        init_comp_def(ctx.accounts, circuit_source_override, None)?;
        Ok(())
    }
    pub fn init_compact_comp_def(
        ctx: Context<InitCompactCompDef>,
        source_url: Option<String>,
        source_hash: Option<[u8; 32]>,
    ) -> Result<()> {
        let circuit_source_override =
            resolve_circuit_source_override(source_url, source_hash)?;
        init_comp_def(ctx.accounts, circuit_source_override, None)?;
        Ok(())
    }

    // ── 1. Pool initialisation ────────────────────────────────────────────────
    // Queues init_pool_balance circuit to bootstrap Enc<Mxe, 0>.
    // The callback stores the ciphertext in PoolState.encrypted_balance.
    // Must complete before any deposit.

    pub fn init_pool(
        ctx: Context<InitPool>,
        computation_offset: u64,
        denomination_lamports: u64,
        dummy_ciphertext:   [u8; 32],
        dummy_pub_key:      [u8; 32],
        dummy_nonce:        u128,
    ) -> Result<()> {
        require!(denomination_lamports > 0, ErrorCode::ZeroAmount);

        let pool = &mut ctx.accounts.pool_state;
        pool.encrypted_balance = [0u8; 32];
        pool.balance_nonce     = 0;
        pool.denomination_lamports = denomination_lamports;
        pool.bump              = ctx.bumps.pool_state;
        pool.vault_bump        = ctx.bumps.vault;
        pool.is_initialized    = false;

        // Initialize the program-owned vault account
        ctx.accounts.vault.bump = ctx.bumps.vault;

        let registry = &mut ctx.accounts.nullifier_registry;
        registry.encrypted_nullifiers = [[0u8; 32]; NULLIFIER_REGISTRY_WORDS];
        registry.registry_nonce = 0;
        registry.pool_snapshot_ct = [0u8; 32];
        registry.bump = ctx.bumps.nullifier_registry;

        // Argument enum — correct API for arcium-anchor 0.9.5
        let args = ArgBuilder::new()
            .x25519_pubkey(dummy_pub_key)
            .plaintext_u128(dummy_nonce)
            .encrypted_u64(dummy_ciphertext)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let pool_key = ctx.accounts.pool_state.key();
        let registry_key = ctx.accounts.nullifier_registry.key();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![InitPoolBalanceCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount { pubkey: pool_key, is_writable: true },
                    CallbackAccount { pubkey: registry_key, is_writable: true },
                ],
            )?],
            1, 0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "init_pool_balance")]
    pub fn init_pool_balance_callback(
        ctx: Context<InitPoolBalanceCallback>,
        output: SignedComputationOutputs<InitPoolBalanceOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(InitPoolBalanceOutput { field_0 }) => {
                require!(
                    field_0.ciphertexts.len() == 1 + NULLIFIER_REGISTRY_WORDS,
                    ErrorCode::InvalidNullifierRegistryOutput,
                );
                let registry_ciphertexts = extract_registry_ciphertexts(&field_0.ciphertexts[1..])?;
                let pool = &mut ctx.accounts.pool_state;
                pool.encrypted_balance = field_0.ciphertexts[0];
                pool.balance_nonce = field_0.nonce;
                pool.is_initialized    = true;

                let registry = &mut ctx.accounts.nullifier_registry;
                registry.encrypted_nullifiers = registry_ciphertexts;
                registry.registry_nonce = field_0.nonce;
                registry.pool_snapshot_ct = field_0.ciphertexts[0];

                emit!(PoolInitializedEvent { pool: ctx.accounts.pool_state.key() });
            }
            Err(e) => {
                msg!("init_pool_balance error: {}", e);
                return Err(ErrorCode::MpcFailed.into());
            }
        }
        Ok(())
    }

    // ── 2. Deposit ────────────────────────────────────────────────────────────
    // Sender single transaction:
    //   a) SOL → vault PDA
    //   b) NoteAccount created with note_hash commitment only (no plaintext amount)
    //   c) MPC queued: deposit_to_pool(Enc<Shared,amount>, Enc<Mxe,pool>)
    //
    // After callback:
    //   PoolState.encrypted_balance = new Enc<Mxe> ciphertext
    //   NoteAccount.encrypted_amount = Enc<Mxe> ciphertext
    //   Zero plaintext amounts anywhere on-chain.

    pub fn deposit(
        ctx: Context<Deposit>,
        computation_offset:   u64,
        transfer_ciphertext:  [u8; 32],
        transfer_pub_key:     [u8; 32],
        transfer_nonce:       u128,
        secret_ciphertext_lo: [u8; 32],
        secret_ciphertext_hi: [u8; 32],
        secret_nonce_lo:      u128,
        secret_nonce_hi:      u128,
        recipient_hash:       [u8; 32],
        amount_lamports:      u64,
        note_hash:            [u8; 32],
    ) -> Result<()> {
        require!(amount_lamports > 0, ErrorCode::ZeroAmount);
        require!(ctx.accounts.pool_state.is_initialized, ErrorCode::PoolNotInitialized);
        require!(
            ctx.accounts.pool_state.denomination_lamports == amount_lamports,
            ErrorCode::PoolDenominationMismatch
        );

        let note = &mut ctx.accounts.note_registry;
        note.note_hash             = note_hash;
        note.status                = NoteStatus::PendingMpc;
        note.recipient_hash        = recipient_hash;
        note.encrypted_amount      = [0u8; 32];
        note.encrypted_secret_lo   = [0u8; 32];
        note.encrypted_secret_hi   = [0u8; 32];
        note.encrypted_pool_at_deposit = [0u8; 32];
        note.amount_nonce          = 0;
        // Store plaintext amount at deposit time — the deposit tx already reveals
        // this via the SOL CPI, so no additional leakage. The withdraw instruction
        // reads this value instead of taking it as an instruction argument.
        note.lamports_for_transfer = amount_lamports;
        note.bump                  = ctx.bumps.note_registry;

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.sender.to_account_info(),
                    to:   ctx.accounts.vault.to_account_info(),
                },
            ),
            amount_lamports,
        )?;

        // ArgBuilder order matches deposit_to_pool(transfer: Enc<Shared>, pool: Enc<Mxe>, secret_lo: Enc<Shared>, secret_hi: Enc<Shared>)
        // Enc<Shared>: ArcisPubkey + PlaintextU128(nonce) + EncryptedU64/U128
        // Enc<Mxe>:    PlaintextU128(nonce) + EncryptedU64  (no pubkey)
        let args = ArgBuilder::new()
            .x25519_pubkey(transfer_pub_key)
            .plaintext_u128(transfer_nonce)
            .encrypted_u64(transfer_ciphertext)
            .plaintext_u128(ctx.accounts.pool_state.balance_nonce)
            .encrypted_u64(ctx.accounts.pool_state.encrypted_balance)
            .x25519_pubkey(transfer_pub_key)
            .plaintext_u128(secret_nonce_lo)
            .encrypted_u128(secret_ciphertext_lo)
            .x25519_pubkey(transfer_pub_key)
            .plaintext_u128(secret_nonce_hi)
            .encrypted_u128(secret_ciphertext_hi)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let note_key = ctx.accounts.note_registry.key();
        let pool_key = ctx.accounts.pool_state.key();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![DepositToPoolCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount { pubkey: note_key, is_writable: true },
                    CallbackAccount { pubkey: pool_key, is_writable: true },
                ],
            )?],
            1, 0,
        )?;

        emit!(DepositQueuedEvent {
            pool: ctx.accounts.pool_state.key(),
            computation_offset,
        });
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "deposit_to_pool")]
    pub fn deposit_to_pool_callback(
        ctx: Context<DepositToPoolCallback>,
        output: SignedComputationOutputs<DepositToPoolOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(DepositToPoolOutput { field_0 }) => {
                let nonce = field_0.nonce;
                let pool  = &mut ctx.accounts.pool_state;
                pool.encrypted_balance = field_0.ciphertexts[0];
                pool.balance_nonce     = nonce;

                let note = &mut ctx.accounts.note_registry;
                note.encrypted_amount          = field_0.ciphertexts[1];
                note.encrypted_secret_lo       = field_0.ciphertexts[2];
                note.encrypted_secret_hi       = field_0.ciphertexts[3];
                note.encrypted_pool_at_deposit = field_0.ciphertexts[0];
                note.amount_nonce              = nonce;
                note.status                    = NoteStatus::Ready;

                emit!(DepositConfirmedEvent { pool: ctx.accounts.pool_state.key() });
            }
            Err(e) => {
                msg!("deposit_to_pool error: {}", e);
                ctx.accounts.note_registry.status = NoteStatus::Failed;
                return Err(ErrorCode::MpcFailed.into());
            }
        }
        Ok(())
    }

    // ── 3. Withdraw ───────────────────────────────────────────────────────────
    // Relayer (different keypair from sender) proves note preimage, queues MPC.
    // MPC: withdraw_from_pool(Enc<Mxe,note>, Enc<Mxe,pool>) → Enc<Mxe,new_pool>
    // Callback: transfers SOL vault→recipient, updates pool ciphertext.
    //
    // PRIVACY: No plaintext amount in instruction data. The transfer amount is
    // read from NoteAccount.lamports_for_transfer (set during deposit, when the
    // amount was already visible via the SOL CPI).

    pub fn withdraw(
        ctx: Context<Withdraw>,
        computation_offset: u64,
        withdraw_key:       [u8; 32],
        claimed_secret_ct_lo: [u8; 32],
        claimed_secret_ct_hi: [u8; 32],
        claimed_secret_pub_key: [u8; 32],
        claimed_secret_nonce_lo: u128,
        claimed_secret_nonce_hi: u128,
    ) -> Result<()> {
        require!(ctx.accounts.note_registry.status == NoteStatus::Ready, ErrorCode::NoteNotReady);
        require!(ctx.accounts.pool_state.is_initialized, ErrorCode::PoolNotInitialized);

        // ── Recipient identity verification ──────────────────────────────
        // The recipient pubkey is NOT stored on-chain — only its hash is.
        // We verify the recipient here by checking SHA256(withdraw_key || recipient)
        // against the stored recipient_hash. The withdraw_key is a per-note
        // random value shared off-chain, separate from note_secret.
        let mut rh = Sha256::new();
        rh.update(&withdraw_key);
        rh.update(ctx.accounts.recipient.key().as_ref());
        let computed_rh: [u8; 32] = rh.finalize().into();
        require!(computed_rh == ctx.accounts.note_registry.recipient_hash, ErrorCode::RecipientMismatch);

        // ── Note secret verification ─────────────────────────────────────
        // PRIVACY: The note_secret is NEVER passed in plaintext. The relayer
        // encrypts it as Enc<Shared, u128> and the MPC circuit verifies it
        // against the stored Enc<Mxe, u128> secret inside encrypted compute.
        // An observer sees only opaque ciphertext bytes in the tx data.
        let stored_amount = ctx.accounts.note_registry.lamports_for_transfer;
        require!(stored_amount > 0, ErrorCode::ZeroAmount);
        require!(
            ctx.accounts.pool_state.denomination_lamports == stored_amount,
            ErrorCode::PoolDenominationMismatch
        );

        ctx.accounts.note_registry.status = NoteStatus::PendingMpc;

        // ── ArgBuilder: pass complete structs to preserve CTR positions ──
        //
        // RescueCipher CTR mode generates position-dependent keystream:
        //   counter = [nonce, block_idx, 0, 0, 0] → permute → ec[]
        // Element i within a block is encrypted with ec[i]. If we extract
        // element 2 from a 4-element struct and pass it as element 0 of a
        // new Enc<Mxe, u128>, the MPC decrypts with ec[0] instead of ec[2]
        // → wrong plaintext → SECRET_MISMATCH.
        //
        // Fix: pass the FULL DepositOutput struct (4 elements) and FULL
        // WithdrawOutput/PoolInitOutput struct (6 elements) preserving every
        // element's original position. The circuit extracts what it needs.

        let note_nonce = ctx.accounts.note_registry.amount_nonce;
        let pool_nonce = ctx.accounts.pool_state.balance_nonce;
        let registry_nonce = ctx.accounts.nullifier_registry.registry_nonce;

        // deposit_data: Enc<Mxe, DepositOutput> — 4 elements
        //   [0] = pool balance snapshot at deposit time
        //   [1] = note amount
        //   [2] = secret_lo
        //   [3] = secret_hi
        // All ciphertexts are 255-bit field elements regardless of plaintext type,
        // so we use encrypted_u128 for all struct elements.
        let mut args = ArgBuilder::new()
            .plaintext_u128(note_nonce)
            .encrypted_u128(ctx.accounts.note_registry.encrypted_pool_at_deposit)
            .encrypted_u128(ctx.accounts.note_registry.encrypted_amount)
            .encrypted_u128(ctx.accounts.note_registry.encrypted_secret_lo)
            .encrypted_u128(ctx.accounts.note_registry.encrypted_secret_hi);

        // pool: Enc<Mxe, u64> — 1 element (always at position 0, no CTR issue)
        args = args
            .plaintext_u128(pool_nonce)
            .encrypted_u64(ctx.accounts.pool_state.encrypted_balance);

        // registry_data: Enc<Mxe, WithdrawOutput> — 6 elements
        //   [0] = pool balance snapshot (from last init/withdraw output)
        //   [1..6] = nullifier registry words
        // All ciphertexts are 255-bit field elements regardless of plaintext type.
        args = args
            .plaintext_u128(registry_nonce)
            .encrypted_u128(ctx.accounts.nullifier_registry.pool_snapshot_ct);
        for ciphertext in ctx.accounts.nullifier_registry.encrypted_nullifiers.iter() {
            args = args.encrypted_u128(*ciphertext);
        }

        // claimed_secret_lo/hi: Enc<Shared, u128> — freshly encrypted by relayer
        let args = args
            .x25519_pubkey(claimed_secret_pub_key)
            .plaintext_u128(claimed_secret_nonce_lo)
            .encrypted_u128(claimed_secret_ct_lo)
            .x25519_pubkey(claimed_secret_pub_key)
            .plaintext_u128(claimed_secret_nonce_hi)
            .encrypted_u128(claimed_secret_ct_hi)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let note_key      = ctx.accounts.note_registry.key();
        let pool_key      = ctx.accounts.pool_state.key();
        let registry_key  = ctx.accounts.nullifier_registry.key();
        let vault_key     = ctx.accounts.vault.key();
        let recipient_key = ctx.accounts.recipient.key();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![WithdrawFromPoolCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount { pubkey: note_key,      is_writable: true },
                    CallbackAccount { pubkey: pool_key,      is_writable: true },
                    CallbackAccount { pubkey: registry_key,  is_writable: true },
                    CallbackAccount { pubkey: vault_key,     is_writable: true },
                    CallbackAccount { pubkey: recipient_key, is_writable: true },
                ],
            )?],
            1, 0,
        )?;

        emit!(WithdrawQueuedEvent {
            pool: ctx.accounts.pool_state.key(),
            computation_offset,
        });
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "withdraw_from_pool")]
    pub fn withdraw_from_pool_callback(
        ctx: Context<WithdrawFromPoolCallback>,
        output: SignedComputationOutputs<WithdrawFromPoolOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(WithdrawFromPoolOutput { field_0 }) => {
                let encrypted_output = field_0.field_0;
                let status_code = field_0.field_1;

                require!(
                    encrypted_output.ciphertexts.len() == 1 + NULLIFIER_REGISTRY_WORDS,
                    ErrorCode::InvalidNullifierRegistryOutput,
                );
                let registry_ciphertexts =
                    extract_registry_ciphertexts(&encrypted_output.ciphertexts[1..])?;
                let pool_key = ctx.accounts.pool_state.key();
                let pool = &mut ctx.accounts.pool_state;
                pool.encrypted_balance = encrypted_output.ciphertexts[0];
                pool.balance_nonce = encrypted_output.nonce;

                let registry = &mut ctx.accounts.nullifier_registry;
                registry.encrypted_nullifiers = registry_ciphertexts;
                registry.registry_nonce = encrypted_output.nonce;
                registry.pool_snapshot_ct = encrypted_output.ciphertexts[0];

                match status_code {
                    WITHDRAW_STATUS_ACCEPTED => {
                        let lamports = ctx.accounts.note_registry.lamports_for_transfer;

                        // PRIVACY: Direct lamport manipulation instead of system_program::transfer.
                        // The vault is a program-owned PDA, so we can decrease its lamports directly.
                        // This produces NO inner instruction log — block explorers won't show an
                        // explicit transfer. The amount can only be derived by comparing pre/post
                        // balance snapshots of the vault and recipient accounts.
                        let vault_info = ctx.accounts.vault.to_account_info();
                        let recipient_info = ctx.accounts.recipient.to_account_info();

                        let vault_balance = vault_info.lamports();
                        require!(vault_balance >= lamports, ErrorCode::InsufficientVault);

                        **vault_info.try_borrow_mut_lamports()? -= lamports;
                        **recipient_info.try_borrow_mut_lamports()? += lamports;

                        ctx.accounts.note_registry.status = NoteStatus::Withdrawn;
                        ctx.accounts.note_registry.lamports_for_transfer = 0;

                        emit!(WithdrawCompleteEvent { pool: pool_key });
                    }
                    WITHDRAW_STATUS_NULLIFIER_ALREADY_SPENT => {
                        ctx.accounts.note_registry.status = NoteStatus::Failed;
                        emit!(WithdrawRejectedEvent {
                            pool: pool_key,
                            reason_code: status_code,
                        });
                    }
                    WITHDRAW_STATUS_NULLIFIER_REGISTRY_FULL => {
                        ctx.accounts.note_registry.status = NoteStatus::Ready;
                        emit!(WithdrawRejectedEvent {
                            pool: pool_key,
                            reason_code: status_code,
                        });
                    }
                    WITHDRAW_STATUS_SECRET_MISMATCH => {
                        ctx.accounts.note_registry.status = NoteStatus::Ready;
                        emit!(WithdrawRejectedEvent {
                            pool: pool_key,
                            reason_code: status_code,
                        });
                    }
                    _ => return Err(ErrorCode::InvalidWithdrawStatusCode.into()),
                }
            }
            Err(e) => {
                msg!("withdraw_from_pool error: {}", e);
                ctx.accounts.note_registry.status = NoteStatus::Ready;
                return Err(ErrorCode::MpcFailed.into());
            }
        }
        Ok(())
    }

    // ── 4. Post-withdraw note cleanup ──────────────────────────────────────
    // After a successful withdrawal callback, the relayer can close the spent
    // note PDA entirely. This keeps the callback path stable while removing the
    // spent note from live chain state instead of leaving a public tombstone.

    pub fn compact_spent_note(
        ctx: Context<CompactSpentNote>,
        original_note_hash: [u8; 32],
    ) -> Result<()> {
        let note = &ctx.accounts.note_registry;
        require!(note.status == NoteStatus::Withdrawn, ErrorCode::NoteNotWithdrawn);
        require!(note.lamports_for_transfer == 0, ErrorCode::NoteAmountNotCleared);

        let _ = original_note_hash;
        Ok(())
    }

    // ── 5. Nullifier registry compaction (MPC) ─────────────────────────────
    // Resets the encrypted nullifier registry to zeros while preserving the
    // current pool balance. Called by the relayer when the registry is full.

    pub fn compact_registry(
        ctx: Context<CompactRegistry>,
        computation_offset: u64,
        denomination_lamports: u64,
    ) -> Result<()> {
        require!(ctx.accounts.pool_state.is_initialized, ErrorCode::PoolNotInitialized);

        let pool_nonce = ctx.accounts.pool_state.balance_nonce;

        let args = ArgBuilder::new()
            .plaintext_u128(pool_nonce)
            .encrypted_u64(ctx.accounts.pool_state.encrypted_balance)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let pool_key     = ctx.accounts.pool_state.key();
        let registry_key = ctx.accounts.nullifier_registry.key();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![CompactRegistryCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount { pubkey: pool_key,     is_writable: true },
                    CallbackAccount { pubkey: registry_key, is_writable: true },
                ],
            )?],
            1, 0,
        )?;

        emit!(RegistryCompactQueuedEvent {
            pool: pool_key,
            computation_offset,
        });
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "compact_registry")]
    pub fn compact_registry_callback(
        ctx: Context<CompactRegistryCallback>,
        output: SignedComputationOutputs<CompactRegistryOutput>,
    ) -> Result<()> {
        match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(CompactRegistryOutput { field_0 }) => {
                let encrypted_output = field_0;

                require!(
                    encrypted_output.ciphertexts.len() == 1 + NULLIFIER_REGISTRY_WORDS,
                    ErrorCode::InvalidNullifierRegistryOutput,
                );
                let registry_ciphertexts =
                    extract_registry_ciphertexts(&encrypted_output.ciphertexts[1..])?;

                let pool = &mut ctx.accounts.pool_state;
                pool.encrypted_balance = encrypted_output.ciphertexts[0];
                pool.balance_nonce = encrypted_output.nonce;

                let registry = &mut ctx.accounts.nullifier_registry;
                registry.encrypted_nullifiers = registry_ciphertexts;
                registry.registry_nonce = encrypted_output.nonce;
                registry.pool_snapshot_ct = encrypted_output.ciphertexts[0];

                emit!(RegistryCompactedEvent {
                    pool: ctx.accounts.pool_state.key(),
                });
            }
            Err(e) => {
                msg!("compact_registry error: {}", e);
                return Err(ErrorCode::MpcFailed.into());
            }
        }
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Account structs
// ─────────────────────────────────────────────────────────────────────────────

#[init_computation_definition_accounts("init_pool_balance", payer)]
#[derive(Accounts)]
pub struct InitInitPoolCompDef<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program:  Program<'info, Arcium>,
    pub system_program:  Program<'info, System>,
}

#[init_computation_definition_accounts("deposit_to_pool", payer)]
#[derive(Accounts)]
pub struct InitDepositCompDef<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program:  Program<'info, Arcium>,
    pub system_program:  Program<'info, System>,
}

#[init_computation_definition_accounts("withdraw_from_pool", payer)]
#[derive(Accounts)]
pub struct InitWithdrawCompDef<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program:  Program<'info, Arcium>,
    pub system_program:  Program<'info, System>,
}

#[queue_computation_accounts("init_pool_balance", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, denomination_lamports: u64)]
pub struct InitPool<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = PoolState::SPACE,
        seeds = [b"pool", denomination_lamports.to_le_bytes().as_ref()],
        bump
    )]
    pub pool_state: Box<Account<'info, PoolState>>,
    /// Vault PDA — program-owned account that holds pooled SOL.
    /// Owned by this program to enable direct lamport manipulation in withdraw
    /// callback (no system_program::transfer CPI = no inner instruction log).
    #[account(
        init,
        payer = payer,
        space = VaultAccount::SPACE,
        seeds = [b"vault", denomination_lamports.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, VaultAccount>>,
    #[account(
        init,
        payer = payer,
        space = NullifierRegistryState::SPACE,
        seeds = [b"nullifier_registry", denomination_lamports.to_le_bytes().as_ref()],
        bump
    )]
    pub nullifier_registry: Box<Account<'info, NullifierRegistryState>>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: Validated by Arcium.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: Validated by Arcium.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: Validated by Arcium.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_POOL))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program:  Program<'info, System>,
    pub arcium_program:  Program<'info, Arcium>,
}

#[callback_accounts("init_pool_balance")]
#[derive(Accounts)]
pub struct InitPoolBalanceCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_POOL))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: Validated by Arcium.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: Instructions sysvar.
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"pool", pool_state.denomination_lamports.to_le_bytes().as_ref()],
        bump = pool_state.bump
    )]
    pub pool_state: Box<Account<'info, PoolState>>,
    #[account(
        mut,
        seeds = [b"nullifier_registry", pool_state.denomination_lamports.to_le_bytes().as_ref()],
        bump = nullifier_registry.bump
    )]
    pub nullifier_registry: Box<Account<'info, NullifierRegistryState>>,
}

#[queue_computation_accounts("deposit_to_pool", sender)]
#[derive(Accounts)]
#[instruction(
    computation_offset: u64, transfer_ciphertext: [u8;32],
    transfer_pub_key: [u8;32], transfer_nonce: u128,
    secret_ciphertext_lo: [u8;32], secret_ciphertext_hi: [u8;32],
    secret_nonce_lo: u128, secret_nonce_hi: u128,
    recipient_hash: [u8;32], amount_lamports: u64, note_hash: [u8;32]
)]
pub struct Deposit<'info> {
    #[account(mut)] pub sender: Signer<'info>,
    #[account(
        mut,
        seeds = [b"pool", amount_lamports.to_le_bytes().as_ref()],
        bump = pool_state.bump,
        constraint = pool_state.denomination_lamports == amount_lamports @ ErrorCode::PoolDenominationMismatch
    )]
    pub pool_state: Box<Account<'info, PoolState>>,
    #[account(init, payer = sender, space = NoteAccount::SPACE, seeds = [b"note", note_hash.as_ref()], bump)]
    pub note_registry: Box<Account<'info, NoteAccount>>,
    #[account(
        mut,
        seeds = [b"vault", amount_lamports.to_le_bytes().as_ref()],
        bump = pool_state.vault_bump
    )]
    pub vault: Box<Account<'info, VaultAccount>>,
    #[account(init_if_needed, space = 9, payer = sender, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: Validated by Arcium.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: Validated by Arcium.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: Validated by Arcium.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_DEPOSIT))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program:  Program<'info, System>,
    pub arcium_program:  Program<'info, Arcium>,
}

#[callback_accounts("deposit_to_pool")]
#[derive(Accounts)]
pub struct DepositToPoolCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_DEPOSIT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: Validated by Arcium.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: Instructions sysvar.
    pub instructions_sysvar: AccountInfo<'info>,
    // Custom — order must match CallbackAccount vec in deposit()
    #[account(mut, seeds = [b"note", note_registry.note_hash.as_ref()], bump = note_registry.bump)]
    pub note_registry: Account<'info, NoteAccount>,
    #[account(
        mut,
        seeds = [b"pool", pool_state.denomination_lamports.to_le_bytes().as_ref()],
        bump = pool_state.bump
    )]
    pub pool_state: Account<'info, PoolState>,
}

/// Withdraw accounts — note that `amount_lamports` is deliberately absent from
/// instruction args. The transfer amount is read from `NoteAccount.lamports_for_transfer`
/// (set during deposit) to avoid leaking it in the withdraw transaction data.
#[queue_computation_accounts("withdraw_from_pool", relayer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct Withdraw<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(mut, seeds = [b"note", note_registry.note_hash.as_ref()], bump = note_registry.bump)]
    pub note_registry: Box<Account<'info, NoteAccount>>,
    #[account(
        mut,
        seeds = [b"pool", note_registry.lamports_for_transfer.to_le_bytes().as_ref()],
        bump = pool_state.bump,
        constraint = pool_state.denomination_lamports == note_registry.lamports_for_transfer @ ErrorCode::PoolDenominationMismatch
    )]
    pub pool_state: Box<Account<'info, PoolState>>,
    #[account(
        mut,
        seeds = [b"vault", note_registry.lamports_for_transfer.to_le_bytes().as_ref()],
        bump = pool_state.vault_bump
    )]
    pub vault: Box<Account<'info, VaultAccount>>,
    #[account(
        mut,
        seeds = [b"nullifier_registry", note_registry.lamports_for_transfer.to_le_bytes().as_ref()],
        bump = nullifier_registry.bump
    )]
    pub nullifier_registry: Box<Account<'info, NullifierRegistryState>>,
    /// CHECK: Verified by SHA256(note_secret || recipient.key()) == note.recipient_hash in withdraw().
    #[account(mut)]
    pub recipient: SystemAccount<'info>,
    #[account(init_if_needed, space = 9, payer = relayer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: Validated by Arcium.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: Validated by Arcium.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: Validated by Arcium.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_WITHDRAW))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program:  Program<'info, System>,
    pub arcium_program:  Program<'info, Arcium>,
}

#[callback_accounts("withdraw_from_pool")]
#[derive(Accounts)]
pub struct WithdrawFromPoolCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_WITHDRAW))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: Validated by Arcium.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: Instructions sysvar.
    pub instructions_sysvar: AccountInfo<'info>,
    // Custom — order must match CallbackAccount vec in withdraw()
    #[account(mut, seeds = [b"note", note_registry.note_hash.as_ref()], bump = note_registry.bump)]
    pub note_registry: Box<Account<'info, NoteAccount>>,
    #[account(
        mut,
        seeds = [b"pool", pool_state.denomination_lamports.to_le_bytes().as_ref()],
        bump = pool_state.bump
    )]
    pub pool_state: Box<Account<'info, PoolState>>,
    #[account(
        mut,
        seeds = [b"nullifier_registry", pool_state.denomination_lamports.to_le_bytes().as_ref()],
        bump = nullifier_registry.bump
    )]
    pub nullifier_registry: Box<Account<'info, NullifierRegistryState>>,
    /// Vault PDA — program-owned, enabling direct lamport manipulation
    /// without a system_program::transfer CPI (no inner instruction log).
    #[account(
        mut,
        seeds = [b"vault", pool_state.denomination_lamports.to_le_bytes().as_ref()],
        bump = pool_state.vault_bump
    )]
    pub vault: Box<Account<'info, VaultAccount>>,
    #[account(mut)]
    /// CHECK: Verified during withdraw().
    pub recipient: SystemAccount<'info>,
}

#[derive(Accounts)]
#[instruction(original_note_hash: [u8; 32])]
pub struct CompactSpentNote<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(
        mut,
        close = relayer,
        seeds = [b"note", original_note_hash.as_ref()],
        bump = note_registry.bump
    )]
    pub note_registry: Box<Account<'info, NoteAccount>>,
}

#[init_computation_definition_accounts("compact_registry", payer)]
#[derive(Accounts)]
pub struct InitCompactCompDef<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program:  Program<'info, Arcium>,
    pub system_program:  Program<'info, System>,
}

#[queue_computation_accounts("compact_registry", relayer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, denomination_lamports: u64)]
pub struct CompactRegistry<'info> {
    #[account(mut)] pub relayer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"pool", denomination_lamports.to_le_bytes().as_ref()],
        bump = pool_state.bump
    )]
    pub pool_state: Box<Account<'info, PoolState>>,
    #[account(
        mut,
        seeds = [b"nullifier_registry", denomination_lamports.to_le_bytes().as_ref()],
        bump = nullifier_registry.bump
    )]
    pub nullifier_registry: Box<Account<'info, NullifierRegistryState>>,
    #[account(init_if_needed, space = 9, payer = relayer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: Validated by Arcium.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: Validated by Arcium.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: Validated by Arcium.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_COMPACT))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program:  Program<'info, System>,
    pub arcium_program:  Program<'info, Arcium>,
}

#[callback_accounts("compact_registry")]
#[derive(Accounts)]
pub struct CompactRegistryCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_COMPACT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: Validated by Arcium.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: Instructions sysvar.
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"pool", pool_state.denomination_lamports.to_le_bytes().as_ref()],
        bump = pool_state.bump
    )]
    pub pool_state: Box<Account<'info, PoolState>>,
    #[account(
        mut,
        seeds = [b"nullifier_registry", pool_state.denomination_lamports.to_le_bytes().as_ref()],
        bump = nullifier_registry.bump
    )]
    pub nullifier_registry: Box<Account<'info, NullifierRegistryState>>,
}

// ─────────────────────────────────────────────────────────────────────────────
// State accounts
// ─────────────────────────────────────────────────────────────────────────────

/// Denomination-specific pool state — PDA seeded by `[b"pool", denomination_le]`.
///
/// `encrypted_balance` holds the running total of all deposited-minus-withdrawn
/// SOL as an `Enc<Mxe, u64>` ciphertext. Only the Arcium MPC cluster can
/// decrypt it. On-chain observers see 32 opaque bytes.
#[account]
pub struct PoolState {
    /// Enc<Mxe, u64> — the pool's encrypted running balance.
    pub encrypted_balance: [u8; 32],
    /// Output nonce from the last MPC computation. Required to pass the
    /// ciphertext back as an `Enc<Mxe>` input to the next computation.
    pub balance_nonce:     u128,
    /// Fixed lamport denomination routed through this pool.
    pub denomination_lamports: u64,
    /// Set to `true` by `init_pool_balance_callback`. Blocks deposits until
    /// a valid `Enc<Mxe, 0>` is established.
    pub is_initialized:    bool,
    /// PDA bump for the pool state account.
    pub bump:              u8,
    /// PDA bump for the vault account.
    pub vault_bump:        u8,
}

impl PoolState {
    pub const SPACE: usize = 8 + 32 + 16 + 8 + 1 + 1 + 1;
}

/// Program-owned vault PDA seeded by `[b"vault", denomination_le]`.
///
/// Holds the pooled SOL. Because the account is owned by this program (not the
/// System Program), the withdraw callback can directly manipulate lamports
/// without a `system_program::transfer` CPI. This means no explicit transfer
/// instruction appears in the transaction's inner instruction logs.
#[account]
pub struct VaultAccount {
    /// PDA bump.
    pub bump: u8,
}

impl VaultAccount {
    pub const SPACE: usize = 8 + 1;
}

/// Denomination-scoped encrypted nullifier registry.
///
/// The registry stores a bounded list of spent-nullifier words under MXE
/// encryption. The first word is the current entry count; the remaining words
/// are 2-limb (`u128`, `u128`) nullifier entries.
#[account]
pub struct NullifierRegistryState {
    /// Enc<Mxe, [u128; N]> flattened into ciphertext words.
    pub encrypted_nullifiers: [[u8; 32]; NULLIFIER_REGISTRY_WORDS],
    /// Nonce shared by every encrypted word in the registry output.
    pub registry_nonce: u128,
    /// Enc<Mxe, u64> — pool balance snapshot at element-0 of the struct output.
    /// Stored to preserve CTR-mode keystream positions when passing the full
    /// struct back to the withdraw circuit.
    pub pool_snapshot_ct: [u8; 32],
    /// PDA bump.
    pub bump: u8,
}

impl NullifierRegistryState {
    pub const SPACE: usize = 8 + (NULLIFIER_REGISTRY_WORDS * 32) + 16 + 32 + 1;
}

/// Per-transfer note — PDA seeded by `[b"note", note_hash]`.
///
/// Lifecycle: `PendingMpc` → `Ready` → `Withdrawn` (transient) → closed
/// (or `Failed`).
///
/// **Privacy**:
/// - `encrypted_amount` is `Enc<Mxe, u64>` — only the MPC cluster can read it.
/// - `recipient_hash` is `SHA256(note_secret ∥ recipient_pubkey)` — the recipient
///   is hidden until withdrawal. No plaintext pubkey stored on-chain.
/// - `lamports_for_transfer` is plaintext but is set during deposit (when the
///   amount is already visible via the SOL CPI), NOT during withdraw.
#[account]
pub struct NoteAccount {
    /// `SHA256(note_secret ∥ recipient ∥ amount_lamports_le)` — commitment
    /// that reveals nothing without the 32-byte preimage.
    pub note_hash:             [u8; 32],
    /// Current lifecycle status of this note.
    pub status:                NoteStatus,
    /// `SHA256(withdraw_key ∥ recipient_pubkey)` — hides the recipient until
    /// withdrawal. The withdraw_key is a separate random value from note_secret,
    /// ensuring that on-chain recipient verification reveals nothing about the
    /// note secret or deposit linkage.
    pub recipient_hash:        [u8; 32],
    /// `Enc<Mxe, u64>` — this note's encrypted amount. Set by deposit_callback.
    pub encrypted_amount:      [u8; 32],
    /// `Enc<Mxe, u128>` — lower 128 bits of the note secret, encrypted for MXE.
    /// Used by the withdraw MPC circuit to verify secret ownership without
    /// the plaintext secret ever appearing on-chain.
    pub encrypted_secret_lo:   [u8; 32],
    /// `Enc<Mxe, u128>` — upper 128 bits of the note secret, encrypted for MXE.
    pub encrypted_secret_hi:   [u8; 32],
    /// `Enc<Mxe, u64>` — pool balance snapshot at element-0 of the DepositOutput
    /// struct. Stored to preserve CTR-mode keystream positions when the full
    /// struct is passed back to the withdraw circuit.
    pub encrypted_pool_at_deposit: [u8; 32],
    /// Nonce for all `Enc<Mxe>` ciphertexts from the deposit callback output.
    pub amount_nonce:          u128,
    /// Plaintext lamport amount for the SOL transfer. Set during deposit (when
    /// the amount is already visible in the SOL CPI). Read by the withdraw
    /// callback to execute the `vault → recipient` transfer.
    pub lamports_for_transfer: u64,
    /// PDA bump.
    pub bump:                  u8,
}

impl NoteAccount {
    pub const SPACE: usize = 8 + 32 + 1 + 32 + 32 + 32 + 32 + 32 + 16 + 8 + 1;
}

/// Note lifecycle status while the note account exists on-chain.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum NoteStatus {
    /// MPC computation queued but callback not yet received.
    PendingMpc,
    /// Deposit confirmed — note is spendable.
    Ready,
    /// Withdraw completed. The relayer cleanup step can now close the note PDA.
    Withdrawn,
    /// MPC computation failed.
    Failed,
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

#[event] pub struct PoolInitializedEvent   { pub pool: Pubkey }
#[event] pub struct DepositQueuedEvent     { pub pool: Pubkey, pub computation_offset: u64 }
#[event] pub struct DepositConfirmedEvent  { pub pool: Pubkey }
#[event] pub struct WithdrawQueuedEvent    { pub pool: Pubkey, pub computation_offset: u64 }
#[event] pub struct WithdrawCompleteEvent  { pub pool: Pubkey }
#[event] pub struct WithdrawRejectedEvent  { pub pool: Pubkey, pub reason_code: u8 }
#[event] pub struct RegistryCompactQueuedEvent { pub pool: Pubkey, pub computation_offset: u64 }
#[event] pub struct RegistryCompactedEvent  { pub pool: Pubkey }

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

#[error_code]
pub enum ErrorCode {
    #[msg("Pool not initialised — call init_pool first")]           PoolNotInitialized,
    #[msg("Note not in Ready status")]                              NoteNotReady,
    #[msg("Note is not in Withdrawn status")]                       NoteNotWithdrawn,
    #[msg("Note amount has not been cleared yet")]                  NoteAmountNotCleared,
    #[msg("Recipient does not match note")]                         RecipientMismatch,
    #[msg("Amount must be > 0")]                                    ZeroAmount,
    #[msg("Pool denomination does not match the note amount")]      PoolDenominationMismatch,
    #[msg("Arcium MPC computation failed")]                         MpcFailed,
    #[msg("Arcium cluster not set")]                                ClusterNotSet,
    #[msg("Vault has insufficient lamports for withdrawal")]        InsufficientVault,
    #[msg("Unexpected nullifier registry ciphertext shape")]        InvalidNullifierRegistryOutput,
    #[msg("Unexpected withdraw status code from MPC output")]       InvalidWithdrawStatusCode,
    #[msg("Off-chain circuit override requires both source URL and 32-byte hash")] InvalidCircuitSourceOverride,
}
