import { Badge, Token, Metric } from './components/primitives';
import { ModalShell } from './components/ModalShell';
import { CreateForm } from './components/CreateOrderForm';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  Layers2,
  Loader2,
  LockKeyhole,
  PackageCheck,
  Plus,
  Search,
  ShieldCheck,
  Wallet,
  X,
  TriangleAlert,
  Activity,
  Copy,
  ExternalLink,
} from 'lucide-react';
import {
  available,
  money,
  value,
  type Order,
  type Role,
  type Bootstrap,
  type Extraction,
  type ExtractionMode,
} from '../shared/schema';

type View = 'orders' | 'payments' | 'evidence';
type Modal = 'create' | 'accept' | 'fund' | 'delivery' | 'invoice' | 'payment' | null;
const roles: Role[] = ['buyer', 'supplier', 'receiver', 'operator'];
const labels: Record<Role, string> = {
  buyer: 'Buyer',
  supplier: 'Supplier',
  receiver: 'Receiver',
  operator: 'AI operator',
};
const currency = (v: string) => `${money(v)} aUSD`;
function status(o: Order) {
  return !o.acceptedTerms
    ? 'Awaiting acceptance'
    : o.funded === '0'
      ? 'Awaiting funding'
      : o.paid === o.ordered
        ? 'Fulfilled'
        : o.pending
          ? 'Payment in progress'
          : o.accepted > o.paid
            ? 'Ready to pay'
            : 'Awaiting delivery';
}
function statusClass(o: Order) {
  return o.pending
    ? 'amber'
    : o.paid === o.ordered
      ? 'neutral'
      : o.accepted > o.paid
        ? 'green'
        : 'neutral';
}
export function App() {
  const [data, setData] = useState<Bootstrap | null>(null),
    [error, setError] = useState(''),
    [role, setRole] = useState<Role>('buyer');
  const [view, setView] = useState<View>('orders'),
    [selected, setSelected] = useState<string | null>(null),
    [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all');
  const [tab, setTab] = useState<'overview' | 'invoices' | 'activity'>('overview'),
    [extraction, setExtraction] = useState<Extraction | null>(null);
  const [mode, setMode] = useState<ExtractionMode>('sample'),
    [invoiceText, setInvoiceText] = useState(''),
    [quantity, setQuantity] = useState(0),
    [probe, setProbe] = useState<{ blocked: boolean; reason: string; proof: string } | null>(null);
  const requestId = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('Workspace could not be loaded.');
    setData(await res.json());
  }, []);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const id = setInterval(() => refresh().catch(() => {}), 2000);
    return () => clearInterval(id);
  }, [refresh]);
  const order = data?.orders.find((o) => o.id === selected);
  const post = async (path: string, body: unknown = {}) => {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-demo-role': role },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Action failed.');
    return result;
  };
  const act = async (fn: () => Promise<unknown>, success?: string, close = true) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      if (close) setModal(null);
      if (success) setNotice(success);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(id);
  }, [notice]);
  function openOrder(o: Order) {
    setSelected(o.id);
    setTab('overview');
    setExtraction(null);
    setProbe(null);
  }
  function openModal(next: Modal) {
    setError('');
    setModal(next);
    if (order) {
      setQuantity(
        next === 'delivery' ? Math.min(order.ordered, order.accepted + 30) : available(order),
      );
      if (next === 'payment') requestId.current = crypto.randomUUID();
    }
  }
  async function loadSample() {
    if (!order) return;
    const res = await fetch(`/api/orders/${order.id}/sample`);
    if (!res.ok) throw new Error('Sample invoice could not be loaded.');
    setInvoiceText((await res.json()).text);
  }
  async function openInvoice() {
    setExtraction(null);
    setMode('sample');
    openModal('invoice');
    try {
      await loadSample();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const totals = data?.orders.reduce(
    (t, o) => ({
      funded: t.funded + BigInt(o.funded),
      paid: t.paid + BigInt(value(o.paid, o.unitPrice)),
      eligible: t.eligible + BigInt(value(available(o), o.unitPrice)),
      pending: t.pending + BigInt(value(o.pending, o.unitPrice)),
    }),
    { funded: 0n, paid: 0n, eligible: 0n, pending: 0n },
  );
  const title =
    view === 'orders'
      ? 'Purchase orders'
      : view === 'payments'
        ? 'Payments'
        : 'Evidence & controls';
  const orderExtractions = data?.extractions.filter((e) => e.orderId === selected) ?? [];
  const latestExtraction = extraction ?? orderExtractions[0];
  const orderAttempts = data?.attempts.filter((a) => a.orderId === selected) ?? [];
  const canPay = role === 'operator' && order && available(order) > 0;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="wordmark" href="/" aria-label="Accord home">
          <span className="brand-symbol">
            <i />
            <i />
          </span>
          accord<span className="wordmark-period">.</span>
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">P</span>
          <div>
            Pelz’s workspace<small>Procurement</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          <button
            aria-label="Purchase orders"
            className={view === 'orders' ? 'nav-item active' : 'nav-item'}
            onClick={() => {
              setView('orders');
              setSelected(null);
            }}
          >
            <Layers2 size={18} />
            <span className="nav-long">Purchase orders</span>
            <span className="nav-short">Orders</span>
            <span className="nav-count">{data?.orders.length ?? '—'}</span>
          </button>
          <button
            className={view === 'payments' ? 'nav-item active' : 'nav-item'}
            onClick={() => {
              setView('payments');
              setSelected(null);
            }}
          >
            <ArrowUpRight size={18} />
            Payments
          </button>
          <button
            aria-label="Evidence & controls"
            className={view === 'evidence' ? 'nav-item active' : 'nav-item'}
            onClick={() => {
              setView('evidence');
              setSelected(null);
            }}
          >
            <ShieldCheck size={18} />
            <span className="nav-long">Evidence & controls</span>
            <span className="nav-short">Controls</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="network-note">
            <span className="connection-dot" />
            Local simulation<small>Test tokens. No onchain transfers.</small>
            <a className="switch-network" href="/workspace?network=testnet">
              Open NEAR testnet
              <ArrowUpRight size={12} />
            </a>
          </div>
          <a
            className="help-link"
            href="https://github.com/Pelz01/accord"
            target="_blank"
            rel="noreferrer"
          >
            <CircleHelp size={17} />
            Project & documentation
            <ArrowUpRight size={14} />
          </a>
          <div className="profile">
            <span className="profile-avatar">P</span>
            <div>
              Pelz<small>Workspace owner</small>
            </div>
            <span className="profile-status" />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            Workspace
            <ChevronRight size={13} />
            <button onClick={() => setSelected(null)}>{title}</button>
            {order && (
              <>
                <ChevronRight size={13} />
                <span>{order.id}</span>
              </>
            )}
          </div>
          <div className="demo-role">
            <span>Demo actor</span>
            <select
              aria-label="Demo actor"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {labels[r]}
                </option>
              ))}
            </select>
            <span className="mini-avatar">{role[0].toUpperCase()}</span>
          </div>
        </header>
        <div className="environment-strip">
          <span>
            <span className="connection-dot" />
            DEVELOPMENT PREVIEW
          </span>
          <p>Local ledger · synthetic invoice sample · testnet contract not deployed</p>
          <a href="https://github.com/Pelz01/accord" target="_blank" rel="noreferrer">
            View source
            <ArrowUpRight size={12} />
          </a>
        </div>
        <main>
          {error && !modal && (
            <div className="alert error" role="alert">
              <TriangleAlert size={17} />
              {error}
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {!data ? (
            <div className="loading">
              <Loader2 className="spin" />
              Loading your workspace…
            </div>
          ) : order ? (
            <>
              <button className="back-link" onClick={() => setSelected(null)}>
                ← All purchase orders
              </button>
              <div className="page-heading detail-heading">
                <div>
                  <div className="eyebrow">
                    {order.id} <span> / </span> PURCHASE ORDER
                  </div>
                  <h1>{order.supplierName}</h1>
                  <p>
                    {order.description} <span className="middle-dot">·</span> Created{' '}
                    {new Date(order.createdAt).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </p>
                </div>
                <Badge tone={statusClass(order)}>{status(order)}</Badge>
              </div>
              <div className="order-journey">
                {[
                  { label: 'Terms accepted', done: order.acceptedTerms, icon: CheckCheck },
                  { label: 'Budget funded', done: order.funded !== '0', icon: Wallet },
                  { label: 'Delivery accepted', done: order.accepted > 0, icon: PackageCheck },
                  { label: 'Supplier paid', done: order.paid > 0, icon: ArrowUpRight },
                ].map((s, i) => (
                  <div key={s.label} className={s.done ? 'journey-step done' : 'journey-step'}>
                    <span>{s.done ? <Check size={14} /> : <s.icon size={14} />}</span>
                    <div>
                      {s.label}
                      <small>
                        {i === 2
                          ? `${order.accepted} of ${order.ordered} cartons`
                          : i === 3
                            ? `${money(value(order.paid, order.unitPrice))} aUSD settled`
                            : s.done
                              ? 'Complete'
                              : 'Pending'}
                      </small>
                    </div>
                    {i < 3 && <div className="journey-line" />}
                  </div>
                ))}
              </div>
              <div className="tabs" role="tablist" aria-label="Order sections">
                {(['overview', 'invoices', 'activity'] as const).map((t) => (
                  <button
                    role="tab"
                    aria-selected={tab === t}
                    className={tab === t ? 'selected' : ''}
                    key={t}
                    onClick={() => setTab(t)}
                  >
                    {t === 'overview' ? 'Overview' : t === 'invoices' ? 'Invoices' : 'Activity'}
                    {t === 'invoices' && <span>{orderExtractions.length}</span>}
                  </button>
                ))}
              </div>
              {tab === 'overview' ? (
                <div className="detail-grid">
                  <div className="detail-main">
                    <section className="line-section">
                      <div className="section-heading">
                        <h2>Order breakdown</h2>
                        <span>Fixed price · aUSD</span>
                      </div>
                      <div className="table-scroll">
                        <table className="line-table">
                          <thead>
                            <tr>
                              <th>Item</th>
                              <th>Ordered</th>
                              <th>Accepted</th>
                              <th>Paid</th>
                              <th>Pending</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td>
                                <div className="item-name">
                                  <span className="item-icon">
                                    <PackageCheck size={20} />
                                  </span>
                                  <div>
                                    {order.description}
                                    <small>{currency(order.unitPrice)} / carton</small>
                                  </div>
                                </div>
                              </td>
                              <td>{order.ordered}</td>
                              <td>{order.accepted}</td>
                              <td>{order.paid}</td>
                              <td>{order.pending}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      <div className="order-total">
                        <span>Approved order value</span>
                        <strong>{currency(value(order.ordered, order.unitPrice))}</strong>
                      </div>
                    </section>
                    <section className="eligibility-section">
                      <div className="section-heading">
                        <h2>What can be paid now?</h2>
                        <ShieldCheck size={18} />
                      </div>
                      <div className="eligibility-math">
                        <div>
                          <strong>{order.accepted}</strong>
                          <span>Accepted</span>
                        </div>
                        <span>−</span>
                        <div>
                          <strong>{order.paid}</strong>
                          <span>Paid</span>
                        </div>
                        <span>−</span>
                        <div>
                          <strong>{order.pending}</strong>
                          <span>Pending</span>
                        </div>
                        <span>=</span>
                        <div className="math-result">
                          <strong>{available(order)}</strong>
                          <span>Eligible cartons</span>
                        </div>
                      </div>
                      <p>
                        The agent can request up to{' '}
                        <strong>{currency(value(available(order), order.unitPrice))}</strong>. The
                        contract derives the amount and uses the accepted payout account.
                      </p>
                    </section>
                    <section className="ledger-section">
                      <div className="section-heading">
                        <h2>Payment ledger</h2>
                        <span>{orderAttempts.length} attempts</span>
                      </div>
                      {orderAttempts.length ? (
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>Request</th>
                                <th>Quantity</th>
                                <th>Amount</th>
                                <th>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {orderAttempts.map((a) => (
                                <tr key={a.id}>
                                  <td>
                                    <span className="request-id">{a.id.slice(0, 8)}</span>
                                    <small className="block muted">{a.recipient}</small>
                                  </td>
                                  <td>{a.quantity}</td>
                                  <td>
                                    {money(a.amount)}
                                    <small className="inline-unit"> aUSD</small>
                                  </td>
                                  <td>
                                    <Badge
                                      tone={
                                        a.status === 'settled'
                                          ? 'green'
                                          : a.status === 'failed'
                                            ? 'red'
                                            : 'amber'
                                      }
                                    >
                                      {a.status === 'unresolved'
                                        ? 'Needs reconciliation'
                                        : a.status}
                                    </Badge>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="empty-inline">
                          <ArrowDownLeft size={23} />
                          <div>
                            No payments yet
                            <small>Each request and its outcome will appear here.</small>
                          </div>
                        </div>
                      )}
                    </section>
                  </div>
                  <aside className="order-aside">
                    <div className="next-action">
                      <span className="eyebrow">NEXT STEP</span>
                      <h2>
                        {!order.acceptedTerms
                          ? 'Agree on the terms'
                          : order.funded === '0'
                            ? 'Commit the budget'
                            : available(order) > 0
                              ? 'Pay for what arrived'
                              : order.pending
                                ? 'Payment is processing'
                                : order.paid === order.ordered
                                  ? 'Order fulfilled'
                                  : 'Confirm the next delivery'}
                      </h2>
                      <p>
                        {!order.acceptedTerms
                          ? 'The supplier reviews the order and accepts its fixed terms.'
                          : order.funded === '0'
                            ? 'Fund the exact approved value after supplier acceptance.'
                            : order.pending
                              ? 'The reservation stays in place until the callback resolves.'
                              : available(order) > 0
                                ? `${available(order)} cartons have been accepted and are available for settlement.`
                                : 'The receiver confirms the cumulative quantity physically received.'}
                      </p>
                      {!order.acceptedTerms ? (
                        <button
                          className="button primary full"
                          disabled={role !== 'supplier'}
                          onClick={() => openModal('accept')}
                        >
                          Review & accept
                          <ArrowRight size={16} />
                        </button>
                      ) : order.funded === '0' ? (
                        <button
                          className="button primary full"
                          disabled={role !== 'buyer'}
                          onClick={() => openModal('fund')}
                        >
                          Fund order
                          <ArrowRight size={16} />
                        </button>
                      ) : available(order) > 0 ? (
                        <button
                          className="button primary full"
                          disabled={!canPay}
                          onClick={openInvoice}
                        >
                          Review invoice
                          <ArrowRight size={16} />
                        </button>
                      ) : order.accepted < order.ordered ? (
                        <button
                          className="button primary full"
                          disabled={role !== 'receiver'}
                          onClick={() => openModal('delivery')}
                        >
                          Confirm delivery
                          <Plus size={16} />
                        </button>
                      ) : null}
                      <small className="role-hint">
                        {!order.acceptedTerms
                          ? 'Supplier'
                          : order.funded === '0'
                            ? 'Buyer'
                            : available(order) > 0
                              ? 'AI operator'
                              : 'Receiver'}{' '}
                        action · demo identities only
                      </small>
                    </div>
                    <div className="terms-summary">
                      <h3>Accepted terms</h3>
                      <dl>
                        <div>
                          <dt>Buyer</dt>
                          <dd>{order.buyer}</dd>
                        </div>
                        <div>
                          <dt>Supplier</dt>
                          <dd>{order.supplier}</dd>
                        </div>
                        <div>
                          <dt>Fixed payout</dt>
                          <dd>
                            <LockKeyhole size={12} />
                            {order.payout}
                          </dd>
                        </div>
                        <div>
                          <dt>Receiver</dt>
                          <dd>{order.receiver}</dd>
                        </div>
                        <div>
                          <dt>Operator</dt>
                          <dd>{order.operator}</dd>
                        </div>
                        <div>
                          <dt>Token</dt>
                          <dd>
                            <Token /> aUSD <span className="muted">· test token</span>
                          </dd>
                        </div>
                      </dl>
                      <button
                        className="copy-hash"
                        onClick={() =>
                          navigator.clipboard
                            .writeText(order.termsHash)
                            .then(() => setNotice('Terms hash copied.'))
                            .catch(() => setError('Clipboard unavailable.'))
                        }
                      >
                        Terms commitment <Copy size={12} />
                        <code>{order.termsHash.slice(0, 18)}…</code>
                      </button>
                    </div>
                    {order.funded !== '0' && order.accepted < order.ordered && (
                      <button
                        className="button secondary full"
                        disabled={role !== 'receiver'}
                        onClick={() => openModal('delivery')}
                      >
                        <PackageCheck size={16} />
                        Record another delivery
                      </button>
                    )}
                    <div className="limit-note">
                      <LockKeyhole size={15} />
                      <p>
                        Prototype. Invoice authenticity is not verified. Closure and refunds are
                        unavailable; unused test funds remain locked.
                      </p>
                    </div>
                  </aside>
                </div>
              ) : tab === 'invoices' ? (
                <section className="panel invoice-list">
                  <div className="section-heading">
                    <div>
                      <h2>Invoice extractions</h2>
                      <p className="muted">
                        Extracted records are audit references, without supplier confirmation.
                      </p>
                    </div>
                    <button
                      className="button primary"
                      disabled={role !== 'operator'}
                      onClick={openInvoice}
                    >
                      <Plus size={16} />
                      Review invoice
                    </button>
                  </div>
                  {orderExtractions.length ? (
                    orderExtractions.map((e) => (
                      <div className="invoice-row" key={e.id}>
                        <FileText size={22} />
                        <div>
                          <strong>{e.invoice.reference}</strong>
                          <small>
                            {e.invoice.quantity} cartons · {currency(e.invoice.amountBaseUnits)}
                          </small>
                        </div>
                        <Badge tone={e.mode === 'live' ? 'green' : 'neutral'}>
                          {e.mode === 'sample' ? 'Synthetic sample' : 'Live NEAR AI'}
                        </Badge>
                      </div>
                    ))
                  ) : (
                    <div className="empty-state compact">
                      <FileText size={26} />
                      <h3>No invoice extractions</h3>
                      <p>
                        Review a fictitious invoice or use live AI with server-side credentials.
                      </p>
                    </div>
                  )}
                </section>
              ) : (
                <section className="activity-section">
                  <h2>Order activity</h2>
                  {data.events
                    .filter((e) => e.orderId === order.id)
                    .map((e) => (
                      <div className="activity-row" key={e.id}>
                        <span className="timeline-marker" />
                        <div>
                          <strong>{e.message}</strong>
                          <small>
                            {e.role === 'system' ? 'System' : labels[e.role]} ·{' '}
                            {new Date(e.at).toLocaleString('en-GB')}
                          </small>
                        </div>
                      </div>
                    ))}
                </section>
              )}
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR PROCUREMENT WORKSPACE</div>
                  <h1>{title}</h1>
                  <p>
                    {view === 'orders'
                      ? 'Clear terms. Accepted deliveries. Payments that stay within bounds.'
                      : view === 'payments'
                        ? 'Every payment request, reservation, and outcome in one place.'
                        : 'Inspect the boundaries behind every supplier payment.'}
                  </p>
                </div>
                {view === 'orders' && (
                  <button className="button primary" onClick={() => openModal('create')}>
                    <Plus size={17} />
                    New purchase order
                  </button>
                )}
              </div>
              {view !== 'evidence' && (
                <div className="metrics">
                  <Metric
                    label="Funded budget"
                    amount={totals!.funded.toString()}
                    caption="Committed to purchase orders"
                    icon={<Wallet size={16} />}
                  />
                  <Metric
                    label="Paid to suppliers"
                    amount={totals!.paid.toString()}
                    caption="Successfully settled"
                    icon={<ArrowUpRight size={16} />}
                  />
                  <Metric
                    label="Eligible to pay"
                    amount={totals!.eligible.toString()}
                    caption="Accepted, unpaid, unreserved"
                    accent
                    icon={<CheckCheck size={16} />}
                  />
                  <Metric
                    label="In progress"
                    amount={totals!.pending.toString()}
                    caption="Reserved pending settlement"
                    icon={<Clock3 size={16} />}
                  />
                </div>
              )}
              {view === 'orders' ? (
                <>
                  <div className="list-toolbar">
                    <div className="list-filters">
                      <button
                        className={filter === 'all' ? 'selected' : ''}
                        onClick={() => setFilter('all')}
                      >
                        All orders <span>{data.orders.length}</span>
                      </button>
                      <button
                        className={filter === 'ready' ? 'selected' : ''}
                        onClick={() => setFilter('ready')}
                      >
                        Ready to pay{' '}
                        <span>{data.orders.filter((o) => available(o) > 0).length}</span>
                      </button>
                      <button
                        className={filter === 'pending' ? 'selected' : ''}
                        onClick={() => setFilter('pending')}
                      >
                        In progress
                      </button>
                    </div>
                    <label className="search">
                      <Search size={15} />
                      <input
                        aria-label="Search orders"
                        placeholder="Search orders…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      <span>/</span>
                    </label>
                  </div>
                  <div className="panel orders-panel">
                    <div className="table-scroll">
                      <table className="orders-table">
                        <thead>
                          <tr>
                            <th>Purchase order</th>
                            <th>Supplier</th>
                            <th>Order value</th>
                            <th>Delivery</th>
                            <th>Status</th>
                            <th>
                              <span className="sr-only">Open</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.orders
                            .filter(
                              (o) =>
                                (filter === 'all' ||
                                  (filter === 'ready' && available(o) > 0) ||
                                  (filter === 'pending' && o.pending > 0)) &&
                                `${o.id} ${o.supplierName}`
                                  .toLowerCase()
                                  .includes(search.toLowerCase()),
                            )
                            .map((o) => (
                              <tr key={o.id} onClick={() => openOrder(o)}>
                                <td>
                                  <button className="order-id" onClick={() => openOrder(o)}>
                                    <span className="document-icon">
                                      <FileText size={18} />
                                    </span>
                                    <span>
                                      {o.id}
                                      <small>
                                        {new Date(o.createdAt).toLocaleDateString('en-GB', {
                                          day: 'numeric',
                                          month: 'short',
                                          year: 'numeric',
                                        })}
                                      </small>
                                    </span>
                                  </button>
                                </td>
                                <td>
                                  <span className="supplier-name">{o.supplierName}</span>
                                  <small className="block muted">{o.description}</small>
                                </td>
                                <td>
                                  <strong className="amount">
                                    {money(value(o.ordered, o.unitPrice))}
                                  </strong>
                                  <small className="inline-unit"> aUSD</small>
                                </td>
                                <td>
                                  <div className="delivery-figure">
                                    {o.accepted}
                                    <span> / {o.ordered} cartons</span>
                                  </div>
                                  <div className="delivery-track">
                                    <span style={{ width: `${(o.accepted / o.ordered) * 100}%` }} />
                                  </div>
                                </td>
                                <td>
                                  <Badge tone={statusClass(o)}>{status(o)}</Badge>
                                </td>
                                <td>
                                  <ChevronRight size={17} className="muted" />
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    {!data.orders.length ? (
                      <div className="empty-state">
                        <div className="empty-art">
                          <FileText size={29} />
                          <span>
                            <Check size={13} />
                          </span>
                        </div>
                        <h2>Good terms start here.</h2>
                        <p>
                          Create a purchase order to connect an approved budget, a supplier, and
                          accepted deliveries.
                        </p>
                        <div className="empty-actions">
                          <button className="button primary" onClick={() => openModal('create')}>
                            <Plus size={16} />
                            Create your first order
                          </button>
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() =>
                              act(async () => {
                                const o = await post('/demo/seed');
                                setSelected(o.id);
                              }, 'Sample order loaded.')
                            }
                          >
                            Explore a sample
                            <ArrowRight size={16} />
                          </button>
                        </div>
                        <small>Fictitious supplier · 100 cartons · 1,000 test tokens</small>
                      </div>
                    ) : !data.orders.some(
                        (o) =>
                          (filter === 'all' ||
                            (filter === 'ready' && available(o) > 0) ||
                            (filter === 'pending' && o.pending > 0)) &&
                          `${o.id} ${o.supplierName}`.toLowerCase().includes(search.toLowerCase()),
                      ) ? (
                      <div className="empty-state compact">
                        <Search size={24} />
                        <h3>No matching orders</h3>
                        <p>Try another search or filter.</p>
                      </div>
                    ) : (
                      <div className="table-footer">
                        {data.orders.length} purchase{' '}
                        {data.orders.length === 1 ? 'order' : 'orders'}
                        <span>
                          <LockKeyhole size={12} />
                          Order terms control every payment
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="workspace-footer">
                    <ShieldCheck size={17} />
                    <p>
                      <strong>AI can request. Your order sets the limit.</strong> Payments are
                      bounded by accepted deliveries, fixed prices, and a fixed supplier.
                    </p>
                    <button onClick={() => setView('evidence')}>
                      Explore the controls
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </>
              ) : view === 'payments' ? (
                <div className="panel">
                  <div className="section-heading padded">
                    <h2>All payment attempts</h2>
                    <Badge>Local simulation</Badge>
                  </div>
                  {data.attempts.length ? (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Order</th>
                            <th>Recipient</th>
                            <th>Quantity</th>
                            <th>Amount</th>
                            <th>Outcome</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.attempts.map((a) => (
                            <tr key={a.id}>
                              <td>
                                <button
                                  className="text-button"
                                  onClick={() => {
                                    const o = data.orders.find((o) => o.id === a.orderId);
                                    if (o) {
                                      setView('orders');
                                      openOrder(o);
                                    }
                                  }}
                                >
                                  {a.orderId}
                                  <ArrowUpRight size={12} />
                                </button>
                              </td>
                              <td>{a.recipient}</td>
                              <td>{a.quantity}</td>
                              <td>{currency(a.amount)}</td>
                              <td>
                                <Badge
                                  tone={
                                    a.status === 'settled'
                                      ? 'green'
                                      : a.status === 'failed'
                                        ? 'red'
                                        : 'amber'
                                  }
                                >
                                  {a.status}
                                </Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="empty-state compact">
                      <ArrowUpRight size={28} />
                      <h2>No payments yet</h2>
                      <p>Accepted deliveries make an order eligible for payment.</p>
                      <button className="button secondary" onClick={() => setView('orders')}>
                        Go to purchase orders
                        <ArrowRight size={15} />
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="evidence-intro">
                    <div className="evidence-icon">
                      <ShieldCheck size={32} />
                    </div>
                    <div>
                      <h2>Bounded authority, visible evidence.</h2>
                      <p>
                        These controls are implemented in the Rust contract and mirrored in the
                        local preview. Deployment and cross-contract evidence remain separate
                        release gates.
                      </p>
                    </div>
                  </div>
                  <div className="control-grid">
                    {[
                      {
                        title: 'Accepted delivery cap',
                        text: 'Paid + pending cannot exceed the quantity accepted by the authorized receiver.',
                        icon: PackageCheck,
                      },
                      {
                        title: 'Fixed payout',
                        text: 'The operator cannot supply a new recipient or rewrite accepted prices.',
                        icon: LockKeyhole,
                      },
                      {
                        title: 'Reserved before dispatch',
                        text: 'In-flight payments consume entitlement before the token call is scheduled.',
                        icon: Clock3,
                      },
                      {
                        title: 'Explicit unresolved state',
                        text: 'A failed callback leaves its reservation locked. No arbitrary release or recovery override.',
                        icon: Activity,
                      },
                    ].map((c) => (
                      <section key={c.title}>
                        <c.icon size={20} />
                        <h3>{c.title}</h3>
                        <p>{c.text}</p>
                      </section>
                    ))}
                  </div>
                  <section className="panel evidence-panel">
                    <div className="section-heading">
                      <h2>Verification status</h2>
                      <Badge tone="amber">Foundation in progress</Badge>
                    </div>
                    <div className="verification-row">
                      <span>Preview settlement</span>
                      <strong>Local SQLite simulation</strong>
                    </div>
                    <div className="verification-row">
                      <span>Network deployment</span>
                      <strong>Not deployed</strong>
                    </div>
                    <div className="verification-row">
                      <span>Live NEAR AI credentials</span>
                      <strong>
                        {data.liveAiAvailable
                          ? 'Configured · call not yet verified'
                          : 'Not configured'}
                      </strong>
                    </div>
                    <div className="verification-row">
                      <span>Recorded live fixture</span>
                      <strong>Not captured · synthetic sample available</strong>
                    </div>
                    <div className="verification-row">
                      <span>Invoice authorization / refunds</span>
                      <strong>P1 / P2 not implemented</strong>
                    </div>
                    <a
                      className="text-button"
                      href="https://github.com/Pelz01/accord"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open repository
                      <ExternalLink size={14} />
                    </a>
                  </section>
                  {data.orders.length > 0 && (
                    <section className="panel evidence-panel">
                      <div className="section-heading">
                        <div>
                          <h2>Try a boundary</h2>
                          <p className="muted">
                            Rollback-only probes against {data.orders[0].id}. No funds move.
                          </p>
                        </div>
                        <Badge>Simulation evidence</Badge>
                      </div>
                      <div className="probe-buttons">
                        {(['excess', 'replay', 'redirection', 'unauthorized'] as const).map(
                          (kind) => (
                            <button
                              className="button secondary"
                              disabled={busy}
                              key={kind}
                              onClick={() =>
                                act(
                                  async () =>
                                    setProbe(
                                      await post('/demo/attack', {
                                        orderId: data.orders[0].id,
                                        kind,
                                      }),
                                    ),
                                  undefined,
                                  false,
                                )
                              }
                            >
                              {kind === 'excess'
                                ? 'Exceed delivery cap'
                                : kind === 'replay'
                                  ? 'Replay a request'
                                  : kind === 'redirection'
                                    ? 'Redirect payment'
                                    : 'Fake a delivery'}
                              <ArrowUpRight size={14} />
                            </button>
                          ),
                        )}
                      </div>
                      {probe && (
                        <div
                          className={`alert ${probe.blocked ? 'success' : 'error'}`}
                          role="status"
                        >
                          {probe.blocked ? <ShieldCheck size={18} /> : <TriangleAlert size={18} />}
                          <div>
                            <strong>
                              {probe.blocked ? 'Request blocked' : 'Unexpected result'}
                            </strong>
                            <p>{probe.reason}</p>
                            <small>Evidence: local simulation, not a testnet transaction.</small>
                          </div>
                        </div>
                      )}
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </main>
        <footer className="app-footer">
          <span>
            Accord <span> / </span> Keep business moving.
          </span>
          <span>
            Built on NEAR <span className="near-mark">N</span>
          </span>
        </footer>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
          <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {modal && (
        <ModalShell
          title={
            modal === 'create'
              ? 'New purchase order'
              : modal === 'accept'
                ? 'Review order terms'
                : modal === 'fund'
                  ? 'Fund purchase order'
                  : modal === 'delivery'
                    ? 'Confirm received goods'
                    : modal === 'invoice'
                      ? 'Review supplier invoice'
                      : 'Request partial payment'
          }
          subtitle={
            modal === 'create'
              ? 'Define the budget and who has authority.'
              : `${order?.id} · ${order?.supplierName}`
          }
          onClose={() => {
            if (!busy) setModal(null);
          }}
          wide={modal === 'invoice'}
          busy={busy}
        >
          {error && (
            <div className="alert error" role="alert">
              <TriangleAlert size={17} />
              {error}
            </div>
          )}
          {modal === 'create' ? (
            <CreateForm
              busy={busy}
              onCreate={(input) =>
                act(async () => {
                  const o = await post('/orders', input);
                  setSelected(o.id);
                }, 'Purchase order created.')
              }
              role={role}
            />
          ) : order && modal === 'accept' ? (
            <>
              <p className="modal-description">
                Accepting fixes the economic terms and payout account. New terms require a new order
                in this prototype.
              </p>
              <div className="review-summary">
                <dl>
                  <div>
                    <dt>Goods</dt>
                    <dd>
                      {order.ordered} × {order.description}
                    </dd>
                  </div>
                  <div>
                    <dt>Unit price</dt>
                    <dd>{currency(order.unitPrice)}</dd>
                  </div>
                  <div>
                    <dt>Approved value</dt>
                    <dd>{currency(value(order.ordered, order.unitPrice))}</dd>
                  </div>
                  <div>
                    <dt>Fixed payout</dt>
                    <dd>{order.payout}</dd>
                  </div>
                  <div>
                    <dt>Receiver</dt>
                    <dd>{order.receiver}</dd>
                  </div>
                </dl>
              </div>
              <p className="field-note">
                Local simulation: this action does not sign a wallet transaction.
              </p>
              <button
                className="button primary full"
                disabled={busy || role !== 'supplier'}
                onClick={() =>
                  act(
                    () => post(`/orders/${order.id}/accept`, { termsHash: order.termsHash }),
                    'Supplier accepted the order terms.',
                  )
                }
              >
                Accept exact terms
                <Check size={16} />
              </button>
            </>
          ) : order && modal === 'fund' ? (
            <>
              <div className="fund-amount">
                <Token />
                <span>
                  {money(value(order.ordered, order.unitPrice))}
                  <small>aUSD · fictitious test token</small>
                </span>
              </div>
              <p className="modal-description">
                Credit the full order value to the local simulation ledger. Partial or excess
                funding is rejected.
              </p>
              <div className="alert warning">
                <LockKeyhole size={17} />
                Closure and refunds are unavailable. Undisbursed test funds remain locked.
              </div>
              <button
                className="button primary full"
                disabled={busy || role !== 'buyer'}
                onClick={() =>
                  act(
                    () =>
                      post(`/orders/${order.id}/fund`, {
                        amount: value(order.ordered, order.unitPrice),
                      }),
                    'Order funded in the local simulation.',
                  )
                }
              >
                Simulate funding
                <ArrowRight size={16} />
              </button>
            </>
          ) : order && modal === 'delivery' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                act(
                  () =>
                    post(`/orders/${order.id}/delivery`, {
                      sequence: order.sequence + 1,
                      total: quantity,
                    }),
                  'Delivery accepted. Entitlement updated.',
                );
              }}
            >
              <p className="modal-description">
                Confirm only goods physically received and accepted. Enter the{' '}
                <strong>total received so far</strong>, including earlier deliveries.
              </p>
              <div className="delivery-context">
                <span>
                  Previously accepted<strong>{order.accepted} cartons</strong>
                </span>
                <span>
                  Ordered<strong>{order.ordered} cartons</strong>
                </span>
              </div>
              <label className="field">
                New cumulative quantity
                <input
                  autoFocus
                  type="number"
                  min={order.accepted + 1}
                  max={order.ordered}
                  required
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                />
              </label>
              <div className="delta-note">
                <Plus size={15} />
                {Math.max(0, quantity - order.accepted)} additional cartons · sequence{' '}
                {order.sequence + 1}
              </div>
              <button className="button primary full" disabled={busy || role !== 'receiver'}>
                Confirm cumulative receipt
                <Check size={16} />
              </button>
            </form>
          ) : order && modal === 'invoice' ? (
            <>
              <div className="extraction-bar">
                <div>
                  <span className="eyebrow">EXTRACTION MODE</span>
                  <select
                    aria-label="Extraction mode"
                    value={mode}
                    onChange={(e) => {
                      setMode(e.target.value as ExtractionMode);
                      setExtraction(null);
                    }}
                  >
                    <option value="sample">Synthetic sample</option>
                    <option value="live">Live NEAR AI</option>
                  </select>
                </div>
                <Badge tone={mode === 'sample' ? 'neutral' : 'green'}>
                  {mode === 'sample' ? 'Not a recorded AI response' : 'Server-side inference'}
                </Badge>
              </div>
              <div className="invoice-review">
                <div className="invoice-document">
                  <div className="document-heading">
                    <FileText size={16} />
                    Source document<span>TEXT</span>
                  </div>
                  <textarea
                    aria-label="Invoice source text"
                    value={invoiceText}
                    readOnly={mode === 'sample'}
                    onChange={(e) => {
                      setInvoiceText(e.target.value);
                      setExtraction(null);
                    }}
                    maxLength={32768}
                  />
                  <p>Text extraction only. Scanned PDF OCR is not implemented.</p>
                </div>
                <div className="extracted-fields">
                  <span className="eyebrow">EXTRACTED FIELDS</span>
                  {extraction ? (
                    <>
                      <h3>{extraction.invoice.reference}</h3>
                      <dl>
                        <div>
                          <dt>Purchase order</dt>
                          <dd>{extraction.invoice.orderId}</dd>
                        </div>
                        <div>
                          <dt>Invoice quantity</dt>
                          <dd>{extraction.invoice.quantity} cartons</dd>
                        </div>
                        <div>
                          <dt>Invoice amount</dt>
                          <dd>{currency(extraction.invoice.amountBaseUnits)}</dd>
                        </div>
                        <div>
                          <dt>Accepted delivery</dt>
                          <dd>{order.accepted} cartons</dd>
                        </div>
                        <div className="eligible-row">
                          <dt>Eligible now</dt>
                          <dd>{available(order)} cartons</dd>
                        </div>
                      </dl>
                      <div className="inline-success">
                        <ShieldCheck size={16} />
                        Order and fixed price match
                      </div>
                      <p className="field-note">
                        Schema validated. Not supplier-confirmed. The contract enforces order
                        entitlement.
                      </p>
                    </>
                  ) : (
                    <div className="extraction-empty">
                      <FileText size={28} />
                      <h3>Ready for review</h3>
                      <p>Extract the invoice to compare its fields with the purchase order.</p>
                    </div>
                  )}
                </div>
              </div>
              <div className="modal-actions">
                <p>
                  {mode === 'sample'
                    ? 'Synthetic sample only. No AI API call.'
                    : 'No silent fallback if live extraction fails.'}
                </p>
                {extraction ? (
                  <button
                    className="button primary"
                    disabled={busy || !canPay}
                    onClick={() => openModal('payment')}
                  >
                    Review partial payment
                    <ArrowRight size={16} />
                  </button>
                ) : (
                  <button
                    className="button primary"
                    disabled={busy || role !== 'operator'}
                    onClick={() =>
                      act(
                        async () =>
                          setExtraction(
                            await post(`/orders/${order.id}/extract`, { text: invoiceText, mode }),
                          ),
                        undefined,
                        false,
                      )
                    }
                  >
                    {busy ? <Loader2 className="spin" size={16} /> : <FileText size={16} />}Extract
                    invoice
                  </button>
                )}
              </div>
            </>
          ) : order && modal === 'payment' ? (
            <>
              <div className="payment-context">
                <Badge tone={latestExtraction?.mode === 'sample' ? 'neutral' : 'green'}>
                  {latestExtraction?.mode === 'sample' ? 'Synthetic extraction' : 'Live extraction'}
                </Badge>
                <p>Pay only the accepted, unpaid portion of this order.</p>
              </div>
              <label className="field">
                Cartons to pay
                <input
                  type="number"
                  min={1}
                  max={Math.min(available(order), latestExtraction?.invoice.quantity ?? 0)}
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                />
              </label>
              <div className="review-summary">
                <dl>
                  <div>
                    <dt>Eligible now</dt>
                    <dd>{available(order)} cartons</dd>
                  </div>
                  <div>
                    <dt>Fixed unit price</dt>
                    <dd>{currency(order.unitPrice)}</dd>
                  </div>
                  <div>
                    <dt>Fixed recipient</dt>
                    <dd>
                      <LockKeyhole size={12} />
                      {order.payout}
                    </dd>
                  </div>
                  <div className="payment-total">
                    <dt>Payment amount</dt>
                    <dd>
                      {Number.isSafeInteger(quantity) && quantity >= 0
                        ? currency(value(quantity, order.unitPrice))
                        : '—'}
                    </dd>
                  </div>
                </dl>
              </div>
              <p className="field-note">
                This starts a simulated transfer. A request is not a successful payment. Follow the
                ledger for its outcome.
              </p>
              <button
                className="button primary full"
                disabled={
                  busy ||
                  !canPay ||
                  !latestExtraction ||
                  quantity < 1 ||
                  quantity > available(order)
                }
                onClick={() =>
                  act(
                    () =>
                      post(`/orders/${order.id}/payments`, {
                        requestId: requestId.current,
                        quantity,
                        extractionId: latestExtraction?.id,
                      }),
                    'Payment reserved. Follow its outcome in the ledger.',
                  )
                }
              >
                Reserve & simulate payment
                <ArrowUpRight size={16} />
              </button>
            </>
          ) : null}
        </ModalShell>
      )}
    </div>
  );
}
