import type { ChainState, Deployment } from './chain';
import type { OrderPosition } from './payables';
import type { PaymentRow } from './payments';

export function exactAmount(base: string) {
  const amount = BigInt(base);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return whole.toString() + (fraction ? '.' + fraction : '');
}
export function csv(records: (string | number | null | undefined)[][]) {
  return (
    '\uFEFF' +
    records
      .map((row) =>
        row
          .map((value) => {
            const text = String(value ?? '');
            // Quoting alone does not prevent spreadsheet formulas from untrusted fields.
            const safe =
              /^[\u0000-\u0020]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? "'" + text : text;
            return '"' + safe.replaceAll('"', '""') + '"';
          })
          .join(','),
      )
      .join('\r\n') +
    '\r\n'
  );
}
export function isoDate(value: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '';
}
export function orderCSV(
  rows: OrderPosition[],
  deployment: Deployment,
  capturedAt: string,
  coverage?: ChainState['coverage'],
) {
  return csv([
    [
      'snapshot_at_utc',
      'source_order_coverage',
      'network',
      'vault',
      'token_contract',
      'token_symbol',
      'token_decimals',
      'order_id',
      'buyer',
      'supplier',
      'payout_account',
      'item',
      'status',
      'ordered_quantity',
      'accepted_quantity',
      'paid_quantity',
      'pending_quantity',
      'unit_price',
      'funded',
      'paid',
      'refunded',
      'remaining_committed',
      'ready_for_review',
      'invoice_review_needed',
      'processing',
      'payment_review_held',
      'awaiting_dispatch',
      'awaiting_delivery',
      'refund_held',
      'terms_hash',
    ],
    ...rows.map((row) => [
      isoDate(capturedAt),
      coverage?.ordersComplete === undefined
        ? 'unknown'
        : coverage.ordersComplete
          ? 'complete'
          : 'partial',
      deployment.network,
      deployment.vault,
      row.order.token,
      'aUSD',
      6,
      row.order.id,
      row.order.buyer,
      row.order.terms.supplier,
      row.order.terms.payout,
      row.order.terms.description,
      row.status,
      row.order.terms.ordered,
      row.order.accepted,
      row.order.paid,
      row.order.pending,
      ...[
        row.order.terms.unit_price,
        row.funded,
        row.paid,
        row.refunded,
        row.committed,
        row.ready,
        row.invoiceReview,
        row.processing,
        row.reviewHeld,
        row.awaitingDispatch,
        row.awaitingDelivery,
        row.refundHeld,
      ].map(exactAmount),
      row.order.terms_hash,
    ]),
  ]);
}
export function paymentCSV(
  rows: PaymentRow[],
  deployment: Deployment,
  capturedAt: string,
  coverage?: ChainState['coverage'],
) {
  return csv([
    [
      'snapshot_at_utc',
      'source_payment_coverage',
      'network',
      'vault',
      'token_contract',
      'token_symbol',
      'token_decimals',
      'request_id',
      'order_id',
      'buyer',
      'supplier',
      'recipient',
      'quantity',
      'unit',
      'amount',
      'amount_base_units',
      'status',
      'confirmation_source',
      'requested_at_utc',
      'invoice_reference',
      'document_sha256',
      'transaction_hash',
    ],
    ...rows.map((row) => [
      isoDate(capturedAt),
      coverage?.attemptsComplete === undefined
        ? 'unknown'
        : coverage.attemptsComplete
          ? 'complete'
          : 'partial',
      deployment.network,
      deployment.vault,
      row.order.token,
      'aUSD',
      6,
      row.id,
      row.order.id,
      row.order.buyer,
      row.order.terms.supplier,
      row.recipient,
      row.quantity,
      row.order.terms.unit,
      exactAmount(row.amount),
      row.amount,
      row.status,
      row.settlement === 'contract'
        ? 'Contract settlement'
        : row.settlement === 'recipient'
          ? 'Recipient acknowledgment'
          : '',
      isoDate(row.createdAt),
      row.invoice?.reference ?? '',
      row.auditHash,
      row.transactionHash ?? '',
    ]),
  ]);
}
export function refundCSV(
  rows: OrderPosition[],
  deployment: Deployment,
  capturedAt: string,
  coverage?: ChainState['coverage'],
) {
  return csv([
    [
      'snapshot_at_utc',
      'source_order_coverage',
      'network',
      'vault',
      'token_contract',
      'token_symbol',
      'token_decimals',
      'order_id',
      'refund_id',
      'recipient',
      'amount',
      'amount_base_units',
      'status',
      'confirmation_source',
    ],
    ...rows.flatMap((row) =>
      (row.recovery?.refunds ?? []).map((refund) => [
        isoDate(capturedAt),
        coverage?.ordersComplete === undefined
          ? 'unknown'
          : coverage.ordersComplete
            ? 'complete'
            : 'partial',
        deployment.network,
        deployment.vault,
        row.order.token,
        'aUSD',
        6,
        row.order.id,
        refund.id,
        refund.recipient,
        exactAmount(refund.amount),
        refund.amount,
        refund.status,
        refund.status === 'ReceiptAcknowledged'
          ? 'Recipient acknowledgment'
          : refund.status === 'Settled'
            ? 'Contract settlement'
            : '',
      ]),
    ),
  ]);
}

export const hasAdvice = (row: PaymentRow) =>
  row.status === 'Paid' && (row.settlement === 'contract' || row.settlement === 'recipient');
export function advicePath(requestId: string) {
  return '/workspace?' + new URLSearchParams({ view: 'payments', payment: requestId }).toString();
}
