use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::{
    collections::UnorderedMap,
    env,
    json_types::{U128, U64},
    near, require,
    serde_json::json,
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

mod recovery;
pub use recovery::*;
mod invoices;
pub use invoices::*;
mod automatic;
pub use automatic::*;

const MAX_ATTEMPTS: u32 = 64;
// Provisional allocations; sandbox gas measurements remain a release gate.
const TRANSFER_GAS: Gas = Gas::from_tgas(25);
#[cfg(not(feature = "fault-injection"))]
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
#[cfg(feature = "fault-injection")]
const CALLBACK_GAS: Gas = Gas::from_gas(1);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Terms {
    pub supplier: AccountId,
    pub receiver: AccountId,
    pub operator: AccountId,
    pub payout: AccountId,
    pub line_id: String,
    pub description: String,
    pub unit: String,
    pub ordered: U64,
    pub unit_price: U128,
    pub expires_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Order {
    pub id: String,
    pub buyer: AccountId,
    pub token: AccountId,
    pub terms: Terms,
    pub terms_hash: String,
    pub accepted_terms: bool,
    pub funded: U128,
    pub accepted: U64,
    pub paid: U64,
    pub pending: U64,
    pub sequence: U64,
    pub attempts: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum AttemptStatus {
    Reserved,
    Settled,
    TransferFailed,
    // Appended to preserve the encoding of existing testnet attempts.
    ReceiptAcknowledged,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Attempt {
    pub request_id: String,
    pub order_id: String,
    pub quantity: U64,
    pub amount: U128,
    pub recipient: AccountId,
    pub audit_hash: String,
    pub status: AttemptStatus,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub enum CallbackDisposition {
    Settled,
    TransferFailed,
    AlreadyFinalized,
    NeedsReconciliation,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    token: AccountId,
    network: String,
    orders: UnorderedMap<String, Order>,
    attempts: UnorderedMap<String, Attempt>,
}

fn bounded(value: &str, max: usize) {
    require!(
        !value.is_empty() && value.len() <= max,
        "Invalid field length"
    );
}
fn digest(value: &[u8]) -> String {
    env::sha256(value)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn event(name: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard":"accord","version":"1.0.0","event":name,"data":[data]})
    ));
}

#[near]
impl Vault {
    #[init]
    pub fn new(token: AccountId, network: String) -> Self {
        require!(
            network == "testnet" || network == "sandbox",
            "Test environments only"
        );
        Self {
            token,
            network,
            orders: UnorderedMap::new(b"o"),
            attempts: UnorderedMap::new(b"a"),
        }
    }

    /// One line per order in P0. Storage and outgoing-call deposits are separate from token funding.
    #[payable]
    pub fn create_order(&mut self, order_id: String, terms: Terms) -> Order {
        self.create_order_inner(order_id, terms, false)
    }

    /// Automatic execution is agreed at creation and cannot be enabled on an old order.
    #[payable]
    pub fn create_automatic_order(&mut self, order_id: String, terms: Terms) -> Order {
        self.create_order_inner(order_id, terms, true)
    }

    fn create_order_inner(&mut self, order_id: String, terms: Terms, automatic: bool) -> Order {
        bounded(&order_id, 64);
        bounded(&terms.line_id, 64);
        bounded(&terms.description, 160);
        bounded(&terms.unit, 32);
        require!(
            env::attached_deposit() >= NearToken::from_near(1),
            "Attach 1 NEAR for bounded order storage and calls"
        );
        require!(self.orders.get(&order_id).is_none(), "Order exists");
        let buyer = env::predecessor_account_id();
        require!(
            buyer != terms.supplier && buyer != terms.operator,
            "Buyer, supplier and payment service must be separate"
        );
        require!(
            terms.supplier != terms.operator
                && terms.supplier != terms.receiver
                && terms.operator != terms.receiver,
            "Separate authority accounts required"
        );
        require!(
            terms.payout != env::current_account_id(),
            "Payout cannot be vault"
        );
        require!(
            terms.ordered.0 > 0 && terms.unit_price.0 > 0,
            "Positive quantities and price required"
        );
        require!(
            terms
                .unit_price
                .0
                .checked_mul(terms.ordered.0 as u128)
                .is_some(),
            "Budget overflow"
        );
        require!(
            terms.expires_at.0 > env::block_timestamp(),
            "Expired proposal"
        );
        let canonical = near_sdk::borsh::to_vec(&(
            self.network.clone(),
            env::current_account_id(),
            order_id.clone(),
            1u32,
            buyer.clone(),
            self.token.clone(),
            terms.clone(),
        ))
        .unwrap_or_else(|_| env::panic_str("Cannot encode terms"));
        let order = Order {
            id: order_id.clone(),
            buyer,
            token: self.token.clone(),
            terms,
            terms_hash: if automatic {
                digest(&near_sdk::borsh::to_vec(&("accord-automatic-v1", canonical)).unwrap())
            } else {
                digest(&canonical)
            },
            accepted_terms: false,
            funded: U128(0),
            accepted: U64(0),
            paid: U64(0),
            pending: U64(0),
            sequence: U64(0),
            attempts: 0,
        };
        self.orders.insert(&order_id, &order);
        if automatic {
            Self::automatic_orders().insert(&order_id, &true);
        }
        event(
            "order_created",
            json!({"order_id": order_id, "terms_hash": order.terms_hash, "automatic_payment": automatic}),
        );
        order
    }

    #[payable]
    pub fn accept_order(&mut self, order_id: String, terms_hash: String) {
        self.require_customer_approval(&order_id);
        let mut order = self.order(&order_id);
        require!(
            env::predecessor_account_id() == order.terms.supplier,
            "Supplier only"
        );
        require!(
            !order.accepted_terms && order.funded.0 == 0,
            "Terms already accepted"
        );
        require!(
            env::block_timestamp() < order.terms.expires_at.0,
            "Expired proposal"
        );
        require!(terms_hash == order.terms_hash, "Terms mismatch");
        order.accepted_terms = true;
        self.orders.insert(&order_id, &order);
        event(
            "terms_accepted",
            json!({"order_id": order_id, "terms_hash": terms_hash}),
        );
    }

    #[payable]
    pub fn confirm_delivery(
        &mut self,
        order_id: String,
        sequence: U64,
        cumulative_quantity: U64,
        receipt_hash: String,
    ) {
        self.require_customer_approval(&order_id);
        let mut order = self.order(&order_id);
        self.active(&order);
        require!(
            env::predecessor_account_id() == order.terms.receiver,
            "Receiver only"
        );
        require!(
            receipt_hash.len() == 64 && receipt_hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "SHA256 receipt hash required"
        );
        require!(
            order.sequence.0.checked_add(1) == Some(sequence.0),
            "Stale or skipped delivery sequence"
        );
        require!(
            cumulative_quantity.0 > order.accepted.0
                && cumulative_quantity.0 <= order.terms.ordered.0,
            "Invalid cumulative delivery"
        );
        order.sequence = sequence;
        order.accepted = cumulative_quantity;
        self.orders.insert(&order_id, &order);
        event(
            "delivery_confirmed",
            json!({"order_id":order_id,"sequence":sequence,"cumulative_quantity":cumulative_quantity,"receipt_hash":receipt_hash}),
        );
    }

    /// No recipient argument: the operator cannot redirect settlement.
    pub fn request_payment(
        &mut self,
        order_id: String,
        request_id: String,
        quantity: U64,
        audit_hash: String,
        invoice: Option<InvoicePayload>,
    ) -> Promise {
        let mut order = self.order(&order_id);
        self.active(&order);
        require!(
            env::predecessor_account_id() == order.terms.operator,
            "Operator only"
        );
        let invoice =
            invoice.unwrap_or_else(|| env::panic_str("Supplier-confirmed invoice required"));
        let commitment = self.require_confirmed_invoice(&order, &invoice, quantity, &audit_hash);
        bounded(&request_id, 64);
        require!(
            audit_hash.len() == 64 && audit_hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "SHA256 audit hash required"
        );
        require!(
            self.attempts.get(&request_id).is_none(),
            "Request already exists"
        );
        require!(order.attempts < MAX_ATTEMPTS, "Order attempt limit reached");
        let available = order
            .accepted
            .0
            .checked_sub(order.paid.0)
            .and_then(|v| v.checked_sub(order.pending.0))
            .unwrap_or_else(|| env::panic_str("Invalid accounting"));
        require!(
            quantity.0 > 0 && quantity.0 <= available,
            "Quantity exceeds available entitlement"
        );
        require!(
            env::prepaid_gas().as_gas() >= Gas::from_tgas(80).as_gas(),
            "Attach at least 80 Tgas"
        );
        if self.automatic(&order_id) {
            require!(
                quantity.0 <= self.invoice_available(&commitment, invoice.quantity.0),
                "Confirmed invoice quantity already paid or reserved"
            );
            let mut ids = Self::automatic_invoice_attempts()
                .get(&commitment)
                .unwrap_or_default();
            ids.push(request_id.clone());
            Self::automatic_invoice_attempts().insert(&commitment, &ids);
        }
        let amount = order
            .terms
            .unit_price
            .0
            .checked_mul(quantity.0 as u128)
            .unwrap_or_else(|| env::panic_str("Amount overflow"));
        let attempt = Attempt {
            request_id: request_id.clone(),
            order_id: order_id.clone(),
            quantity,
            amount: U128(amount),
            recipient: order.terms.payout.clone(),
            audit_hash,
            status: AttemptStatus::Reserved,
        };
        order.pending = U64(order.pending.0 + quantity.0);
        order.attempts += 1;
        self.orders.insert(&order_id, &order);
        self.attempts.insert(&request_id, &attempt);
        event("payment_reserved", json!(&attempt));
        event(
            "payment_invoice_bound",
            json!({"request_id":request_id,"commitment":commitment}),
        );
        Promise::new(self.token.clone())
            .function_call(
                "ft_transfer",
                json!({"receiver_id":attempt.recipient,"amount":U128(amount),"memo":request_id})
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                TRANSFER_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_payment_result(request_id),
            )
    }

    #[private]
    pub fn on_payment_result(&mut self, request_id: String) -> CallbackDisposition {
        let Some(mut attempt) = self.attempts.get(&request_id) else {
            return CallbackDisposition::NeedsReconciliation;
        };
        if attempt.status != AttemptStatus::Reserved {
            return CallbackDisposition::AlreadyFinalized;
        }
        if env::promise_results_count() != 1 {
            return CallbackDisposition::NeedsReconciliation;
        }
        let Some(mut order) = self.orders.get(&attempt.order_id) else {
            return CallbackDisposition::NeedsReconciliation;
        };
        let Some(pending) = order.pending.0.checked_sub(attempt.quantity.0) else {
            return CallbackDisposition::NeedsReconciliation;
        };
        let success = match env::promise_result_checked(0, 1024) {
            Ok(_) => true,
            Err(PromiseError::Failed) => false,
            // An unexpected successful return payload must not release capacity.
            Err(_) => return CallbackDisposition::NeedsReconciliation,
        };
        if success {
            let Some(paid) = order.paid.0.checked_add(attempt.quantity.0) else {
                return CallbackDisposition::NeedsReconciliation;
            };
            if paid
                .checked_add(pending)
                .is_none_or(|v| v > order.accepted.0)
            {
                return CallbackDisposition::NeedsReconciliation;
            }
            order.paid = U64(paid);
            attempt.status = AttemptStatus::Settled;
        } else {
            attempt.status = AttemptStatus::TransferFailed;
        }
        order.pending = U64(pending);
        self.orders.insert(&attempt.order_id, &order);
        self.attempts.insert(&request_id, &attempt);
        event("payment_result", json!(&attempt));
        if success {
            CallbackDisposition::Settled
        } else {
            CallbackDisposition::TransferFailed
        }
    }

    pub fn get_order(&self, order_id: String) -> Option<Order> {
        self.orders.get(&order_id)
    }
    pub fn get_attempt(&self, request_id: String) -> Option<Attempt> {
        self.attempts.get(&request_id)
    }
    pub fn list_orders(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Order> {
        self.orders
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(20).min(50) as usize)
            .collect()
    }
    fn order(&self, id: &String) -> Order {
        self.orders
            .get(id)
            .unwrap_or_else(|| env::panic_str("Unknown order"))
    }
    fn active(&self, order: &Order) {
        require!(
            order.accepted_terms && order.funded.0 > 0,
            "Order not active"
        );
        require!(
            self.recovery(&order.id).phase == ClosePhase::Open,
            "Order is closing or closed"
        );
    }
}

#[near]
impl FungibleTokenReceiver for Vault {
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        // Invalid deposits are returned through the standard token resolver.
        if env::predecessor_account_id() != self.token || msg.len() > 64 {
            return PromiseOrValue::Value(amount);
        }
        let Some(mut order) = self.orders.get(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        let expected = order
            .terms
            .unit_price
            .0
            .checked_mul(order.terms.ordered.0 as u128);
        if sender_id != order.buyer
            || !order.accepted_terms
            || order.funded.0 != 0
            || expected != Some(amount.0)
            || env::block_timestamp() >= order.terms.expires_at.0
            || self.recovery(&msg).phase != ClosePhase::Open
        {
            return PromiseOrValue::Value(amount);
        }
        order.funded = amount;
        self.orders.insert(&msg, &order);
        event("order_funded", json!({"order_id":msg,"amount":amount}));
        PromiseOrValue::Value(U128(0))
    }
}

#[cfg(test)]
mod tests;
