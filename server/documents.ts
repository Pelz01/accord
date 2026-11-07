import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DomainError } from './ledger.ts';
import type { SavedInvoice } from '../shared/invoices.ts';

export const MAX_DOCUMENT = 2 * 1024 * 1024;
const RETENTION = 7 * 86400000;
export const uploadSchema = z.strictObject({
  name: z.string().min(1).max(128),
  mediaType: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
  bytesBase64: z
    .string()
    .min(4)
    .max(Math.ceil(MAX_DOCUMENT / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
const parsedSchema = z.strictObject({
  text: z.string().min(20).max(32768),
  pages: z.number().int().min(1).max(5),
  source: z.enum(['pdf-text', 'ocr']),
  mediaType: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
  previewBase64: z.string().max(3_000_000),
  previewType: z.enum(['image/png', 'image/jpeg']),
});
export type ParsedDocument = z.infer<typeof parsedSchema>;
export type StoredDocument = ParsedDocument & {
  id: string;
  name: string;
  documentHash: string;
  expiresAt: string;
};
type Scope = { network: string; vault: string; orderId: string };
type Parser = (bytes: Buffer) => Promise<ParsedDocument>;

export async function parseUpload(bytes: Buffer): Promise<ParsedDocument> {
  const url = new URL(process.env.ACCORD_DOCUMENT_URL || 'http://127.0.0.1:3003');
  if (
    url.protocol !== 'http:' ||
    !['documents', '127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new DomainError('Document processing is unavailable.', 503);
  let response: Response;
  try {
    response = await fetch(new URL('/parse', url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
  } catch {
    throw new DomainError(
      'Document processing is temporarily unavailable. Please try again shortly.',
      503,
    );
  }
  const result = await response.json();
  if (!response.ok)
    throw new DomainError(
      typeof result.error === 'string' ? result.error : 'This document could not be read.',
      response.status === 503 ? 503 : 422,
    );
  return parsedSchema.parse(result);
}

export class InvoiceFiles {
  constructor(
    private db: DatabaseSync,
    private parser: Parser = parseUpload,
    private clock = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS chain_documents(id TEXT PRIMARY KEY,network TEXT NOT NULL,vault TEXT NOT NULL,order_id TEXT NOT NULL,created INTEGER NOT NULL,byte_count INTEGER NOT NULL,bytes BLOB NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chain_documents_order ON chain_documents(network,vault,order_id,created);
      CREATE TABLE IF NOT EXISTS chain_invoice_reviews(id TEXT PRIMARY KEY,network TEXT NOT NULL,vault TEXT NOT NULL,order_id TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chain_invoice_reviews_order ON chain_invoice_reviews(network,vault,order_id,created);`);
  }
  private cleanup() {
    this.db.prepare('DELETE FROM chain_documents WHERE created<?').run(this.clock() - RETENTION);
  }
  private checkCapacity(scope: Scope) {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM chain_documents WHERE network=? AND vault=? AND order_id=?',
      )
      .get(scope.network, scope.vault, scope.orderId) as { count: number };
    const total = this.db
      .prepare('SELECT COALESCE(SUM(byte_count+length(payload)),0) AS size FROM chain_documents')
      .get() as { size: number };
    if (row.count >= 20 || total.size > 200 * 1024 * 1024 - 6 * 1024 * 1024)
      throw new DomainError(
        'Document storage is full. Please try again after older files expire.',
        429,
      );
  }
  async upload(scope: Scope, input: unknown) {
    const body = uploadSchema.parse(input);
    const bytes = Buffer.from(body.bytesBase64, 'base64');
    if (
      !bytes.length ||
      bytes.length > MAX_DOCUMENT ||
      bytes.toString('base64') !== body.bytesBase64
    )
      throw new DomainError('Upload a valid file no larger than 2 MB.', 400);
    this.cleanup();
    this.checkCapacity(scope);
    const parsed = parsedSchema.parse(await this.parser(bytes));
    if (parsed.mediaType !== body.mediaType)
      throw new DomainError('The file content does not match its type.', 400);
    if (Buffer.byteLength(parsed.text) > 32768)
      throw new DomainError('The document contains too much text.', 422);
    const document: StoredDocument = {
      ...parsed,
      id: randomUUID(),
      name: body.name.replace(/[\\/]/g, '_'),
      documentHash: createHash('sha256').update(bytes).digest('hex'),
      expiresAt: new Date(this.clock() + RETENTION).toISOString(),
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.checkCapacity(scope);
      this.db
        .prepare('INSERT INTO chain_documents VALUES(?,?,?,?,?,?,?,?)')
        .run(
          document.id,
          scope.network,
          scope.vault,
          scope.orderId,
          this.clock(),
          bytes.length,
          bytes,
          JSON.stringify(document),
        );
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return document;
  }
  document(scope: Scope, id: string, download = false) {
    this.cleanup();
    const row = this.db
      .prepare(
        'SELECT payload,bytes FROM chain_documents WHERE id=? AND network=? AND vault=? AND order_id=?',
      )
      .get(id, scope.network, scope.vault, scope.orderId) as
      | { payload: string; bytes: Uint8Array }
      | undefined;
    if (!row)
      throw new DomainError(
        'This document is unavailable or its seven-day access period expired.',
        404,
      );
    const document = JSON.parse(row.payload) as StoredDocument;
    return {
      ...document,
      ...(download
        ? { previewBase64: '', bytesBase64: Buffer.from(row.bytes).toString('base64') }
        : {}),
    };
  }
  list(scope: Scope) {
    return (
      this.db
        .prepare(
          'SELECT payload FROM chain_invoice_reviews WHERE network=? AND vault=? AND order_id=? ORDER BY created DESC LIMIT 64',
        )
        .all(scope.network, scope.vault, scope.orderId) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as SavedInvoice);
  }
  checkInvoiceCapacity(scope: Scope) {
    if (this.list(scope).length >= 64)
      throw new DomainError('This order has reached its invoice review limit.', 429);
  }
  save(scope: Scope, record: SavedInvoice) {
    this.checkInvoiceCapacity(scope);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO chain_invoice_reviews VALUES(?,?,?,?,?,?)')
        .run(
          record.id,
          scope.network,
          scope.vault,
          scope.orderId,
          this.clock(),
          JSON.stringify(record),
        );
      this.db.exec(
        'DELETE FROM chain_invoice_reviews WHERE id IN (SELECT id FROM chain_invoice_reviews ORDER BY created DESC LIMIT -1 OFFSET 4000)',
      );
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return record;
  }
}
