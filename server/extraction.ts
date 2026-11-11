import { randomUUID } from 'node:crypto';
import {
  invoiceSchema,
  type Extraction,
  type ExtractionMode,
  type Order,
  value,
} from '../shared/schema.ts';
import { DomainError, hash } from './ledger.ts';
import { DEFAULT_NEAR_AI_MODEL, invoiceRequest } from '../shared/inference.ts';

export function sampleDocument(o: Order) {
  return `FICTITIOUS INVOICE — FOR TESTING ONLY\nSupplier: ${o.supplierName}\nOrder: ${o.id}\nInvoice reference: INV-${o.id}-01\nLine: ${o.lineId}\nItem: ${o.description}\nQuantity: ${o.ordered}\nToken: aUSD\nAmount in six-decimal base units: ${value(o.ordered, o.unitPrice)}\n`;
}
export async function extract(o: Order, text: string, mode: ExtractionMode): Promise<Extraction> {
  if (!text.trim() || Buffer.byteLength(text) > 32_768)
    throw new DomainError('Invoice text must contain 1–32768 bytes.', 400);
  let model: string | null = null,
    providerRequestId: string | null = null,
    raw: unknown;
  if (mode === 'sample') {
    if (text !== sampleDocument(o))
      throw new DomainError(
        'Sample mode only processes the exact generated fictitious invoice. Use live mode for another document.',
        400,
      );
    raw = {
      orderId: o.id,
      reference: `INV-${o.id}-01`,
      lineId: o.lineId,
      quantity: o.ordered,
      token: 'aUSD',
      amountBaseUnits: value(o.ordered, o.unitPrice),
    };
  } else {
    const apiKey = process.env.NEAR_AI_API_KEY;
    if (!apiKey)
      throw new DomainError(
        'Invoice processing is temporarily unavailable. Your order has not changed.',
        503,
      );
    model = process.env.NEAR_AI_MODEL || DEFAULT_NEAR_AI_MODEL;
    let response: Response;
    try {
      response = await fetch('https://cloud-api.near.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify(invoiceRequest(text, model, o.token)),
      });
    } catch {
      throw new DomainError(
        'NEAR AI request failed or timed out. Invoice remains in review. No fallback was used.',
        502,
      );
    }
    if (!response.ok)
      throw new DomainError(
        `NEAR AI returned HTTP ${response.status}. Invoice remains in review.`,
        502,
      );
    providerRequestId = response.headers.get('x-request-id');
    try {
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      raw = JSON.parse(body.choices?.[0]?.message?.content ?? '');
    } catch {
      throw new DomainError('NEAR AI returned invalid JSON. Invoice remains in review.', 422);
    }
  }
  const parsed = invoiceSchema.safeParse(raw);
  if (!parsed.success)
    throw new DomainError(
      'Extracted fields failed the invoice schema. Invoice remains in review.',
      422,
    );
  const invoice = parsed.data;
  if (
    invoice.orderId !== o.id ||
    invoice.token !== o.token ||
    invoice.quantity > o.ordered ||
    invoice.lineId !== o.lineId ||
    invoice.amountBaseUnits !== value(invoice.quantity, o.unitPrice)
  )
    throw new DomainError(
      'Invoice does not match the order, line, or fixed unit price. Review is required.',
      422,
    );
  return {
    id: randomUUID(),
    orderId: o.id,
    mode,
    invoice,
    documentHash: hash(text),
    model,
    recordedAt: new Date().toISOString(),
    providerRequestId,
  };
}
