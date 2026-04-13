/// Lowkie — Arcis MPC Circuits
///
/// These three circuits run inside Arcium's MPC cluster.
/// No ARX node ever sees plaintext — all computation is on secret-shared data.
///
/// Enc<Shared, T>  — encrypted with a shared secret between client and MXE.
///                   Both sender and MXE cluster can decrypt. Used for fresh
///                   user inputs (transfer amounts the sender encrypts locally).
///
/// Enc<Mxe, T>     — encrypted exclusively for the MXE cluster. Only the
///                   ARX nodes jointly can decrypt. Used for persistent
///                   on-chain state: pool balance, note amounts.
///
/// This is the pattern C-SPL will standardise. We implement it directly via
/// the MXE framework — the same arcium-anchor crates C-SPL itself uses.

use arcis::encrypted;

#[encrypted]
mod circuits {
    use arcis::*;

    const NULLIFIER_REGISTRY_CAPACITY: usize = 4;
    const NULLIFIER_WORDS_PER_ENTRY: usize = 2;
    const NULLIFIER_REGISTRY_WORDS: usize =
        1 + NULLIFIER_REGISTRY_CAPACITY * NULLIFIER_WORDS_PER_ENTRY;

    pub type NullifierRegistry = [u128; NULLIFIER_REGISTRY_WORDS];

    #[derive(Copy, Clone)]
    pub struct PoolInitOutput {
        pool_balance: u64,
        nullifier_registry: NullifierRegistry,
    }

    #[derive(Copy, Clone)]
    pub struct DepositOutput {
        new_pool_balance: u64,
        note_amount:      u64,
        note_secret_lo:   u128,
        note_secret_hi:   u128,
    }

    #[derive(Copy, Clone)]
    pub struct WithdrawOutput {
        new_pool_balance: u64,
        nullifier_registry: NullifierRegistry,
    }

    // ── init_pool_balance ─────────────────────────────────────────────────────
    // Creates Enc<Mxe, 0> — the pool's starting encrypted balance.
    // Must be MPC-generated; only the cluster can produce valid Enc<Mxe> ciphertexts.
    //
    // ArgBuilder order:
    //   Argument::ArcisPubkey(dummy_pub_key)
    //   Argument::PlaintextU128(dummy_nonce)
    //   Argument::EncryptedU64(dummy_ciphertext)

    #[instruction]
    pub fn init_pool_balance(dummy: Enc<Shared, u64>) -> Enc<Mxe, PoolInitOutput> {
        let _ = dummy;
        Mxe::get().from_arcis(PoolInitOutput {
            pool_balance: 0u64,
            nullifier_registry: [0u128; NULLIFIER_REGISTRY_WORDS],
        })
    }

    // ── deposit_to_pool ───────────────────────────────────────────────────────
    // Adds sender's Enc<Shared> amount to the pool's Enc<Mxe> running balance.
    //
    // ArgBuilder order (MUST match parameter order exactly):
    //   Argument::ArcisPubkey(sender_pub_key)         ← Enc<Shared> header
    //   Argument::PlaintextU128(transfer_nonce)
    //   Argument::EncryptedU64(transfer_ciphertext)   ← Enc<Shared, amount>
    //   Argument::PlaintextU128(pool_balance_nonce)   ← Enc<Mxe> header
    //   Argument::EncryptedU64(pool_encrypted_balance) ← Enc<Mxe, pool_total>

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

    // ── withdraw_from_pool ────────────────────────────────────────────────────
    // Subtracts a note's Enc<Mxe> amount from the pool's Enc<Mxe> balance.
    //
    // IMPORTANT: deposit_data and registry_data must be passed as COMPLETE
    // structs (all ciphertexts, including unused pool-snapshot at element 0)
    // to preserve CTR-mode keystream positions. The RescueCipher encrypts
    // each element with a position-dependent keystream; re-indexing causes
    // decryption to incorrect values.

    #[instruction]
    pub fn withdraw_from_pool(
        deposit_data: Enc<Mxe, DepositOutput>,
        pool: Enc<Mxe, u64>,
        registry_data: Enc<Mxe, WithdrawOutput>,
        claimed_secret_lo: Enc<Shared, u128>,
        claimed_secret_hi: Enc<Shared, u128>,
    ) -> (Enc<Mxe, WithdrawOutput>, u8) {
        let deposit      = deposit_data.to_arcis();
        let note_amount  = deposit.note_amount;
        let pool_balance = pool.to_arcis();
        let reg          = registry_data.to_arcis();
        let mut nullifier_registry = reg.nullifier_registry;

        let s_lo = deposit.note_secret_lo;
        let s_hi = deposit.note_secret_hi;
        let c_lo = claimed_secret_lo.to_arcis();
        let c_hi = claimed_secret_hi.to_arcis();

        // Verify secret ownership inside MPC — never revealed on-chain
        let secret_valid = s_lo == c_lo && s_hi == c_hi;

        // Use the secret itself as the nullifier (registry is encrypted,
        // so no information leaks). No SHA256 needed inside MPC.
        let nullifier_lo = s_lo;
        let nullifier_hi = s_hi;

        let count = nullifier_registry[0];

        let mut duplicate = false;
        for idx in 0..NULLIFIER_REGISTRY_CAPACITY {
            let slot_is_populated = (idx as u128) < count;
            let base = 1 + idx * NULLIFIER_WORDS_PER_ENTRY;
            let slot_matches =
                nullifier_registry[base] == nullifier_lo &&
                nullifier_registry[base + 1] == nullifier_hi;
            if slot_is_populated && slot_matches {
                duplicate = true;
            }
        }

        let has_capacity = count < NULLIFIER_REGISTRY_CAPACITY as u128;
        let accepted = secret_valid && !duplicate && has_capacity;

        if accepted {
            for idx in 0..NULLIFIER_REGISTRY_CAPACITY {
                let should_insert = (idx as u128) == count;
                let base = 1 + idx * NULLIFIER_WORDS_PER_ENTRY;
                if should_insert {
                    nullifier_registry[base] = nullifier_lo;
                    nullifier_registry[base + 1] = nullifier_hi;
                }
            }
            nullifier_registry[0] = count + 1;
        }

        let new_pool = if accepted {
            pool_balance - note_amount
        } else {
            pool_balance
        };

        let status_code = if !secret_valid {
            3u8
        } else if duplicate {
            1u8
        } else if has_capacity {
            0u8
        } else {
            2u8
        };

        (
            pool.owner.from_arcis(WithdrawOutput {
                new_pool_balance: new_pool,
                nullifier_registry,
            }),
            status_code.reveal(),
        )
    }

    // ── compact_registry ──────────────────────────────────────────────────────
    // Resets the encrypted nullifier registry to all zeros while preserving the
    // current pool balance. Called by the relayer when the registry is full.
    //
    // SECURITY: This clears double-spend protection for previously-spent notes.
    // The caller (on-chain instruction) should gate this appropriately.
    //
    // ArgBuilder order:
    //   Argument::PlaintextU128(pool_balance_nonce)
    //   Argument::EncryptedU64(pool_encrypted_balance)

    #[instruction]
    pub fn compact_registry(pool: Enc<Mxe, u64>) -> Enc<Mxe, WithdrawOutput> {
        let pool_balance = pool.to_arcis();
        pool.owner.from_arcis(WithdrawOutput {
            new_pool_balance: pool_balance,
            nullifier_registry: [0u128; NULLIFIER_REGISTRY_WORDS],
        })
    }
}
