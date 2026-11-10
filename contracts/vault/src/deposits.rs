use super::*;
use near_sdk::collections::LookupMap;

const CAPACITY_ALLOWANCE: u128 = 1_000_000_000_000_000_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum NativeClaimStatus {
    Idle,
    Pending,
    Settled,
    Failed,
    ReceiptAcknowledged,
}

// Fixed-width claim fields avoid allocating history during refunds/callbacks.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct NativeDeposit {
    pub owner: AccountId,
    pub deposited: U128,
    pub call_deposits_spent: U128,
    pub refunded: U128,
    pub pending: U128,
    pub storage_bytes: U64,
    pub claim_sequence: U64,
    pub claim_status: NativeClaimStatus,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
struct NativePool {
    // Deposited minus spent, refunded and in-flight native transfers.
    credits: u128,
    tracked_bytes: u64,
}

#[near(serializers = [json])]
pub struct NativeDepositView {
    pub tracked: bool,
    pub deposit: Option<NativeDeposit>,
    pub storage_backing: U128,
    pub retained_required: U128,
    pub claimable: U128,
    pub margin_percent: u32,
    pub invoice_limit: u32,
    pub payment_attempt_limit: u32,
}

impl Vault {
    fn native_deposits() -> LookupMap<String, NativeDeposit> {
        LookupMap::new(b"accord:native-deposit:v1:".to_vec())
    }
    fn native_pool() -> LookupMap<u8, NativePool> {
        LookupMap::new(b"accord:native-pool:v1:".to_vec())
    }
    fn native_net(d: &NativeDeposit) -> u128 {
        d.deposited
            .0
            .checked_sub(d.call_deposits_spent.0)
            .and_then(|n| n.checked_sub(d.refunded.0))
            .and_then(|n| n.checked_sub(d.pending.0))
            .unwrap_or_else(|| env::panic_str("Invalid native credit accounting"))
    }
    fn native_backing(d: &NativeDeposit) -> u128 {
        (d.storage_bytes.0 as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| env::panic_str("Native storage overflow"))
    }
    fn native_margin(d: &NativeDeposit) -> u128 {
        let cost = Self::native_backing(d);
        cost.checked_add(cost.checked_add(3).unwrap() / 4)
            .unwrap_or_else(|| env::panic_str("Native reserve overflow"))
    }
    fn native_held(&self, id: &String, d: &NativeDeposit) -> u128 {
        let retained = Self::native_margin(d);
        if self.recovery(id).phase == ClosePhase::Closed {
            retained
        } else {
            retained.max(CAPACITY_ALLOWANCE.saturating_sub(d.call_deposits_spent.0))
        }
    }
    fn native_budget(&self, outgoing: u128) {
        let Some(pool) = Self::native_pool().get(&0) else {
            return;
        };
        let untracked = env::storage_usage()
            .checked_sub(pool.tracked_bytes)
            .unwrap_or_else(|| env::panic_str("Invalid native storage attribution"));
        let required = (untracked as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .and_then(|n| n.checked_add(pool.credits))
            .and_then(|n| n.checked_add(outgoing))
            .unwrap_or_else(|| env::panic_str("Native protection overflow"));
        require!(
            env::account_balance().as_yoctonear() >= required,
            "Native credits or platform storage need funding"
        );
    }
    pub(crate) fn start_native_deposit(&self) {
        // Platform metadata belongs to platform storage, not the first customer's ledger.
        if Self::native_pool().get(&0).is_none() {
            Self::native_pool().insert(&0, &NativePool::default());
        }
    }
    pub(crate) fn create_native_deposit(&self, id: &String, owner: &AccountId, before: u64) {
        let d = NativeDeposit {
            owner: owner.clone(),
            deposited: U128(env::attached_deposit().as_yoctonear()),
            call_deposits_spent: U128(0),
            refunded: U128(0),
            pending: U128(0),
            storage_bytes: U64(0),
            claim_sequence: U64(0),
            claim_status: NativeClaimStatus::Idle,
        };
        require!(
            Self::native_deposits().get(id).is_none(),
            "Native credit already exists"
        );
        Self::native_deposits().insert(id, &d);
        let mut pool = Self::native_pool().get(&0).unwrap();
        pool.credits = pool.credits.checked_add(d.deposited.0).unwrap();
        Self::native_pool().insert(&0, &pool);
        self.meter_native_storage(id, before, 0);
    }
    pub(crate) fn meter_native_storage(&self, id: &String, before: u64, call_deposit: u128) {
        let after = env::storage_usage();
        // Fixed-size receipt finalization must remain possible even if platform
        // funding needs repair. It neither grows storage nor spends native credit.
        if after == before && call_deposit == 0 {
            return;
        }
        if let Some(mut d) = Self::native_deposits().get(id) {
            let mut pool = Self::native_pool().get(&0).unwrap();
            if after >= before {
                let added = after - before;
                d.storage_bytes.0 = d.storage_bytes.0.checked_add(added).unwrap();
                pool.tracked_bytes = pool.tracked_bytes.checked_add(added).unwrap();
            } else {
                let removed = before - after;
                d.storage_bytes.0 = d.storage_bytes.0.checked_sub(removed).unwrap();
                pool.tracked_bytes = pool.tracked_bytes.checked_sub(removed).unwrap();
            }
            d.call_deposits_spent.0 = d.call_deposits_spent.0.checked_add(call_deposit).unwrap();
            pool.credits = pool.credits.checked_sub(call_deposit).unwrap();
            if after > before || call_deposit > 0 {
                require!(
                    Self::native_net(&d) >= Self::native_margin(&d),
                    "Top up this order's native storage budget"
                );
            }
            Self::native_deposits().insert(id, &d);
            Self::native_pool().insert(&0, &pool);
        }
        // Legacy growth must not consume tracked customer credits either.
        if after > before || call_deposit > 0 {
            self.native_budget(call_deposit);
        }
    }
    fn native_wallet_owner(&self, id: &String) -> NativeDeposit {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Attach exactly 1 yoctoNEAR for native credit approval"
        );
        let d = Self::native_deposits()
            .get(id)
            .unwrap_or_else(|| env::panic_str("Historical native deposit is untracked"));
        require!(
            env::predecessor_account_id() == d.owner,
            "Native deposit owner only"
        );
        d
    }
}

#[near]
impl Vault {
    #[payable]
    pub fn cancel_unfunded_order(&mut self, order_id: String) {
        self.native_wallet_owner(&order_id);
        let order = self.order(&order_id);
        require!(
            order.funded.0 == 0
                && order.accepted.0 == 0
                && order.paid.0 == 0
                && order.pending.0 == 0,
            "Only an unfunded order without deliveries can be cancelled"
        );
        let mut r = self.recovery(&order_id);
        require!(
            r.phase == ClosePhase::Open && r.refund_pending.0 == 0,
            "Order is already closing or closed"
        );
        r.phase = ClosePhase::Closed;
        r.proposal = None;
        self.save_recovery(&order_id, &r);
        event("unfunded_order_cancelled", json!({"order_id":order_id}));
    }

    pub fn get_native_deposit(&self, order_id: String) -> NativeDepositView {
        self.order(&order_id);
        let deposit = Self::native_deposits().get(&order_id);
        let (backing, retained, available) = deposit.as_ref().map_or((0, 0, 0), |d| {
            let held = self.native_held(&order_id, d);
            let r = self.recovery(&order_id);
            let o = self.order(&order_id);
            let allowed = d.pending.0 == 0
                && o.pending.0 == 0
                && r.refund_pending.0 == 0
                && matches!(r.phase, ClosePhase::Open | ClosePhase::Closed);
            (
                Self::native_backing(d),
                held,
                if allowed {
                    Self::native_net(d).saturating_sub(held)
                } else {
                    0
                },
            )
        });
        NativeDepositView {
            tracked: deposit.is_some(),
            deposit,
            storage_backing: U128(backing),
            retained_required: U128(retained),
            claimable: U128(available),
            margin_percent: 25,
            invoice_limit: 32,
            payment_attempt_limit: MAX_ATTEMPTS,
        }
    }

    #[payable]
    pub fn top_up_order_storage(&mut self, order_id: String) {
        let mut d = Self::native_deposits()
            .get(&order_id)
            .unwrap_or_else(|| env::panic_str("Historical native deposit is untracked"));
        require!(
            env::predecessor_account_id() == d.owner,
            "Native deposit owner only"
        );
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Attach a positive storage top-up");
        let mut pool = Self::native_pool().get(&0).unwrap();
        d.deposited.0 = d.deposited.0.checked_add(amount).unwrap();
        pool.credits = pool.credits.checked_add(amount).unwrap();
        Self::native_deposits().insert(&order_id, &d);
        Self::native_pool().insert(&0, &pool);
        self.native_budget(0);
        event(
            "native_deposit_topped_up",
            json!({"order_id":order_id,"amount":U128(amount)}),
        );
    }

    #[payable]
    pub fn claim_native_excess(&mut self, order_id: String) -> Promise {
        let mut d = self.native_wallet_owner(&order_id);
        require!(
            env::prepaid_gas() >= Gas::from_tgas(40),
            "Attach at least 40 Tgas"
        );
        let available = self.get_native_deposit(order_id.clone()).claimable.0;
        require!(available > 0, "No native excess is currently refundable");
        let mut pool = Self::native_pool().get(&0).unwrap();
        d.claim_sequence.0 = d.claim_sequence.0.checked_add(1).unwrap();
        d.pending = U128(available);
        d.claim_status = NativeClaimStatus::Pending;
        pool.credits = pool.credits.checked_sub(available).unwrap();
        Self::native_deposits().insert(&order_id, &d);
        Self::native_pool().insert(&0, &pool);
        self.native_budget(available);
        event(
            "native_refund_reserved",
            json!({"order_id":order_id,"sequence":d.claim_sequence,"amount":d.pending,"recipient":d.owner}),
        );
        #[cfg(feature = "native-transfer-failure")]
        let recipient: AccountId = "native-transfer-missing.test.near".parse().unwrap();
        #[cfg(not(feature = "native-transfer-failure"))]
        let recipient = d.owner;
        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(available))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_native_refund_result(order_id, d.claim_sequence),
            )
    }

    #[private]
    pub fn on_native_refund_result(
        &mut self,
        order_id: String,
        sequence: U64,
    ) -> CallbackDisposition {
        if env::promise_results_count() != 1 {
            return CallbackDisposition::NeedsReconciliation;
        }
        let success = match env::promise_result_checked(0, 1024) {
            Ok(_) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => return CallbackDisposition::NeedsReconciliation,
        };
        self.finish_native_refund(order_id, sequence, success, false)
    }

    #[payable]
    pub fn acknowledge_native_refund(
        &mut self,
        order_id: String,
        sequence: U64,
    ) -> CallbackDisposition {
        self.native_wallet_owner(&order_id);
        self.finish_native_refund(order_id, sequence, true, true)
    }
}

impl Vault {
    fn finish_native_refund(
        &self,
        order_id: String,
        sequence: U64,
        success: bool,
        acknowledged: bool,
    ) -> CallbackDisposition {
        let Some(mut d) = Self::native_deposits().get(&order_id) else {
            return CallbackDisposition::NeedsReconciliation;
        };
        if d.claim_sequence != sequence
            || d.claim_status != NativeClaimStatus::Pending
            || d.pending.0 == 0
        {
            return CallbackDisposition::AlreadyFinalized;
        }
        if success {
            d.refunded.0 = d.refunded.0.checked_add(d.pending.0).unwrap();
            d.claim_status = if acknowledged {
                NativeClaimStatus::ReceiptAcknowledged
            } else {
                NativeClaimStatus::Settled
            };
        } else {
            let mut pool = Self::native_pool().get(&0).unwrap();
            pool.credits = pool.credits.checked_add(d.pending.0).unwrap();
            Self::native_pool().insert(&0, &pool);
            d.claim_status = NativeClaimStatus::Failed;
        }
        d.pending = U128(0);
        Self::native_deposits().insert(&order_id, &d);
        event(
            "native_refund_result",
            json!({"order_id":order_id,"sequence":sequence,"deposit":d}),
        );
        if success {
            CallbackDisposition::Settled
        } else {
            CallbackDisposition::TransferFailed
        }
    }
}
