import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  available,
  value,
  type Snapshot,
  type Order,
  type Role,
  type CreateOrder,
  type Extraction,
} from '../shared/schema.ts';

export class DomainError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export const hash = (input: string) => createHash('sha256').update(input).digest('hex');
export const empty = (): Snapshot => ({
  orders: [],
  attempts: [],
  events: [],
  extractions: [],
  simulatedSupplierBalances: {},
});
const now = () => new Date().toISOString();
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError(message);
}
function roleIs(role: Role, expected: Role) {
  if (role !== expected)
    throw new DomainError(`Only the ${expected} can perform this action.`, 403);
}
export function append(
  s: Snapshot,
  orderId: string,
  role: Role | 'system',
  kind: string,
  message: string,
) {
  s.events.unshift({ id: randomUUID(), orderId, at: now(), role, kind, message });
}
export function find(s: Snapshot, id: string) {
  const o = s.orders.find((o) => o.id === id);
  if (!o) throw new DomainError('Order not found.', 404);
  return o;
}
function active(o: Order) {
  assert(
    o.acceptedTerms && BigInt(o.funded) > 0n,
    'Supplier acceptance and full funding are required.',
  );
}
export function create(s: Snapshot, input: CreateOrder, role: Role) {
  roleIs(role, 'buyer');
  assert(
    new Set(['buyer.testnet', input.supplier, input.receiver, input.operator]).size === 4,
    'Buyer, supplier, receiver and operator must be separate accounts.',
  );
  assert(input.payout !== 'vault.testnet', 'Payout cannot be the vault.');
  assert(
    BigInt(value(input.ordered, input.unitPrice)) <= (1n << 128n) - 1n,
    'Order budget exceeds u128.',
  );
  const id = `PO-${String(s.orders.length + 1).padStart(4, '0')}`;
  const termsHash = hash(
    JSON.stringify([
      'local-simulation',
      'vault.testnet',
      id,
      1,
      'buyer.testnet',
      'test-token.testnet',
      input,
    ]),
  );
  const o: Order = {
    ...input,
    id,
    buyer: 'buyer.testnet',
    lineId: 'line-1',
    token: 'aUSD',
    termsHash,
    acceptedTerms: false,
    funded: '0',
    accepted: 0,
    paid: 0,
    pending: 0,
    sequence: 0,
    createdAt: now(),
  };
  s.orders.unshift(o);
  append(s, id, role, 'order_created', 'Purchase order created. Supplier acceptance is next.');
  return o;
}
export function accept(s: Snapshot, id: string, role: Role, termsHash: string) {
  roleIs(role, 'supplier');
  const o = find(s, id);
  assert(!o.acceptedTerms, 'Terms are already accepted.');
  assert(o.termsHash === termsHash, 'Terms have changed. Review them again.');
  o.acceptedTerms = true;
  append(s, id, role, 'terms_accepted', 'Supplier accepted the fixed terms and payout account.');
}
export function fund(s: Snapshot, id: string, role: Role, amount: string) {
  roleIs(role, 'buyer');
  const o = find(s, id);
  assert(o.acceptedTerms, 'Supplier must accept first.');
  assert(o.funded === '0', 'Order is already funded.');
  assert(amount === value(o.ordered, o.unitPrice), 'Funding must match the exact order budget.');
  o.funded = amount;
  append(s, id, role, 'order_funded', 'Full budget credited to the simulated order ledger.');
}
export function deliver(s: Snapshot, id: string, role: Role, sequence: number, total: number) {
  roleIs(role, 'receiver');
  const o = find(s, id);
  active(o);
  assert(sequence === o.sequence + 1, 'Stale or skipped receipt sequence. Refresh the order.');
  assert(
    Number.isSafeInteger(total) && total > o.accepted && total <= o.ordered,
    'Enter a cumulative quantity greater than the last receipt and no greater than the order.',
  );
  const delta = total - o.accepted;
  o.sequence = sequence;
  o.accepted = total;
  append(
    s,
    id,
    role,
    'delivery_confirmed',
    `${delta} cartons accepted. Cumulative delivery: ${total} of ${o.ordered}.`,
  );
}
export function reserve(
  s: Snapshot,
  id: string,
  role: Role,
  requestId: string,
  quantity: number,
  invoiceHash: string,
) {
  roleIs(role, 'operator');
  const o = find(s, id);
  active(o);
  assert(
    !s.attempts.some((a) => a.id === requestId),
    'This request ID already exists. Read its outcome before retrying.',
  );
  assert(s.attempts.filter((a) => a.orderId === id).length < 64, 'Order attempt limit reached.');
  assert(
    Number.isSafeInteger(quantity) && quantity > 0 && quantity <= available(o),
    'Requested quantity exceeds accepted, unpaid, unreserved entitlement.',
  );
  assert(/^[a-f0-9]{64}$/.test(invoiceHash), 'An invoice SHA-256 audit reference is required.');
  const a = {
    id: requestId,
    orderId: id,
    quantity,
    amount: value(quantity, o.unitPrice),
    recipient: o.payout,
    invoiceHash,
    status: 'reserved' as const,
    createdAt: now(),
    updatedAt: now(),
    transferApplied: false,
  };
  o.pending += quantity;
  s.attempts.unshift(a);
  append(
    s,
    id,
    role,
    'payment_reserved',
    `${quantity} cartons reserved for payment to ${o.payout}.`,
  );
  return a;
}
export function finalize(s: Snapshot, id: string, outcome: 'success' | 'failure' | 'starved') {
  const a = s.attempts.find((a) => a.id === id);
  if (!a) throw new DomainError('Attempt not found.', 404);
  if (a.status === 'settled' || a.status === 'failed' || a.status === 'unresolved') return;
  const o = find(s, a.orderId);
  if (outcome !== 'failure' && !a.transferApplied) {
    s.simulatedSupplierBalances[a.recipient] = (
      BigInt(s.simulatedSupplierBalances[a.recipient] ?? '0') + BigInt(a.amount)
    ).toString();
    a.transferApplied = true;
  }
  a.updatedAt = now();
  if (outcome === 'starved') {
    a.status = 'unresolved';
    append(
      s,
      o.id,
      'system',
      'needs_reconciliation',
      'Simulated transfer applied; callback failed. Reservation remains locked.',
    );
    return;
  }
  o.pending -= a.quantity;
  if (outcome === 'success') {
    o.paid += a.quantity;
    a.status = 'settled';
    append(
      s,
      o.id,
      'system',
      'payment_settled',
      'Simulated transfer and callback completed. Reservation moved to paid.',
    );
  } else {
    a.status = 'failed';
    append(
      s,
      o.id,
      'system',
      'transfer_failed',
      'Simulated token transfer failed. Callback released the reservation.',
    );
  }
}

export class Ledger {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL);',
    );
    this.db
      .prepare('INSERT OR IGNORE INTO ledger (id,state) VALUES (1,?)')
      .run(JSON.stringify(empty()));
  }
  read(): Snapshot {
    return JSON.parse(
      (this.db.prepare('SELECT state FROM ledger WHERE id=1').get() as { state: string }).state,
    );
  }
  write<T>(fn: (s: Snapshot) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read();
      const result = fn(state);
      for (const o of state.orders)
        assert(
          o.paid >= 0 &&
            o.pending >= 0 &&
            o.paid + o.pending <= o.accepted &&
            o.accepted <= o.ordered,
          'Ledger invariant failed.',
        );
      this.db.prepare('UPDATE ledger SET state=? WHERE id=1').run(JSON.stringify(state));
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}

export function addExtraction(s: Snapshot, extraction: Extraction) {
  s.extractions.unshift(extraction);
  append(
    s,
    extraction.orderId,
    'operator',
    'invoice_extracted',
    `Invoice parsed in ${extraction.mode === 'sample' ? 'synthetic sample' : 'live NEAR AI'} mode. Not supplier-confirmed.`,
  );
}
