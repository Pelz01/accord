use super::*;
use near_sdk::collections::LookupMap;

const REFUND_HISTORY: usize = 8;
const CLOSE_TTL_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ClosePhase {
    Open,
    RefundPending,
    RefundFailed,
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct CloseProposal {
    pub hash: String,
    pub proposed_by: AccountId,
    pub expires_at: U64,
    pub refund_amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RefundAttempt {
    pub id: u32,
    pub amount: U128,
    pub recipient: AccountId,
    pub status: AttemptStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RecoveryState {
    pub phase: ClosePhase,
    pub proposal: Option<CloseProposal>,
    pub refund_pending: U128,
    pub refunded: U128,
    pub refunds: Vec<RefundAttempt>,
}

impl Default for RecoveryState {
    fn default() -> Self {
        Self {
            phase: ClosePhase::Open,
            proposal: None,
            refund_pending: U128(0),
            refunded: U128(0),
            refunds: vec![],
        }
    }
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub enum RefundDisposition {
    Closed,
    TransferFailed,
    AlreadyFinalized,
    NeedsReconciliation,
}

impl Vault {
    // A separate, fixed-prefix LookupMap preserves the deployed Vault, Order,
    // Terms and Attempt storage layouts. No privileged state reset is needed.
    fn recovery_map() -> LookupMap<String, RecoveryState> {
        LookupMap::new(b"accord:recovery:v1:".to_vec())
    }

    pub(crate) fn recovery(&self, order_id: &String) -> RecoveryState {
        Self::recovery_map().get(order_id).unwrap_or_default()
    }

    fn save_recovery(&mut self, order_id: &String, state: &RecoveryState) {
        Self::recovery_map().insert(order_id, state);
    }

    fn close_ready(&self, order: &Order, state: &RecoveryState) {
        self.active(order);
        require!(
            state.phase == ClosePhase::Open,
            "Order is closing or closed"
        );
        require!(
            order.pending.0 == 0 && state.refund_pending.0 == 0,
            "Unresolved transfer"
        );
        require!(
            order.paid.0 == order.accepted.0,
            "Settle all accepted deliveries first"
        );
        require!(
            state.refunded.0 == 0 && state.refunds.is_empty(),
            "Refund already started"
        );
    }

    fn close_hash(&self, order: &Order, proposed_by: &AccountId, expires_at: U64) -> String {
        digest(
            &near_sdk::borsh::to_vec(&(
                "accord-close-v1",
                &self.network,
                env::current_account_id(),
                order,
                proposed_by,
                expires_at,
            ))
            .unwrap_or_else(|_| env::panic_str("Cannot encode closure")),
        )
    }

    fn dispatch_refund(&mut self, order: &Order, mut state: RecoveryState) -> Promise {
        require!(
            env::prepaid_gas() >= Gas::from_tgas(80),
            "Attach at least 80 Tgas"
        );
        let amount = order
            .funded
            .0
            .checked_sub(
                order
                    .terms
                    .unit_price
                    .0
                    .checked_mul(order.paid.0 as u128)
                    .unwrap_or_else(|| env::panic_str("Amount overflow")),
            )
            .and_then(|v| v.checked_sub(state.refunded.0))
            .unwrap_or_else(|| env::panic_str("Invalid refund accounting"));
        require!(
            amount > 0 && state.refund_pending.0 == 0,
            "No refundable balance"
        );
        let id = state
            .refunds
            .last()
            .map_or(0, |r| r.id)
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Refund sequence exhausted"));
        let refund = RefundAttempt {
            id,
            amount: U128(amount),
            recipient: order.buyer.clone(),
            status: AttemptStatus::Reserved,
        };
        state.phase = ClosePhase::RefundPending;
        state.proposal = None;
        state.refund_pending = U128(amount);
        if state.refunds.len() == REFUND_HISTORY {
            state.refunds.remove(0);
        }
        state.refunds.push(refund.clone());
        self.save_recovery(&order.id, &state);
        event(
            "refund_reserved",
            json!({"order_id":order.id,"refund":refund}),
        );
        Promise::new(self.token.clone())
            .function_call(
                "ft_transfer",
                json!({"receiver_id":order.buyer,"amount":U128(amount),"memo":format!("Accord refund {}:{}",order.id,id)})
                    .to_string().into_bytes(),
                NearToken::from_yoctonear(1), TRANSFER_GAS,
            )
            .then(Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS).with_unused_gas_weight(0)
                .on_refund_result(order.id.clone(), id))
    }

    fn finish_refund(
        &mut self,
        order_id: String,
        refund_id: u32,
        success: bool,
        acknowledged: bool,
    ) -> RefundDisposition {
        let mut state = self.recovery(&order_id);
        let Some(refund) = state.refunds.last_mut() else {
            return RefundDisposition::NeedsReconciliation;
        };
        if refund.id != refund_id || refund.status != AttemptStatus::Reserved {
            return RefundDisposition::AlreadyFinalized;
        }
        if state.phase != ClosePhase::RefundPending || state.refund_pending != refund.amount {
            return RefundDisposition::NeedsReconciliation;
        }
        if success {
            let Some(refunded) = state.refunded.0.checked_add(refund.amount.0) else {
                return RefundDisposition::NeedsReconciliation;
            };
            state.refunded = U128(refunded);
            refund.status = if acknowledged {
                AttemptStatus::ReceiptAcknowledged
            } else {
                AttemptStatus::Settled
            };
            state.phase = ClosePhase::Closed;
        } else {
            refund.status = AttemptStatus::TransferFailed;
            state.phase = ClosePhase::RefundFailed;
        }
        state.refund_pending = U128(0);
        self.save_recovery(&order_id, &state);
        event(
            "refund_result",
            json!({"order_id":order_id,"state":state,"recipient_acknowledged":acknowledged}),
        );
        if success {
            RefundDisposition::Closed
        } else {
            RefundDisposition::TransferFailed
        }
    }
}

#[near]
impl Vault {
    pub fn get_version(&self) -> String {
        "2.1.0-recovery".into()
    }

    pub fn get_recovery(&self, order_id: String) -> RecoveryState {
        self.order(&order_id);
        self.recovery(&order_id)
    }

    /// Either commercial party proposes; only the other party may accept.
    /// The full immutable order and all mutable counters bind both approvals.
    pub fn propose_close(&mut self, order_id: String) -> CloseProposal {
        let order = self.order(&order_id);
        let caller = env::predecessor_account_id();
        require!(
            caller == order.buyer || caller == order.terms.supplier,
            "Buyer or supplier only"
        );
        let mut state = self.recovery(&order_id);
        self.close_ready(&order, &state);
        let expires_at = U64(env::block_timestamp()
            .checked_add(CLOSE_TTL_NS)
            .unwrap_or_else(|| env::panic_str("Timestamp overflow")));
        let proposal = CloseProposal {
            hash: self.close_hash(&order, &caller, expires_at),
            proposed_by: caller,
            expires_at,
            refund_amount: U128(order.funded.0 - order.paid.0 as u128 * order.terms.unit_price.0),
        };
        state.proposal = Some(proposal.clone());
        self.save_recovery(&order_id, &state);
        event(
            "close_proposed",
            json!({"order_id":order_id,"proposal":proposal}),
        );
        proposal
    }

    pub fn cancel_close(&mut self, order_id: String) {
        let order = self.order(&order_id);
        let caller = env::predecessor_account_id();
        require!(
            caller == order.buyer || caller == order.terms.supplier,
            "Buyer or supplier only"
        );
        let mut state = self.recovery(&order_id);
        require!(
            state.phase == ClosePhase::Open && state.proposal.is_some(),
            "No open close proposal"
        );
        state.proposal = None;
        self.save_recovery(&order_id, &state);
        event("close_cancelled", json!({"order_id":order_id}));
    }

    pub fn accept_close(
        &mut self,
        order_id: String,
        proposal_hash: String,
    ) -> PromiseOrValue<RefundDisposition> {
        let order = self.order(&order_id);
        let mut state = self.recovery(&order_id);
        self.close_ready(&order, &state);
        let proposal = state
            .proposal
            .clone()
            .unwrap_or_else(|| env::panic_str("No close proposal"));
        let caller = env::predecessor_account_id();
        require!(
            (caller == order.buyer || caller == order.terms.supplier)
                && caller != proposal.proposed_by,
            "Other commercial party must approve"
        );
        require!(
            env::block_timestamp() < proposal.expires_at.0,
            "Close proposal expired"
        );
        require!(
            proposal.hash == proposal_hash
                && proposal.hash
                    == self.close_hash(&order, &proposal.proposed_by, proposal.expires_at),
            "Stale close proposal"
        );
        if proposal.refund_amount.0 == 0 {
            state.phase = ClosePhase::Closed;
            state.proposal = None;
            self.save_recovery(&order_id, &state);
            event(
                "order_closed",
                json!({"order_id":order_id,"refunded":U128(0)}),
            );
            PromiseOrValue::Value(RefundDisposition::Closed)
        } else {
            PromiseOrValue::Promise(self.dispatch_refund(&order, state))
        }
    }

    pub fn retry_refund(&mut self, order_id: String) -> Promise {
        let order = self.order(&order_id);
        require!(env::predecessor_account_id() == order.buyer, "Buyer only");
        let state = self.recovery(&order_id);
        require!(
            state.phase == ClosePhase::RefundFailed,
            "Refund has no definitive failure"
        );
        self.dispatch_refund(&order, state)
    }

    #[private]
    pub fn on_refund_result(&mut self, order_id: String, refund_id: u32) -> RefundDisposition {
        if env::promise_results_count() != 1 {
            return RefundDisposition::NeedsReconciliation;
        }
        let success = match env::promise_result_checked(0, 1024) {
            Ok(_) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => return RefundDisposition::NeedsReconciliation,
        };
        self.finish_refund(order_id, refund_id, success, false)
    }

    /// Recipient consent can consume an unresolved reservation as paid. It can
    /// never release or reuse it. No caller can assert failure or change payout.
    pub fn acknowledge_payment(&mut self, request_id: String) {
        let mut attempt = self
            .attempts
            .get(&request_id)
            .unwrap_or_else(|| env::panic_str("Unknown attempt"));
        require!(
            env::predecessor_account_id() == attempt.recipient,
            "Payout recipient only"
        );
        require!(
            attempt.status == AttemptStatus::Reserved,
            "Attempt already finalized"
        );
        let mut order = self.order(&attempt.order_id);
        let pending = order
            .pending
            .0
            .checked_sub(attempt.quantity.0)
            .unwrap_or_else(|| env::panic_str("Invalid accounting"));
        let paid = order
            .paid
            .0
            .checked_add(attempt.quantity.0)
            .unwrap_or_else(|| env::panic_str("Invalid accounting"));
        require!(
            paid.checked_add(pending)
                .is_some_and(|v| v <= order.accepted.0),
            "Invalid accounting"
        );
        order.pending = U64(pending);
        order.paid = U64(paid);
        attempt.status = AttemptStatus::ReceiptAcknowledged;
        self.orders.insert(&attempt.order_id, &order);
        self.attempts.insert(&request_id, &attempt);
        event("payment_receipt_acknowledged", json!(&attempt));
    }

    pub fn acknowledge_refund(&mut self, order_id: String, refund_id: u32) -> RefundDisposition {
        let order = self.order(&order_id);
        require!(env::predecessor_account_id() == order.buyer, "Buyer only");
        let state = self.recovery(&order_id);
        let refund = state
            .refunds
            .last()
            .unwrap_or_else(|| env::panic_str("Unknown refund"));
        require!(
            refund.id == refund_id && refund.status == AttemptStatus::Reserved,
            "Refund already finalized"
        );
        self.finish_refund(order_id, refund_id, true, true)
    }
}
