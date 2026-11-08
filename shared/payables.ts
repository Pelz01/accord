import {
  ordersForAccount,
  type ChainJob,
  type ChainOrder,
  type ChainRecovery,
  type ChainState,
} from './chain';
import { confirmationsForOrder } from './invoices';
import { paymentRows } from './payments';

export type PositionStatus =
  | 'Ready to review'
  | 'Payment scheduled'
  | 'Invoice review needed'
  | 'Payment in progress'
  | 'Awaiting delivery'
  | 'Awaiting acceptance'
  | 'Awaiting funding'
  | 'Needs review'
  | 'Expired order'
  | 'Refund pending'
  | 'Refund needs review'
  | 'Closed'
  | 'Fulfilled';
export type OrderPosition = {
  order: ChainOrder;
  automatic: boolean;
  status: PositionStatus;
  funded: string;
  paid: string;
  refunded: string;
  committed: string;
  ready: string;
  invoiceReview: string;
  processing: string;
  reviewHeld: string;
  awaitingDispatch: string;
  awaitingDelivery: string;
  refundHeld: string;
  confirmedInvoices: number;
  needsReview: boolean;
  recovery?: ChainRecovery;
};
const max0 = (value: bigint) => (value > 0n ? value : 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

// Amounts are order entitlements, not an inferred per-invoice outstanding ledger.
// Unrecorded worker requests hold review capacity until their outcomes are known.
export function orderPositions(
  state: ChainState,
  jobs: ChainJob[],
  account: string | null,
  scope: 'buyer' | 'supplier' | 'all' = 'buyer',
  now = Date.now(),
): OrderPosition[] {
  const rows = paymentRows(state.orders, state.attempts, jobs, account, state.deployment);
  return ordersForAccount(state.orders, account)
    .filter(
      (order) =>
        (!state.deployment || order.token === state.deployment.token) &&
        (scope === 'all' ||
          (scope === 'buyer'
            ? order.buyer === account
            : order.terms.supplier === account || order.terms.payout === account)),
    )
    .map((order) => {
      const policy = state.paymentPolicies?.[order.id];
      const price = BigInt(order.terms.unit_price);
      const funded = BigInt(order.funded);
      const paid = BigInt(order.paid) * price;
      const recovery = state.recoveries?.[order.id];
      const refunded = BigInt(recovery?.refunded ?? '0');
      const committed = max0(funded - paid - refunded);
      const acceptedUnpaid = min(
        committed,
        max0(BigInt(order.accepted) - BigInt(order.paid)) * price,
      );
      const pending = min(acceptedUnpaid, BigInt(order.pending) * price);
      const requests = rows.filter((row) => row.order.id === order.id);
      const queued = requests
        .filter((row) => row.source === 'worker' && row.status !== 'Failed')
        .reduce((sum, row) => sum + BigInt(row.amount), 0n);
      const awaitingDispatch = min(max0(acceptedUnpaid - pending), queued);
      const processing = pending + awaitingDispatch;
      const contractReview = requests
        .filter((row) => row.source === 'contract' && row.status === 'Needs review')
        .reduce((sum, row) => sum + BigInt(row.amount), 0n);
      const workerReview = requests
        .filter(
          (row) => row.source === 'worker' && ['Needs review', 'Checking'].includes(row.status),
        )
        .reduce((sum, row) => sum + BigInt(row.amount), 0n);
      const reviewHeld = min(pending, contractReview) + min(awaitingDispatch, workerReview);
      const available = max0(acceptedUnpaid - processing);
      const invoices = confirmationsForOrder(order, state.confirmations?.[order.id]);
      const open = !recovery || recovery.phase === 'Open';
      const fundedInFull = order.accepted_terms && funded === BigInt(order.terms.ordered) * price;
      const capacity = invoices.reduce((largest, i) => {
        const quantity =
          policy?.mode === 'automatic'
            ? (policy.invoices.find((entry) => entry.commitment === i.commitment)?.available ?? '0')
            : i.invoice.quantity;
        const amount = BigInt(quantity) * price;
        return policy?.mode === 'automatic'
          ? largest + amount
          : amount > largest
            ? amount
            : largest;
      }, 0n);
      const automaticFailure = jobs.some(
        (job) =>
          job.orderId === order.id &&
          job.authorization === 'automatic' &&
          job.status === 'failed' &&
          job.vault === state.deployment?.vault &&
          job.network === state.deployment?.network,
      );
      const ready = open && fundedInFull && !automaticFailure ? min(available, capacity) : 0n;
      const invoiceReview = open && fundedInFull ? available - ready : 0n;
      const awaitingDelivery = open && fundedInFull ? max0(committed - acceptedUnpaid) : 0n;
      const refundHeld = !open ? committed : 0n;
      const unresolved = requests.some(
        (row) => row.status === 'Needs review' || row.status === 'Checking',
      );
      const needsReview = unresolved || automaticFailure || recovery?.phase === 'RefundFailed';
      const expired = !fundedInFull && BigInt(order.terms.expires_at) <= BigInt(now) * 1_000_000n;
      const status: PositionStatus =
        recovery?.phase === 'Closed'
          ? 'Closed'
          : recovery?.phase === 'RefundPending'
            ? 'Refund pending'
            : recovery?.phase === 'RefundFailed'
              ? 'Refund needs review'
              : needsReview
                ? 'Needs review'
                : expired
                  ? 'Expired order'
                  : !order.accepted_terms
                    ? 'Awaiting acceptance'
                    : !fundedInFull
                      ? 'Awaiting funding'
                      : ready > 0n
                        ? state.paymentPolicies?.[order.id]?.mode === 'automatic'
                          ? 'Payment scheduled'
                          : 'Ready to review'
                        : invoiceReview > 0n
                          ? 'Invoice review needed'
                          : processing > 0n
                            ? 'Payment in progress'
                            : order.paid === order.terms.ordered
                              ? 'Fulfilled'
                              : 'Awaiting delivery';
      return {
        order,
        automatic: policy?.mode === 'automatic',
        status,
        funded: funded.toString(),
        paid: paid.toString(),
        refunded: refunded.toString(),
        committed: committed.toString(),
        ready: ready.toString(),
        invoiceReview: invoiceReview.toString(),
        processing: processing.toString(),
        reviewHeld: reviewHeld.toString(),
        awaitingDispatch: awaitingDispatch.toString(),
        awaitingDelivery: awaitingDelivery.toString(),
        refundHeld: refundHeld.toString(),
        confirmedInvoices: invoices.length,
        needsReview,
        recovery,
      };
    });
}

export function positionTotals(positions: OrderPosition[]) {
  const keys = [
    'funded',
    'paid',
    'refunded',
    'committed',
    'ready',
    'invoiceReview',
    'processing',
    'reviewHeld',
    'awaitingDispatch',
    'awaitingDelivery',
    'refundHeld',
  ] as const;
  return Object.fromEntries(
    keys.map((key) => [key, positions.reduce((sum, row) => sum + BigInt(row[key]), 0n).toString()]),
  ) as Record<(typeof keys)[number], string>;
}
