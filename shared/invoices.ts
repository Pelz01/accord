import { z } from 'zod';
import { accountSchema, integerString, type Extraction } from './schema';
import type { ChainOrder } from './chain';

export const invoicePayloadSchema = z.strictObject({
  order_id: z.string().min(1).max(64),
  terms_version: z.literal(1),
  terms_hash: z.string().regex(/^[a-f0-9]{64}$/),
  document_hash: z.string().regex(/^[a-f0-9]{64}$/),
  reference: z
    .string()
    .min(1)
    .max(80)
    .refine(
      (v) =>
        v.trim() === v && !/[\x00-\x1f\x7f]/.test(v) && new TextEncoder().encode(v).length <= 80,
    ),
  line_id: z.string().min(1).max(64),
  quantity: z
    .string()
    .regex(/^[1-9]\d{0,18}$/)
    .refine((v) => BigInt(v) <= (1n << 64n) - 1n),
  token: accountSchema,
  amount: integerString,
});
export type InvoicePayload = z.infer<typeof invoicePayloadSchema>;
export type InvoiceConfirmation = { commitment: string; supplier: string; invoice: InvoicePayload };
export type SavedInvoice = Extraction & {
  payload: InvoicePayload;
  documentId: string | null;
  sourceText: string;
};

export function invoiceMatchesOrder(order: ChainOrder, value: unknown): value is InvoicePayload {
  const result = invoicePayloadSchema.safeParse(value);
  if (!result.success) return false;
  const i = result.data;
  return (
    i.order_id === order.id &&
    i.terms_hash === order.terms_hash &&
    i.token === order.token &&
    i.line_id === order.terms.line_id &&
    BigInt(i.amount) === BigInt(i.quantity) * BigInt(order.terms.unit_price)
  );
}

export function confirmationsForOrder(order: ChainOrder, records: InvoiceConfirmation[] = []) {
  return records.filter(
    (record) =>
      record.supplier === order.terms.supplier &&
      /^[a-f0-9]{64}$/.test(record.commitment) &&
      invoiceMatchesOrder(order, record.invoice),
  );
}

export function canonicalInvoice(network: string, vault: string, invoice: InvoicePayload) {
  const i = invoicePayloadSchema.parse(invoice);
  return JSON.stringify([
    'accord-invoice-v1',
    network,
    vault,
    i.order_id,
    i.terms_version,
    i.terms_hash,
    i.document_hash,
    i.reference,
    i.line_id,
    i.quantity,
    i.token,
    i.amount,
  ]);
}
export async function invoiceCommitment(network: string, vault: string, invoice: InvoicePayload) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalInvoice(network, vault, invoice)),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function invoicePayload(order: ChainOrder, extraction: Extraction): InvoicePayload {
  return invoicePayloadSchema.parse({
    order_id: order.id,
    terms_version: 1,
    terms_hash: order.terms_hash,
    document_hash: extraction.documentHash,
    reference: extraction.invoice.reference,
    line_id: extraction.invoice.lineId,
    quantity: String(extraction.invoice.quantity),
    token: order.token,
    amount: extraction.invoice.amountBaseUnits,
  });
}
