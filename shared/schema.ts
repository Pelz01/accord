import { z } from 'zod';

export const accountSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/);
export const integerString = z
  .string()
  .regex(/^(0|[1-9]\d{0,37})$/)
  .refine((v) => BigInt(v) <= (1n << 128n) - 1n, 'Amount exceeds u128');
export const quantitySchema = z.number().int().positive().max(1_000_000);
export const invoiceSchema = z.strictObject({
  orderId: z.string().min(1).max(64),
  reference: z.string().min(1).max(80),
  lineId: z.string().min(1).max(64),
  quantity: quantitySchema,
  token: z.literal('aUSD'),
  amountBaseUnits: integerString,
});
export type Invoice = z.infer<typeof invoiceSchema>;
export const createSchema = z.strictObject({
  supplierName: z.string().trim().min(2).max(80),
  supplier: accountSchema,
  receiver: accountSchema,
  operator: accountSchema,
  payout: accountSchema,
  description: z.string().trim().min(2).max(160),
  ordered: quantitySchema,
  unitPrice: integerString.refine((v) => BigInt(v) > 0n, 'Price must be positive'),
});
export type CreateOrder = z.infer<typeof createSchema>;
export type Role = 'buyer' | 'supplier' | 'receiver' | 'operator';
export type ExtractionMode = 'sample' | 'live';
export type Order = CreateOrder & {
  id: string;
  buyer: string;
  lineId: string;
  token: string;
  termsHash: string;
  acceptedTerms: boolean;
  funded: string;
  accepted: number;
  paid: number;
  pending: number;
  sequence: number;
  createdAt: string;
};
export type Attempt = {
  id: string;
  orderId: string;
  quantity: number;
  amount: string;
  recipient: string;
  invoiceHash: string;
  status: 'reserved' | 'processing' | 'settled' | 'failed' | 'unresolved';
  createdAt: string;
  updatedAt: string;
  transferApplied: boolean;
};
export type AuditEvent = {
  id: string;
  orderId: string;
  at: string;
  kind: string;
  message: string;
  role: Role | 'system';
};
export type Extraction = {
  id: string;
  orderId: string;
  mode: ExtractionMode;
  invoice: Invoice;
  documentHash: string;
  model: string | null;
  recordedAt: string;
  providerRequestId: string | null;
};
export type Snapshot = {
  orders: Order[];
  attempts: Attempt[];
  events: AuditEvent[];
  extractions: Extraction[];
  simulatedSupplierBalances: Record<string, string>;
};
export type Bootstrap = Snapshot & {
  environment: 'local-simulation';
  liveAiAvailable: boolean;
  chain: { network: string; contract: string | null; status: 'not-deployed' };
};
export function available(o: Order) {
  return o.accepted - o.paid - o.pending;
}
export function value(quantity: number, price: string) {
  return (BigInt(quantity) * BigInt(price)).toString();
}
export function money(base: string) {
  const v = BigInt(base);
  return `${(v / 1_000_000n).toLocaleString('en-US')}${v % 1_000_000n ? '.' + (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '') : ''}`;
}
