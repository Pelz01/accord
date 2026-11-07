use super::*;
use near_sdk::{test_utils::VMContextBuilder, testing_env, PromiseResult, RuntimeFeesConfig};
use std::collections::HashMap;

fn account(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn context(caller: &str) -> VMContextBuilder {
    let mut ctx = VMContextBuilder::new();
    ctx.current_account_id(account("vault.testnet"))
        .predecessor_account_id(account(caller))
        .signer_account_id(account(caller))
        .block_timestamp(100)
        .prepaid_gas(Gas::from_tgas(150));
    ctx
}
fn setup() -> Vault {
    let mut ctx = context("buyer.testnet");
    ctx.attached_deposit(NearToken::from_near(1));
    testing_env!(ctx.build());
    let mut v = Vault::new(account("token.testnet"), "sandbox".into());
    v.create_order(
        "PO-001".into(),
        Terms {
            supplier: account("supplier.testnet"),
            receiver: account("receiver.testnet"),
            operator: account("operator.testnet"),
            payout: account("supplier.testnet"),
            line_id: "cartons".into(),
            description: "Fictitious cartons".into(),
            unit: "carton".into(),
            ordered: U64(100),
            unit_price: U128(10_000_000),
            expires_at: U64(10_000),
        },
    );
    testing_env!(context("supplier.testnet").build());
    let hash = v.get_order("PO-001".into()).unwrap().terms_hash;
    v.accept_order("PO-001".into(), hash);
    testing_env!(context("token.testnet").build());
    assert!(matches!(
        v.ft_on_transfer(
            account("buyer.testnet"),
            U128(1_000_000_000),
            "PO-001".into()
        ),
        PromiseOrValue::Value(U128(0))
    ));
    testing_env!(context("receiver.testnet").build());
    v.confirm_delivery("PO-001".into(), U64(1), U64(40), "a".repeat(64));
    v
}
fn request(v: &mut Vault, id: &str, qty: u64) {
    testing_env!(context("operator.testnet").build());
    v.request_payment("PO-001".into(), id.into(), U64(qty), "b".repeat(64))
        .detach();
}
fn callback(v: &mut Vault, id: &str, result: PromiseResult) -> CallbackDisposition {
    testing_env!(
        context("vault.testnet").build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::default(),
        vec![result]
    );
    v.on_payment_result(id.into())
}

#[test]
fn partial_delivery_settles_and_next_delivery_unlocks_only_increment() {
    let mut v = setup();
    request(&mut v, "r1", 40);
    assert_eq!(v.get_order("PO-001".into()).unwrap().pending.0, 40);
    assert_eq!(
        callback(&mut v, "r1", PromiseResult::Successful(vec![])),
        CallbackDisposition::Settled
    );
    testing_env!(context("receiver.testnet").build());
    v.confirm_delivery("PO-001".into(), U64(2), U64(70), "c".repeat(64));
    request(&mut v, "r2", 30);
    callback(&mut v, "r2", PromiseResult::Successful(vec![]));
    let o = v.get_order("PO-001".into()).unwrap();
    assert_eq!((o.accepted.0, o.paid.0, o.pending.0), (70, 70, 0));
    assert_eq!(v.get_attempt("r2".into()).unwrap().amount.0, 300_000_000);
}

#[test]
fn failed_transfer_releases_reservation_and_preserves_attempt() {
    let mut v = setup();
    request(&mut v, "failed", 40);
    assert_eq!(
        callback(&mut v, "failed", PromiseResult::Failed),
        CallbackDisposition::TransferFailed
    );
    let o = v.get_order("PO-001".into()).unwrap();
    assert_eq!((o.paid.0, o.pending.0), (0, 0));
    assert_eq!(
        v.get_attempt("failed".into()).unwrap().status,
        AttemptStatus::TransferFailed
    );
    request(&mut v, "retry-new-id", 40);
}

#[test]
fn callback_is_idempotent() {
    let mut v = setup();
    request(&mut v, "once", 40);
    callback(&mut v, "once", PromiseResult::Successful(vec![]));
    assert_eq!(
        callback(&mut v, "once", PromiseResult::Failed),
        CallbackDisposition::AlreadyFinalized
    );
    assert_eq!(v.get_order("PO-001".into()).unwrap().paid.0, 40);
}

#[test]
#[should_panic(expected = "Quantity exceeds available entitlement")]
fn overlapping_request_cannot_use_reserved_quantity() {
    let mut v = setup();
    request(&mut v, "one", 30);
    request(&mut v, "two", 11);
}

#[test]
#[should_panic(expected = "Request already exists")]
fn request_replay_is_rejected_even_after_failure() {
    let mut v = setup();
    request(&mut v, "same", 10);
    callback(&mut v, "same", PromiseResult::Failed);
    request(&mut v, "same", 10);
}

#[test]
#[should_panic(expected = "Invalid cumulative delivery")]
fn equal_total_is_rejected() {
    let mut v = setup();
    testing_env!(context("receiver.testnet").build());
    v.confirm_delivery("PO-001".into(), U64(2), U64(40), "c".repeat(64));
}

#[test]
#[should_panic(expected = "Stale or skipped")]
fn skipped_sequence_is_rejected() {
    let mut v = setup();
    testing_env!(context("receiver.testnet").build());
    v.confirm_delivery("PO-001".into(), U64(3), U64(50), "c".repeat(64));
}

#[test]
#[should_panic(expected = "Receiver only")]
fn operator_cannot_confirm_delivery() {
    let mut v = setup();
    testing_env!(context("operator.testnet").build());
    v.confirm_delivery("PO-001".into(), U64(2), U64(70), "c".repeat(64));
}

#[test]
fn wrong_token_and_duplicate_funding_are_returned() {
    let mut v = setup();
    testing_env!(context("malicious.testnet").build());
    assert!(matches!(
        v.ft_on_transfer(account("buyer.testnet"), U128(1), "PO-001".into()),
        PromiseOrValue::Value(U128(1))
    ));
    testing_env!(context("token.testnet").build());
    assert!(matches!(
        v.ft_on_transfer(
            account("buyer.testnet"),
            U128(1_000_000_000),
            "PO-001".into()
        ),
        PromiseOrValue::Value(U128(1_000_000_000))
    ));
    assert_eq!(
        v.get_order("PO-001".into()).unwrap().funded.0,
        1_000_000_000
    );
}

#[test]
fn no_callback_means_reservation_stays_locked() {
    let mut v = setup();
    request(&mut v, "uncertain", 40);
    let o = v.get_order("PO-001".into()).unwrap();
    assert_eq!((o.paid.0, o.pending.0), (0, 40));
}

#[test]
fn attempt_recipient_is_fixed_by_accepted_terms() {
    let mut v = setup();
    request(&mut v, "fixed", 40);
    assert_eq!(
        v.get_attempt("fixed".into()).unwrap().recipient,
        account("supplier.testnet")
    );
}

#[test]
fn unknown_callback_retains_existing_accounting() {
    let mut v = setup();
    request(&mut v, "real", 40);
    assert_eq!(
        callback(&mut v, "missing", PromiseResult::Successful(vec![])),
        CallbackDisposition::NeedsReconciliation
    );
    assert_eq!(v.get_order("PO-001".into()).unwrap().pending.0, 40);
}

fn ready_to_close() -> Vault {
    let mut v = setup();
    request(&mut v, "settled", 40);
    callback(&mut v, "settled", PromiseResult::Successful(vec![]));
    v
}
fn propose(v: &mut Vault) -> CloseProposal {
    testing_env!(context("buyer.testnet").build());
    v.propose_close("PO-001".into())
}
fn close(v: &mut Vault) {
    let p = propose(v);
    testing_env!(context("supplier.testnet").build());
    if let PromiseOrValue::Promise(promise) = v.accept_close("PO-001".into(), p.hash) {
        promise.detach();
    }
}
fn refund_callback(v: &mut Vault, id: u32, result: PromiseResult) -> RefundDisposition {
    testing_env!(
        context("vault.testnet").build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::default(),
        vec![result]
    );
    v.on_refund_result("PO-001".into(), id)
}

#[test]
fn mutual_close_reserves_exact_unused_funds_and_closes_only_on_success() {
    let mut v = ready_to_close();
    close(&mut v);
    let r = v.get_recovery("PO-001".into());
    assert_eq!(r.phase, ClosePhase::RefundPending);
    assert_eq!((r.refund_pending.0, r.refunded.0), (600_000_000, 0));
    assert_eq!(r.refunds[0].recipient, account("buyer.testnet"));
    assert_eq!(
        refund_callback(&mut v, 1, PromiseResult::Successful(vec![])),
        RefundDisposition::Closed
    );
    let r = v.get_recovery("PO-001".into());
    assert_eq!(r.phase, ClosePhase::Closed);
    assert_eq!((r.refund_pending.0, r.refunded.0), (0, 600_000_000));
    let o = v.get_order("PO-001".into()).unwrap();
    assert_eq!(
        o.funded.0,
        o.paid.0 as u128 * o.terms.unit_price.0 + r.refunded.0
    );
}

#[test]
fn failed_refund_is_retryable_but_old_callback_cannot_finalize_new_attempt() {
    let mut v = ready_to_close();
    close(&mut v);
    assert_eq!(
        refund_callback(&mut v, 1, PromiseResult::Failed),
        RefundDisposition::TransferFailed
    );
    assert_eq!(
        v.get_recovery("PO-001".into()).phase,
        ClosePhase::RefundFailed
    );
    testing_env!(context("buyer.testnet").build());
    v.retry_refund("PO-001".into()).detach();
    assert_eq!(
        refund_callback(&mut v, 1, PromiseResult::Successful(vec![])),
        RefundDisposition::AlreadyFinalized
    );
    assert_eq!(
        v.get_recovery("PO-001".into()).refund_pending.0,
        600_000_000
    );
    assert_eq!(
        refund_callback(&mut v, 2, PromiseResult::Successful(vec![])),
        RefundDisposition::Closed
    );
    assert_eq!(
        refund_callback(&mut v, 2, PromiseResult::Failed),
        RefundDisposition::AlreadyFinalized
    );
    assert_eq!(v.get_recovery("PO-001".into()).refunded.0, 600_000_000);
}

#[test]
fn oversized_or_missing_refund_result_keeps_reservation() {
    let mut v = ready_to_close();
    close(&mut v);
    assert_eq!(
        refund_callback(&mut v, 1, PromiseResult::Successful(vec![0; 1025])),
        RefundDisposition::NeedsReconciliation
    );
    testing_env!(context("vault.testnet").build());
    assert_eq!(
        v.on_refund_result("PO-001".into(), 1),
        RefundDisposition::NeedsReconciliation
    );
    assert_eq!(
        v.get_recovery("PO-001".into()).refund_pending.0,
        600_000_000
    );
}

#[test]
fn refund_recipient_can_acknowledge_receipt_without_reusing_money() {
    let mut v = ready_to_close();
    close(&mut v);
    testing_env!(context("buyer.testnet").build());
    assert_eq!(
        v.acknowledge_refund("PO-001".into(), 1),
        RefundDisposition::Closed
    );
    assert_eq!(
        v.get_recovery("PO-001".into()).refunds[0].status,
        AttemptStatus::ReceiptAcknowledged
    );
    assert_eq!(
        refund_callback(&mut v, 1, PromiseResult::Failed),
        RefundDisposition::AlreadyFinalized
    );
}

#[test]
fn payout_acknowledgment_preserves_paid_plus_pending_and_late_callback_is_ignored() {
    let mut v = setup();
    request(&mut v, "missing-callback", 40);
    testing_env!(context("supplier.testnet").build());
    v.acknowledge_payment("missing-callback".into());
    let o = v.get_order("PO-001".into()).unwrap();
    assert_eq!((o.paid.0, o.pending.0), (40, 0));
    assert_eq!(
        v.get_attempt("missing-callback".into()).unwrap().status,
        AttemptStatus::ReceiptAcknowledged
    );
    assert_eq!(
        callback(&mut v, "missing-callback", PromiseResult::Failed),
        CallbackDisposition::AlreadyFinalized
    );
    close(&mut v);
    assert_eq!(
        v.get_recovery("PO-001".into()).refund_pending.0,
        600_000_000
    );
}

#[test]
#[should_panic(expected = "Other commercial party")]
fn buyer_cannot_approve_own_closure() {
    let mut v = ready_to_close();
    let p = propose(&mut v);
    let _ = v.accept_close("PO-001".into(), p.hash);
}

#[test]
#[should_panic(expected = "Buyer or supplier only")]
fn operator_cannot_propose_close() {
    let mut v = ready_to_close();
    testing_env!(context("operator.testnet").build());
    v.propose_close("PO-001".into());
}

#[test]
#[should_panic(expected = "Settle all accepted")]
fn close_cannot_refund_unpaid_accepted_deliveries() {
    let mut v = setup();
    propose(&mut v);
}

#[test]
#[should_panic(expected = "Unresolved transfer")]
fn close_cannot_cross_an_inflight_payment() {
    let mut v = setup();
    request(&mut v, "inflight", 40);
    propose(&mut v);
}

#[test]
#[should_panic(expected = "Stale close proposal")]
fn intervening_delivery_and_payment_invalidate_proposal() {
    let mut v = ready_to_close();
    let p = propose(&mut v);
    testing_env!(context("receiver.testnet").build());
    v.confirm_delivery("PO-001".into(), U64(2), U64(70), "c".repeat(64));
    request(&mut v, "later", 30);
    callback(&mut v, "later", PromiseResult::Successful(vec![]));
    testing_env!(context("supplier.testnet").build());
    let _ = v.accept_close("PO-001".into(), p.hash);
}

#[test]
#[should_panic(expected = "Close proposal expired")]
fn expired_proposal_cannot_close() {
    let mut v = ready_to_close();
    let p = propose(&mut v);
    let mut ctx = context("supplier.testnet");
    ctx.block_timestamp(p.expires_at.0);
    testing_env!(ctx.build());
    let _ = v.accept_close("PO-001".into(), p.hash);
}

#[test]
#[should_panic(expected = "Order is closing or closed")]
fn refund_freezes_new_deliveries() {
    let mut v = ready_to_close();
    close(&mut v);
    testing_env!(context("receiver.testnet").build());
    v.confirm_delivery("PO-001".into(), U64(2), U64(70), "c".repeat(64));
}

#[test]
#[should_panic(expected = "Refund has no definitive failure")]
fn unknown_refund_cannot_be_retried() {
    let mut v = ready_to_close();
    close(&mut v);
    testing_env!(context("buyer.testnet").build());
    let _ = v.retry_refund("PO-001".into());
}

#[test]
#[should_panic(expected = "Payout recipient only")]
fn operator_cannot_acknowledge_supplier_receipt() {
    let mut v = setup();
    request(&mut v, "inflight", 40);
    v.acknowledge_payment("inflight".into());
}

#[test]
#[should_panic(expected = "Buyer only")]
fn supplier_cannot_acknowledge_buyer_refund() {
    let mut v = ready_to_close();
    close(&mut v);
    v.acknowledge_refund("PO-001".into(), 1);
}

#[test]
fn fully_paid_order_closes_without_refund_transfer() {
    let mut v = ready_to_close();
    testing_env!(context("receiver.testnet").build());
    v.confirm_delivery("PO-001".into(), U64(2), U64(100), "c".repeat(64));
    request(&mut v, "rest", 60);
    callback(&mut v, "rest", PromiseResult::Successful(vec![]));
    close(&mut v);
    let r = v.get_recovery("PO-001".into());
    assert_eq!(r.phase, ClosePhase::Closed);
    assert!(r.refunds.is_empty());
}

#[test]
fn proposal_can_be_cancelled_and_legacy_state_encoding_is_preserved() {
    let mut v = ready_to_close();
    let root_before = near_sdk::borsh::to_vec(&v).unwrap();
    propose(&mut v);
    testing_env!(context("supplier.testnet").build());
    v.cancel_close("PO-001".into());
    assert!(v.get_recovery("PO-001".into()).proposal.is_none());
    assert_eq!(near_sdk::borsh::to_vec(&v).unwrap(), root_before);
    assert_eq!(
        near_sdk::borsh::to_vec(&AttemptStatus::Settled).unwrap(),
        vec![1]
    );
    assert_eq!(
        near_sdk::borsh::to_vec(&AttemptStatus::TransferFailed).unwrap(),
        vec![2]
    );
}

#[test]
fn repeated_definite_refund_failures_keep_bounded_history_and_unique_ids() {
    let mut v = ready_to_close();
    close(&mut v);
    for id in 1..=10 {
        assert_eq!(
            refund_callback(&mut v, id, PromiseResult::Failed),
            RefundDisposition::TransferFailed
        );
        testing_env!(context("buyer.testnet").build());
        v.retry_refund("PO-001".into()).detach();
    }
    let state = v.get_recovery("PO-001".into());
    assert_eq!(state.refunds.len(), 8);
    assert_eq!(state.refunds.last().unwrap().id, 11);
    assert_eq!(
        refund_callback(&mut v, 1, PromiseResult::Successful(vec![])),
        RefundDisposition::AlreadyFinalized
    );
    assert_eq!(
        refund_callback(&mut v, 11, PromiseResult::Successful(vec![])),
        RefundDisposition::Closed
    );
    assert_eq!(v.get_recovery("PO-001".into()).refunded.0, 600_000_000);
}
