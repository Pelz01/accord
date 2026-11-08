use super::*;
use near_sdk::collections::LookupMap;

#[near(serializers = [json])]
pub struct InvoiceAvailability {
    pub commitment: String,
    pub available: U64,
}

#[near(serializers = [json])]
pub struct PaymentPolicy {
    pub mode: String,
    pub invoices: Vec<InvoiceAvailability>,
}

impl Vault {
    // Fixed-prefix sidecars preserve every deployed Vault/Order/Attempt layout.
    pub(crate) fn automatic_orders() -> LookupMap<String, bool> {
        LookupMap::new(b"accord:automatic:v1:".to_vec())
    }

    pub(crate) fn automatic_invoice_attempts() -> LookupMap<String, Vec<String>> {
        LookupMap::new(b"accord:automatic-invoice-attempts:v1:".to_vec())
    }

    pub(crate) fn automatic(&self, order_id: &String) -> bool {
        Self::automatic_orders().get(order_id).unwrap_or(false)
    }

    pub(crate) fn require_customer_approval(&self, order_id: &String) {
        if self.automatic(order_id) {
            require!(
                env::attached_deposit() == NearToken::from_yoctonear(1),
                "Attach exactly 1 yoctoNEAR for wallet approval"
            );
        } else {
            require!(
                env::attached_deposit().is_zero(),
                "Manual order approval requires zero deposit"
            );
        }
    }

    pub(crate) fn invoice_available(&self, commitment: &String, quantity: u64) -> u64 {
        let used = Self::automatic_invoice_attempts()
            .get(commitment)
            .unwrap_or_default()
            .iter()
            .map(|id| {
                let attempt = self
                    .attempts
                    .get(id)
                    .unwrap_or_else(|| env::panic_str("Missing invoice attempt"));
                if attempt.status == AttemptStatus::TransferFailed {
                    0
                } else {
                    attempt.quantity.0
                }
            })
            .try_fold(0u64, |sum, value| sum.checked_add(value))
            .unwrap_or_else(|| env::panic_str("Invoice accounting overflow"));
        quantity
            .checked_sub(used)
            .unwrap_or_else(|| env::panic_str("Invalid invoice accounting"))
    }
}

#[near]
impl Vault {
    pub fn get_payment_policy(&self, order_id: String) -> PaymentPolicy {
        self.order(&order_id);
        let automatic = self.automatic(&order_id);
        PaymentPolicy {
            mode: if automatic { "automatic" } else { "manual" }.into(),
            invoices: if automatic {
                self.list_invoices(order_id)
                    .into_iter()
                    .map(|record| InvoiceAvailability {
                        available: U64(
                            self.invoice_available(&record.commitment, record.invoice.quantity.0)
                        ),
                        commitment: record.commitment,
                    })
                    .collect()
            } else {
                vec![]
            },
        }
    }
}
