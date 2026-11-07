import { ordersForAccount, type ChainOrder, type ChainAttempt, type ChainJob } from './chain';

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
};

// Contract attempts determine settlement. A worker acknowledgement alone is not
// enough to call a transfer paid, and a reservation is never a failed transfer.
export function paymentRows(
  allOrders: ChainOrder[],
  attempts: ChainAttempt[],
  jobs: ChainJob[],
  account: string | null,
): PaymentRow[] {
  const orders = new Map(ordersForAccount(allOrders, account).map((order) => [order.id, order]));
  const byRequest = new Map<string, PaymentRow>();
  for (const job of jobs) {
    const order = orders.get(job.orderId);
    if (!order) continue;
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
    });
  }
  for (const attempt of attempts) {
    const order = orders.get(attempt.order_id);
    if (!order) continue;
    const previous = byRequest.get(attempt.request_id);
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
    });
  }
  return [...byRequest.values()].sort(
    (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id),
  );
}
