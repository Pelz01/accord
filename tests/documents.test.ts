import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { InvoiceFiles, type ParsedDocument } from '../server/documents.ts';
import { documentType } from '../server/document-worker.mjs';

const scope = { network: 'testnet', vault: 'vault.testnet', orderId: 'PO-001' };
const bytes = Buffer.from('%PDF-1.7\nsynthetic storage fixture');
const input = {
  name: 'invoice.pdf',
  mediaType: 'application/pdf',
  bytesBase64: bytes.toString('base64'),
};
const parsed: ParsedDocument = {
  text: 'Purchase order PO-001. 100 cartons at 10 aUSD.',
  pages: 1,
  source: 'pdf-text',
  mediaType: 'application/pdf',
  previewBase64: 'AA==',
  previewType: 'image/jpeg',
};

test('document records bind original bytes, scope and retention independently of OCR text', async () => {
  const db = new DatabaseSync(':memory:');
  let time = 1794040000000;
  try {
    const store = new InvoiceFiles(
      db,
      async () => parsed,
      () => time,
    );
    const doc = await store.upload(scope, input);
    assert.equal(doc.documentHash, createHash('sha256').update(bytes).digest('hex'));
    assert.notEqual(doc.documentHash, createHash('sha256').update(parsed.text).digest('hex'));
    const download = store.document(scope, doc.id, true);
    assert.equal(download.bytesBase64, input.bytesBase64);
    assert.equal(download.previewBase64, '');
    for (const other of [
      { ...scope, orderId: 'OTHER' },
      { ...scope, vault: 'other.testnet' },
      { ...scope, network: 'mainnet' },
    ])
      assert.throws(() => store.document(other, doc.id), /unavailable/);
    time += 7 * 86400000 + 1;
    assert.throws(() => store.document(scope, doc.id), /expired/);
  } finally {
    db.close();
  }
});

test('invalid and over-limit uploads are rejected before document processing', async () => {
  const db = new DatabaseSync(':memory:');
  let calls = 0;
  try {
    const store = new InvoiceFiles(db, async () => {
      calls++;
      return parsed;
    });
    await assert.rejects(() => store.upload(scope, { ...input, bytesBase64: '@@@@' }));
    await assert.rejects(() => store.upload(scope, { ...input, bytesBase64: 'AAAAA' }));
    assert.equal(calls, 0);
    for (let i = 0; i < 20; i++) await store.upload(scope, input);
    await assert.rejects(() => store.upload(scope, input), /storage is full/);
    assert.equal(calls, 20);
  } finally {
    db.close();
  }
});

test('document type is derived from content and oversized image dimensions are blocked', () => {
  assert.equal(documentType(bytes), 'application/pdf');
  assert.throws(() => documentType(Buffer.from('<html>invoice</html>')), /Upload a PDF/);
  const bomb = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bomb);
  bomb.writeUInt32BE(100000, 16);
  bomb.writeUInt32BE(100000, 20);
  assert.throws(() => documentType(bomb), /dimensions/);
});
