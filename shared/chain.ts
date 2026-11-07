export type ChainTerms = {
  supplier: string;
  receiver: string;
  operator: string;
  payout: string;
  line_id: string;
  description: string;
  unit: string;
  ordered: string;
  unit_price: string;
  expires_at: string;
};
export type ChainOrder = {
  id: string;
  buyer: string;
  token: string;
  terms: ChainTerms;
  terms_hash: string;
  accepted_terms: boolean;
  funded: string;
  accepted: string;
  paid: string;
  pending: string;
  sequence: string;
  attempts: number;
};
export type ChainAttempt = {
  request_id: string;
  order_id: string;
  quantity: string;
  amount: string;
  recipient: string;
  audit_hash: string;
  status: 'Reserved' | 'Settled' | 'TransferFailed' | 'ReceiptAcknowledged';
};
export type ChainRecovery = {
  phase: 'Open' | 'RefundPending' | 'RefundFailed' | 'Closed';
  proposal: null | {
    hash: string;
    proposed_by: string;
    expires_at: string;
    refund_amount: string;
  };
  refund_pending: string;
  refunded: string;
  refunds: {
    id: number;
    amount: string;
    recipient: string;
    status: ChainAttempt['status'];
  }[];
};
export type Deployment = {
  network: 'testnet' | 'mainnet';
  rpcUrl: string;
  vault: string;
  token: string;
  operator: string;
  wasmSha256: Record<string, string>;
  accounts: Record<string, string>;
  trackedRequestIds?: string[];
  features?: ('recovery-v1' | 'invoice-v1' | 'documents-v1')[];
};
export type ChainState = {
  authRequired?: boolean;
  configured: boolean;
  deployment: Deployment | null;
  orders: ChainOrder[];
  attempts: ChainAttempt[];
  recoveries?: Record<string, ChainRecovery>;
  confirmations?: Record<string, import('./invoices').InvoiceConfirmation[]>;
  operatorReady: boolean;
  liveAiAvailable: boolean;
};
export type ChainJob = {
  id: string;
  orderId: string;
  quantity: string;
  auditHash: string;
  status: 'queued' | 'submitting' | 'settled' | 'failed' | 'unresolved';
  transactionHash: string | null;
  error: string | null;
  createdAt: string;
};
export function chainAvailable(o: ChainOrder) {
  return BigInt(o.accepted) - BigInt(o.paid) - BigInt(o.pending);
}
export function ordersForAccount(orders: ChainOrder[], account: string | null) {
  if (!account) return [];
  return orders.filter((o) =>
    [o.buyer, o.terms.supplier, o.terms.receiver, o.terms.operator, o.terms.payout].includes(
      account,
    ),
  );
}
