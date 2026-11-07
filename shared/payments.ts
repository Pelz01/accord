import {
  ordersForAccount,
  type ChainOrder,
  type ChainAttempt,
  type ChainJob,
  type Deployment,
} from './chain';
import { invoiceMatchesOrder, type InvoicePayload } from './invoices';

export type PaymentStatus =
  | 'Paid'
  | 'Pending'
  | 'Queued'
  | 'Processing'
  | 'Checking'
  | 'Needs review'
  | 'Failed';
export type PaymentRow = {
  id: string;
  order: ChainOrder;
  quantity: string;
  amount: string;
  recipient: string;
  status: PaymentStatus;
  transactionHash: string | null;
  createdAt: string | null;
  receiptAcknowledged?: boolean;
  source: 'worker' | 'contract';
  settlement: 'contract' | 'recipient' | null;
  auditHash: string;
  invoice: InvoicePayload | null;
};

// Contract attempts determine settlement. A worker acknowledgement alone is not
// enough to call a transfer paid, and a reservation is never a failed transfer.
export function paymentRows(
  allOrders: ChainOrder[],
  attempts: ChainAttempt[],
  jobs: ChainJob[],
  account: string | null,
  deployment?: Deployment | null,
): PaymentRow[] {
  const orders = new Map(
    ordersForAccount(allOrders, account)
      .filter((order) => !deployment || order.token === deployment.token)
      .map((order) => [order.id, order]),
  );
  const byRequest = new Map<string, PaymentRow>();
  for (const job of jobs) {
    const order = orders.get(job.orderId);
    if (
      !order ||
      (deployment &&
        ((job.network && job.network !== deployment.network) ||
          (job.vault && job.vault !== deployment.vault)))
    )
      continue;
    const statuses = {
      queued: 'Queued',
      submitting: 'Processing',
      settled: 'Checking',
      failed: 'Failed',
      unresolved: 'Needs review',
    } as const;
    byRequest.set(job.id, {
      id: job.id,
      order,
      quantity: job.quantity,
      amount: (BigInt(job.quantity) * BigInt(order.terms.unit_price)).toString(),
      recipient: order.terms.payout,
      status: statuses[job.status],
      transactionHash: job.transactionHash,
      createdAt: job.createdAt,
      source: 'worker',
      settlement: null,
      auditHash: job.auditHash,
      invoice:
        invoiceMatchesOrder(order, job.invoice) &&
        job.invoice.document_hash === job.auditHash &&
        BigInt(job.quantity) <= BigInt(job.invoice.quantity)
          ? job.invoice
          : null,
    });
  }
  for (const attempt of attempts) {
    const order = orders.get(attempt.order_id);
    if (!order) continue;
    const candidate = byRequest.get(attempt.request_id);
    const previous =
      candidate &&
      candidate.order.id === order.id &&
      candidate.quantity === attempt.quantity &&
      candidate.amount === attempt.amount &&
      candidate.recipient === attempt.recipient &&
      candidate.auditHash === attempt.audit_hash
        ? candidate
        : undefined;
    byRequest.set(attempt.request_id, {
      id: attempt.request_id,
      order,
      quantity: attempt.quantity,
      amount: attempt.amount,
      recipient: attempt.recipient,
      status:
        attempt.status === 'Settled' || attempt.status === 'ReceiptAcknowledged'
          ? 'Paid'
          : attempt.status === 'TransferFailed'
            ? 'Failed'
            : previous?.status === 'Needs review'
              ? 'Needs review'
              : 'Pending',
      transactionHash: previous?.transactionHash ?? null,
      createdAt: previous?.createdAt ?? null,
      receiptAcknowledged: attempt.status === 'ReceiptAcknowledged',
      source: 'contract',
      settlement:
        attempt.status === 'Settled'
          ? 'contract'
          : attempt.status === 'ReceiptAcknowledged'
            ? 'recipient'
            : null,
      auditHash: attempt.audit_hash,
      invoice: previous?.invoice ?? null,
    });
  }
  return [...byRequest.values()].sort(
    (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id),
  );
}
