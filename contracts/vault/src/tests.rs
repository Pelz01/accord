use super::*;
use near_sdk::{test_utils::VMContextBuilder, testing_env, PromiseResult, RuntimeFeesConfig};
use std::collections::HashMap;

fn native_fixture(deposit: u128) -> Vault {
    native_fixture_network(deposit, "sandbox")
}
fn native_fixture_network(deposit: u128, network: &str) -> Vault {
    let mut ctx = context("buyer.testnet");
    ctx.attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(ctx.build());
    let token = if network == "mainnet" {
        "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
    } else {
        "token.testnet"
    };
    let mut v = Vault::new(account(token), network.into());
    v.create_automatic_order(
        "NATIVE".into(),
        Terms {
            supplier: account("supplier.testnet"),
            receiver: account("buyer.testnet"),
            operator: account("operator.testnet"),
            payout: account("supplier.testnet"),
            line_id: "cartons".into(),
            description: "Coffee".into(),
            unit: "carton".into(),
            ordered: U64(10),
            unit_price: U128(1_000_000),
            expires_at: U64(10_000),
        },
    );
    v
}

#[test]
fn mainnet_small_storage_budget_is_metered_and_unused_credit_is_refundable() {
    let mut v = native_fixture_network(100_000_000_000_000_000_000_000, "mainnet");
    let initial = v.get_native_deposit("NATIVE".into());
    assert!(initial.incremental);
    assert_eq!(initial.initial_allowance.0, 100_000_000_000_000_000_000_000);
    assert_eq!(initial.retained_required.0, initial.initial_allowance.0);
    assert_eq!(initial.claimable.0, 0);
    let mut ctx = context("buyer.testnet");
    ctx.attached_deposit(NearToken::from_millinear(50));
    testing_env!(ctx.build());
    v.top_up_order_storage("NATIVE".into());
    assert_eq!(
        v.get_native_deposit("NATIVE".into()).claimable.0,
        50_000_000_000_000_000_000_000
    );
    testing_env!(approval_context("buyer.testnet").build());
    v.cancel_unfunded_order("NATIVE".into());
    let closed = v.get_native_deposit("NATIVE".into());
    assert!(closed.claimable.0 > 100_000_000_000_000_000_000_000);
    assert_eq!(
        closed.retained_required.0 + closed.claimable.0,
        150_000_000_000_000_000_000_000
    );
}

#[test]
#[should_panic(expected = "Top up this order's native storage budget")]
fn mainnet_small_budget_does_not_subsidize_unlimited_record_growth() {
    let v = native_fixture_network(100_000_000_000_000_000_000_000, "mainnet");
    let before = env::storage_usage();
    env::storage_write(b"capacity-probe", &vec![0; 10_000]);
    v.meter_native_storage(&"NATIVE".into(), before, 0);
}

#[test]
#[should_panic(expected = "Mainnet requires native USDC")]
fn mainnet_rejects_a_same_symbol_unpinned_asset() {
    testing_env!(context("owner.near").build());
    Vault::new(account("fake-usdc.near"), "mainnet".into());
}

#[test]
#[should_panic(expected = "Attach the initial order storage allowance")]
fn mainnet_order_cannot_start_below_its_storage_minimum() {
    native_fixture_network(99_000_000_000_000_000_000_000, "mainnet");
}
fn native_callback(v: &mut Vault, sequence: u64, result: PromiseResult) -> CallbackDisposition {
    testing_env!(
        context("vault.testnet").build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::default(),
        vec![result]
    );
    v.on_native_refund_result("NATIVE".into(), U64(sequence))
}

#[test]
fn native_excess_is_reserved_before_transfer_and_success_cannot_replay() {
    let mut v = native_fixture(1_250_000_000_000_000_000_000_000);
    assert_eq!(
        v.get_native_deposit("NATIVE".into()).claimable.0,
        250_000_000_000_000_000_000_000
    );
    testing_env!(approval_context("buyer.testnet").build());
    v.claim_native_excess("NATIVE".into()).detach();
    let view = v.get_native_deposit("NATIVE".into());
    assert_eq!(view.claimable.0, 0);
    assert_eq!(
        view.deposit.unwrap().pending.0,
        250_000_000_000_000_000_000_000
    );
    assert_eq!(
        native_callback(&mut v, 1, PromiseResult::Successful(vec![])),
        CallbackDisposition::Settled
    );
    assert_eq!(
        native_callback(&mut v, 1, PromiseResult::Failed),
        CallbackDisposition::AlreadyFinalized
    );
    let d = v.get_native_deposit("NATIVE".into()).deposit.unwrap();
    assert_eq!(d.pending.0, 0);
    assert_eq!(d.refunded.0, 250_000_000_000_000_000_000_000);
}

#[test]
fn native_failure_restores_only_its_credit_and_old_callbacks_cannot_settle_new_claims() {
    let mut v = native_fixture(1_250_000_000_000_000_000_000_000);
    testing_env!(approval_context("buyer.testnet").build());
    v.claim_native_excess("NATIVE".into()).detach();
    assert_eq!(
        native_callback(&mut v, 1, PromiseResult::Failed),
        CallbackDisposition::TransferFailed
    );
    assert_eq!(
        v.get_native_deposit("NATIVE".into()).claimable.0,
        250_000_000_000_000_000_000_000
    );
    testing_env!(approval_context("buyer.testnet").build());
    v.claim_native_excess("NATIVE".into()).detach();
    assert_eq!(
        native_callback(&mut v, 1, PromiseResult::Successful(vec![])),
        CallbackDisposition::AlreadyFinalized
    );
    assert_eq!(
        v.get_native_deposit("NATIVE".into())
            .deposit
            .unwrap()
            .claim_sequence
            .0,
        2
    );
    assert_eq!(
        native_callback(&mut v, 2, PromiseResult::Successful(vec![])),
        CallbackDisposition::Settled
    );
}

#[test]
fn uncertain_native_refund_stays_reserved_and_recipient_ack_cannot_release_credit() {
    let mut v = native_fixture(1_250_000_000_000_000_000_000_000);
    testing_env!(approval_context("buyer.testnet").build());
    v.claim_native_excess("NATIVE".into()).detach();
    testing_env!(context("vault.testnet").build());
    assert_eq!(
        v.on_native_refund_result("NATIVE".into(), U64(1)),
        CallbackDisposition::NeedsReconciliation
    );
    assert_eq!(v.get_native_deposit("NATIVE".into()).claimable.0, 0);
    testing_env!(approval_context("buyer.testnet").build());
    assert_eq!(
        v.acknowledge_native_refund("NATIVE".into(), U64(1)),
        CallbackDisposition::Settled
    );
    assert_eq!(v.get_native_deposit("NATIVE".into()).claimable.0, 0);
    assert_eq!(
        native_callback(&mut v, 1, PromiseResult::Failed),
        CallbackDisposition::AlreadyFinalized
    );
}

#[test]
fn unfunded_cancellation_releases_future_capacity_but_keeps_record_backing() {
    let mut v = native_fixture(1_000_000_000_000_000_000_000_000);
    testing_env!(approval_context("buyer.testnet").build());
    v.cancel_unfunded_order("NATIVE".into());
    let view = v.get_native_deposit("NATIVE".into());
    assert!(view.claimable.0 > 900_000_000_000_000_000_000_000);
    assert!(view.retained_required.0 >= view.storage_backing.0);
    assert_eq!(
        view.claimable.0 + view.retained_required.0,
        1_000_000_000_000_000_000_000_000
    );
    assert!(v.get_order("NATIVE".into()).is_some());
}

#[test]
#[should_panic(expected = "Native deposit owner only")]
fn supplier_cannot_claim_buyers_native_credit() {
    let mut v = native_fixture(1_250_000_000_000_000_000_000_000);
    testing_env!(approval_context("supplier.testnet").build());
    v.claim_native_excess("NATIVE".into());
}

#[test]
#[should_panic(expected = "exactly 1 yoctoNEAR")]
fn restricted_zero_deposit_keys_cannot_claim_native_money() {
    let mut v = native_fixture(1_250_000_000_000_000_000_000_000);
    testing_env!(context("buyer.testnet").build());
    v.claim_native_excess("NATIVE".into());
}

#[test]
fn explicit_topup_increases_only_the_original_owners_credit() {
    let mut v = native_fixture(1_000_000_000_000_000_000_000_000);
    let before = v
        .get_native_deposit("NATIVE".into())
        .deposit
        .unwrap()
        .storage_bytes;
    let mut ctx = context("buyer.testnet");
    ctx.attached_deposit(NearToken::from_millinear(100));
    testing_env!(ctx.build());
    v.top_up_order_storage("NATIVE".into());
    let view = v.get_native_deposit("NATIVE".into());
    assert_eq!(view.claimable.0, 100_000_000_000_000_000_000_000);
    assert_eq!(view.deposit.unwrap().storage_bytes, before);
}

#[test]
#[should_panic(expected = "Native credits or platform storage need funding")]
fn native_claim_cannot_use_another_customers_protected_balance() {
    let mut v = native_fixture(1_250_000_000_000_000_000_000_000);
    let mut ctx = approval_context("buyer.testnet");
    // The protocol could execute a 0.25 transfer from this balance, but doing so
    // would violate the application's tracked-credit and platform-storage backing.
    ctx.account_balance(NearToken::from_millinear(3100));
    testing_env!(ctx.build());
    v.claim_native_excess("NATIVE".into());
}

#[test]
#[should_panic(expected = "Order is closed")]
fn cancellation_prevents_a_supplier_from_accepting_the_order_later() {
    let mut v = native_fixture(1_000_000_000_000_000_000_000_000);
    testing_env!(approval_context("buyer.testnet").build());
    v.cancel_unfunded_order("NATIVE".into());
    let terms_hash = v.get_order("NATIVE".into()).unwrap().terms_hash;
    testing_env!(approval_context("supplier.testnet").build());
    v.accept_order("NATIVE".into(), terms_hash);
}

#[test]
fn token_refund_callback_can_finalize_without_borrowing_or_requiring_fresh_native_funding() {
    let mut v = ready_to_close();
    close(&mut v);
    let mut ctx = context("vault.testnet");
    ctx.account_balance(NearToken::from_millinear(3100));
    testing_env!(
        ctx.build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::default(),
        vec![PromiseResult::Successful(vec![])]
    );
    assert_eq!(
        v.on_refund_result("PO-001".into(), 1),
        RefundDisposition::Closed
    );
    assert_eq!(v.get_recovery("PO-001".into()).refund_pending.0, 0);
}

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
fn approval_context(caller: &str) -> VMContextBuilder {
    let mut ctx = context(caller);
    ctx.attached_deposit(NearToken::from_yoctonear(1));
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
    let invoice = test_invoice(v);
    testing_env!(context("supplier.testnet").build());
    v.confirm_invoice("PO-001".into(), invoice.clone());
    testing_env!(context("operator.testnet").build());
    v.request_payment(
        "PO-001".into(),
        id.into(),
        U64(qty),
        "b".repeat(64),
        Some(invoice),
    )
    .detach();
}
fn test_invoice(v: &Vault) -> InvoicePayload {
    let o = v.get_order("PO-001".into()).unwrap();
    InvoicePayload {
        order_id: o.id,
        terms_version: 1,
        terms_hash: o.terms_hash,
        document_hash: "b".repeat(64),
        reference: "INV-001".into(),
        line_id: o.terms.line_id,
        quantity: U64(100),
        token: o.token,
        amount: U128(1_000_000_000),
    }
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

fn automatic_setup(receiver: &str) -> (Vault, InvoicePayload) {
    let mut v = setup();
    let mut terms = v.get_order("PO-001".into()).unwrap().terms;
    terms.receiver = account(receiver);
    let mut ctx = context("buyer.testnet");
    ctx.attached_deposit(NearToken::from_near(1));
    testing_env!(ctx.build());
    let o = v.create_automatic_order("PO-AUTO".into(), terms);
    testing_env!(approval_context("supplier.testnet").build());
    v.accept_order(o.id.clone(), o.terms_hash.clone());
    testing_env!(context("token.testnet").build());
    let _ = v.ft_on_transfer(account("buyer.testnet"), U128(1_000_000_000), o.id.clone());
    testing_env!(approval_context(receiver).build());
    v.confirm_delivery(o.id.clone(), U64(1), U64(4), "a".repeat(64));
    let invoice = InvoicePayload {
        order_id: o.id,
        terms_hash: o.terms_hash,
        quantity: U64(4),
        amount: U128(40_000_000),
        ..test_invoice(&v)
    };
    testing_env!(approval_context("supplier.testnet").build());
    v.confirm_invoice("PO-AUTO".into(), invoice.clone());
    (v, invoice)
}

#[test]
fn buyer_confirms_own_deliveries_and_existing_orders_stay_manual() {
    let (v, _) = automatic_setup("buyer.testnet");
    assert_eq!(v.get_order("PO-AUTO".into()).unwrap().accepted.0, 4);
    assert_eq!(v.get_payment_policy("PO-AUTO".into()).mode, "automatic");
    assert_eq!(v.get_payment_policy("PO-001".into()).mode, "manual");
}

#[test]
fn optional_receiver_can_confirm_delivery() {
    let (mut v, _) = automatic_setup("receiver.testnet");
    testing_env!(approval_context("receiver.testnet").build());
    v.confirm_delivery("PO-AUTO".into(), U64(2), U64(6), "c".repeat(64));
    assert_eq!(v.get_order("PO-AUTO".into()).unwrap().accepted.0, 6);
}

#[test]
#[should_panic(expected = "Receiver only")]
fn appointing_a_receiver_does_not_also_authorize_the_buyer() {
    let (mut v, _) = automatic_setup("receiver.testnet");
    testing_env!(approval_context("buyer.testnet").build());
    v.confirm_delivery("PO-AUTO".into(), U64(2), U64(6), "c".repeat(64));
}

#[test]
#[should_panic(expected = "Separate authority accounts")]
fn supplier_cannot_confirm_its_own_delivery() {
    automatic_setup("supplier.testnet");
}

fn automatic_request(v: &mut Vault, invoice: &InvoicePayload, id: &str, quantity: u64) {
    testing_env!(context("operator.testnet").build());
    v.request_payment(
        "PO-AUTO".into(),
        id.into(),
        U64(quantity),
        invoice.document_hash.clone(),
        Some(invoice.clone()),
    )
    .detach();
}

#[test]
fn automatic_invoice_reservations_failures_and_settlement_use_chain_outcomes() {
    let (mut v, invoice) = automatic_setup("buyer.testnet");
    automatic_request(&mut v, &invoice, "auto-one", 2);
    assert_eq!(
        v.get_payment_policy("PO-AUTO".into()).invoices[0]
            .available
            .0,
        2
    );
    callback(&mut v, "auto-one", PromiseResult::Failed);
    assert_eq!(
        v.get_payment_policy("PO-AUTO".into()).invoices[0]
            .available
            .0,
        4
    );
    automatic_request(&mut v, &invoice, "auto-two", 4);
    assert_eq!(
        v.get_payment_policy("PO-AUTO".into()).invoices[0]
            .available
            .0,
        0
    );
    callback(&mut v, "auto-two", PromiseResult::Successful(vec![]));
    callback(&mut v, "auto-two", PromiseResult::Failed);
    assert_eq!(
        v.get_payment_policy("PO-AUTO".into()).invoices[0]
            .available
            .0,
        0
    );
    assert_eq!(v.get_order("PO-AUTO".into()).unwrap().paid.0, 4);
}

#[test]
#[should_panic(expected = "Confirmed invoice quantity already paid or reserved")]
fn a_paid_automatic_invoice_cannot_pay_for_a_later_delivery() {
    let (mut v, invoice) = automatic_setup("buyer.testnet");
    automatic_request(&mut v, &invoice, "auto-paid", 4);
    callback(&mut v, "auto-paid", PromiseResult::Successful(vec![]));
    testing_env!(approval_context("buyer.testnet").build());
    v.confirm_delivery("PO-AUTO".into(), U64(2), U64(6), "c".repeat(64));
    automatic_request(&mut v, &invoice, "auto-reuse", 2);
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

#[test]
fn invoice_confirmation_is_immutable_idempotent_and_preserves_legacy_root() {
    let mut v = setup();
    let invoice = test_invoice(&v);
    let before = near_sdk::borsh::to_vec(&v).unwrap();
    testing_env!(context("supplier.testnet").build());
    let confirmation = v.confirm_invoice("PO-001".into(), invoice.clone());
    assert_eq!(
        v.confirm_invoice("PO-001".into(), invoice.clone())
            .commitment,
        confirmation.commitment
    );
    assert_eq!(v.list_invoices("PO-001".into()).len(), 1);
    assert_eq!(
        v.get_invoice(confirmation.commitment).unwrap().invoice,
        invoice
    );
    assert_eq!(near_sdk::borsh::to_vec(&v).unwrap(), before);
}

#[test]
#[should_panic(expected = "Supplier only")]
fn operator_cannot_confirm_an_invoice() {
    let mut v = setup();
    let invoice = test_invoice(&v);
    testing_env!(context("operator.testnet").build());
    v.confirm_invoice("PO-001".into(), invoice);
}

#[test]
#[should_panic(expected = "Supplier-confirmed invoice required")]
fn legacy_payment_call_cannot_bypass_invoice_confirmation() {
    let mut v = setup();
    testing_env!(context("operator.testnet").build());
    v.request_payment(
        "PO-001".into(),
        "no-invoice".into(),
        U64(1),
        "b".repeat(64),
        None,
    )
    .detach();
}

#[test]
#[should_panic(expected = "Supplier-confirmed invoice required")]
fn changed_invoice_reference_requires_a_new_supplier_confirmation() {
    let mut v = setup();
    let mut invoice = test_invoice(&v);
    testing_env!(context("supplier.testnet").build());
    v.confirm_invoice("PO-001".into(), invoice.clone());
    invoice.reference = "RENAMED".into();
    testing_env!(context("operator.testnet").build());
    v.request_payment(
        "PO-001".into(),
        "changed".into(),
        U64(1),
        "b".repeat(64),
        Some(invoice),
    )
    .detach();
}

#[test]
#[should_panic(expected = "Payment differs from confirmed invoice")]
fn payment_cannot_exceed_the_supplier_confirmed_invoice_quantity() {
    let mut v = setup();
    let mut invoice = test_invoice(&v);
    invoice.quantity = U64(20);
    invoice.amount = U128(200_000_000);
    testing_env!(context("supplier.testnet").build());
    v.confirm_invoice("PO-001".into(), invoice.clone());
    testing_env!(context("operator.testnet").build());
    v.request_payment(
        "PO-001".into(),
        "too-much".into(),
        U64(30),
        "b".repeat(64),
        Some(invoice),
    )
    .detach();
}

#[test]
#[should_panic(expected = "Invoice amount does not match fixed price")]
fn supplier_confirmation_cannot_change_the_agreed_price() {
    let mut v = setup();
    let mut invoice = test_invoice(&v);
    invoice.amount = U128(999);
    testing_env!(context("supplier.testnet").build());
    v.confirm_invoice("PO-001".into(), invoice);
}

#[test]
fn canonical_invoice_matches_cross_language_unicode_vector() {
    testing_env!(context("vault.testnet").build());
    let v = Vault::new(account("token.testnet"), "testnet".into());
    let invoice = InvoicePayload {
        order_id: "PO-CANONICAL-001".into(),
        terms_version: 1,
        terms_hash: "a".repeat(64),
        document_hash: "b".repeat(64),
        reference: "INV-É-01 / \"cartons\"".into(),
        line_id: "cartons".into(),
        quantity: U64(100),
        token: account("token.testnet"),
        amount: U128(1_000_000_000),
    };
    assert_eq!(
        v.invoice_commitment(&invoice),
        "f9d9f90d77f02bfc69526fd1e8dba3b692d5b04509f223a6642586a40c2bded8"
    );
}

#[test]
#[should_panic(expected = "Stale close proposal")]
fn new_supplier_invoice_confirmation_invalidates_close_proposal() {
    let mut v = ready_to_close();
    let proposal = propose(&mut v);
    let mut invoice = test_invoice(&v);
    invoice.reference = "INV-ADDED-AFTER-PROPOSAL".into();
    testing_env!(context("supplier.testnet").build());
    v.confirm_invoice("PO-001".into(), invoice);
    let _ = v.accept_close("PO-001".into(), proposal.hash);
}

#[test]
#[should_panic(expected = "Attach exactly 1 yoctoNEAR")]
fn automatic_delivery_rejects_zero_deposit() {
    let (mut v, _) = automatic_setup("buyer.testnet");
    testing_env!(context("buyer.testnet").build());
    v.confirm_delivery("PO-AUTO".into(), U64(2), U64(6), "c".repeat(64));
}
#[test]
#[should_panic(expected = "Attach exactly 1 yoctoNEAR")]
fn automatic_invoice_rejects_zero_deposit() {
    let (mut v, invoice) = automatic_setup("buyer.testnet");
    testing_env!(context("supplier.testnet").build());
    v.confirm_invoice("PO-AUTO".into(), invoice);
}
#[test]
#[should_panic(expected = "Attach exactly 1 yoctoNEAR")]
fn automatic_closure_rejects_excess_deposit() {
    let (mut v, _) = automatic_setup("buyer.testnet");
    let mut ctx = context("buyer.testnet");
    ctx.attached_deposit(NearToken::from_yoctonear(2));
    testing_env!(ctx.build());
    v.propose_close("PO-AUTO".into());
}
#[test]
#[should_panic(expected = "Manual order approval requires zero deposit")]
fn legacy_delivery_keeps_zero_deposit_rule() {
    let mut v = setup();
    testing_env!(approval_context("receiver.testnet").build());
    v.confirm_delivery("PO-001".into(), U64(2), U64(50), "a".repeat(64));
}
