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
