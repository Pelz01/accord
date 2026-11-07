import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JsonRpcProvider } from 'near-api-js';
import { extract } from '../server/extraction.ts';
import { asPreviewOrder } from '../server/chain.ts';
import { DomainError } from '../server/ledger.ts';
import { invoiceSchema, money, value } from '../shared/schema.ts';
import type { Deployment, ChainOrder } from '../shared/chain.ts';

async function main() {
  if (!process.env.NEAR_AI_API_KEY?.trim())
    throw new DomainError(
      'Add NEAR_AI_API_KEY to the ignored .env file before running this check.',
    );
  if (process.argv.includes('--diagnostic')) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      const response = await realFetch(input, options);
      if (String(input) === 'https://cloud-api.near.ai/v1/chat/completions') {
        const body = await response.clone().json();
        const diagnostic = {
          status: response.status,
          model: body.model,
          choices: body.choices?.map(
            (choice: { finish_reason?: string; message?: { content?: unknown } }) => ({
              finishReason: choice.finish_reason,
              content: choice.message?.content,
            }),
          ),
          usage: body.usage,
          requestId: response.headers.get('x-request-id'),
        };
        await mkdir('.data', { recursive: true });
        await writeFile(
          '.data/near-ai-diagnostic.json',
          JSON.stringify(diagnostic, null, 2).replaceAll(
            process.env.NEAR_AI_API_KEY!,
            '[REDACTED]',
          ),
        );
      }
      return response;
    };
  }
  const d = JSON.parse(await readFile('fixtures/testnet-deployment.json', 'utf8')) as Deployment;
  assert.equal(d.network, 'testnet');
  const provider = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
  const readOrder = () =>
    provider.callFunction<ChainOrder>({
      contractId: d.vault,
      method: 'get_order',
      args: { order_id: 'PO-TESTNET-001' },
    });
  const before = await readOrder();
  assert.ok(before, 'The existing testnet verification order must be available.');
  const order = asPreviewOrder(before);
  const text = [
    'Synthetic verification invoice for Accord integration testing.',
    `Supplier: ${order.supplier}`,
    `Purchase order: ${order.id}`,
    'Invoice reference: INV-ACCORD-AI-001',
    `Line: ${order.lineId}`,
    `Item: ${order.description}`,
    `Quantity: ${order.ordered} cartons`,
    `Unit price: ${money(order.unitPrice)} aUSD`,
    'Token: aUSD',
    `Total: ${money(value(order.ordered, order.unitPrice))} aUSD`,
    `Amount in six-decimal base units: ${value(order.ordered, order.unitPrice)}`,
  ].join('\n');
  const started = performance.now();
  const result = await extract(order, text, 'live');
  const durationMs = Math.round(performance.now() - started);
  invoiceSchema.parse(result.invoice);
  assert.equal(result.mode, 'live');
  assert.equal(result.invoice.orderId, order.id);
  assert.equal(result.invoice.lineId, order.lineId);
  assert.equal(result.invoice.reference, 'INV-ACCORD-AI-001');
  assert.equal(result.invoice.quantity, order.ordered);
  assert.equal(result.invoice.amountBaseUnits, value(order.ordered, order.unitPrice));
  assert.equal(result.documentHash, createHash('sha256').update(text).digest('hex'));
  let httpVerification: { status: number; providerRequestId: string | null } | null = null;
  if (process.argv.includes('--http')) {
    const response = await fetch(
      `http://127.0.0.1:3001/api/chain/orders/${encodeURIComponent(order.id)}/extract`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify({ text, mode: 'live' }),
        signal: AbortSignal.timeout(50000),
      },
    );
    assert.equal(response.status, 200, 'The running app must accept the live extraction.');
    const body = await response.json();
    assert.deepEqual(invoiceSchema.parse(body.invoice), result.invoice);
    assert.equal(body.mode, 'live');
    httpVerification = { status: response.status, providerRequestId: body.providerRequestId };
  }
  let incompleteInvoiceRejected = false;
  if (process.argv.includes('--negative')) {
    await assert.rejects(
      extract(
        order,
        'Unclear delivery note. No invoice reference, purchase order, line, quantity, token or amount is specified.',
        'live',
      ),
      (error: unknown) => error instanceof DomainError && error.status === 422,
    );
    incompleteInvoiceRejected = true;
  }
  const after = await readOrder();
  assert.deepEqual(after, before, 'Extraction must leave the order ledger unchanged.');
  const fixture = {
    schemaVersion: 1,
    kind: 'recorded-live-near-ai-extraction',
    input: { synthetic: true, text, sha256: result.documentHash },
    order: {
      id: order.id,
      lineId: order.lineId,
      unitPrice: order.unitPrice,
      ordered: order.ordered,
    },
    provider: {
      endpoint: 'https://cloud-api.near.ai/v1/chat/completions',
      model: result.model,
      requestId: result.providerRequestId,
      recordedAt: result.recordedAt,
      durationMs,
    },
    invoice: result.invoice,
    httpVerification,
    incompleteInvoiceRejected,
    checks: [
      'real provider call',
      'strict invoice schema',
      'order and line match',
      'fixed price matches',
      'input hash matches',
      'testnet ledger unchanged',
    ],
  };
  await writeFile('fixtures/near-ai-extraction.json', JSON.stringify(fixture, null, 2) + '\n');
  console.log(
    JSON.stringify({
      status: 'PASS',
      model: result.model,
      quantity: result.invoice.quantity,
      amountBaseUnits: result.invoice.amountBaseUnits,
      providerRequestId: result.providerRequestId,
      durationMs,
      fixture: 'fixtures/near-ai-extraction.json',
      ledgerUnchanged: true,
    }),
  );
}
main().catch((error: unknown) => {
  console.error(
    error instanceof DomainError
      ? error.message
      : 'Live extraction verification failed. No successful fixture was written.',
  );
  process.exitCode = 1;
});
