use super::*;
use near_sdk::collections::LookupMap;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoicePayload {
    pub order_id: String,
    pub terms_version: u32,
    pub terms_hash: String,
    pub document_hash: String,
    pub reference: String,
    pub line_id: String,
    pub quantity: U64,
    pub token: AccountId,
    pub amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct InvoiceConfirmation {
    pub commitment: String,
    pub supplier: AccountId,
    pub invoice: InvoicePayload,
}

impl Vault {
    fn invoice_map() -> LookupMap<String, InvoiceConfirmation> {
        LookupMap::new(b"accord:invoice:v1:".to_vec())
    }
    fn invoice_index() -> LookupMap<String, Vec<String>> {
        LookupMap::new(b"accord:invoice-index:v1:".to_vec())
    }
    pub(crate) fn invoice_ids(&self, order_id: &String) -> Vec<String> {
        Self::invoice_index().get(order_id).unwrap_or_default()
    }
    pub(crate) fn invoice_commitment(&self, invoice: &InvoicePayload) -> String {
        // Canonical UTF-8 JSON array. Integer values are decimal strings, except
        // the pinned terms version. The same vector is tested in TypeScript.
        digest(
            json!([
                "accord-invoice-v1",
                self.network,
                env::current_account_id(),
                invoice.order_id,
                invoice.terms_version,
                invoice.terms_hash,
                invoice.document_hash,
                invoice.reference,
                invoice.line_id,
                invoice.quantity,
                invoice.token,
                invoice.amount
            ])
            .to_string()
            .as_bytes(),
        )
    }
    fn validate_invoice(&self, order: &Order, invoice: &InvoicePayload) {
        require!(
            invoice.order_id == order.id
                && invoice.terms_version == 1
                && invoice.terms_hash == order.terms_hash
                && invoice.line_id == order.terms.line_id
                && invoice.token == self.token,
            "Invoice does not match accepted terms"
        );
        bounded(&invoice.reference, 80);
        require!(
            invoice.reference.trim() == invoice.reference
                && !invoice.reference.chars().any(char::is_control),
            "Invalid invoice reference"
        );
        require!(
            invoice.document_hash.len() == 64
                && invoice
                    .document_hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "SHA256 document hash required"
        );
        require!(
            invoice.quantity.0 > 0 && invoice.quantity.0 <= order.terms.ordered.0,
            "Invalid invoice quantity"
        );
        require!(
            order
                .terms
                .unit_price
                .0
                .checked_mul(invoice.quantity.0 as u128)
                == Some(invoice.amount.0),
            "Invoice amount does not match fixed price"
        );
    }
    pub(crate) fn require_confirmed_invoice(
        &self,
        order: &Order,
        invoice: &InvoicePayload,
        quantity: U64,
        audit_hash: &str,
    ) -> String {
        self.validate_invoice(order, invoice);
        require!(
            quantity.0 <= invoice.quantity.0 && audit_hash == invoice.document_hash,
            "Payment differs from confirmed invoice"
        );
        let commitment = self.invoice_commitment(invoice);
        let record = Self::invoice_map()
            .get(&commitment)
            .unwrap_or_else(|| env::panic_str("Supplier-confirmed invoice required"));
        require!(
            record.supplier == order.terms.supplier && record.invoice == *invoice,
            "Invoice confirmation mismatch"
        );
        commitment
    }
}

#[near]
impl Vault {
    pub fn confirm_invoice(
        &mut self,
        order_id: String,
        invoice: InvoicePayload,
    ) -> InvoiceConfirmation {
        let order = self.order(&order_id);
        self.active(&order);
        require!(
            env::predecessor_account_id() == order.terms.supplier,
            "Supplier only"
        );
        self.validate_invoice(&order, &invoice);
        let commitment = self.invoice_commitment(&invoice);
        if let Some(existing) = Self::invoice_map().get(&commitment) {
            return existing;
        }
        let mut ids = Self::invoice_index().get(&order_id).unwrap_or_default();
        require!(ids.len() < 32, "Invoice confirmation limit reached");
        let record = InvoiceConfirmation {
            commitment: commitment.clone(),
            supplier: order.terms.supplier,
            invoice,
        };
        Self::invoice_map().insert(&commitment, &record);
        ids.push(commitment);
        Self::invoice_index().insert(&order_id, &ids);
        event("invoice_confirmed", json!(&record));
        record
    }
    pub fn get_invoice(&self, commitment: String) -> Option<InvoiceConfirmation> {
        Self::invoice_map().get(&commitment)
    }
    pub fn list_invoices(&self, order_id: String) -> Vec<InvoiceConfirmation> {
        self.order(&order_id);
        Self::invoice_index()
            .get(&order_id)
            .unwrap_or_default()
            .iter()
            .filter_map(|id| Self::invoice_map().get(id))
            .collect()
    }
}
