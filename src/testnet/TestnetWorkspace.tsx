import './wallet-gate.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  FileText,
  Layers2,
  Loader2,
  LockKeyhole,
  PackageCheck,
  Plus,
  ShieldCheck,
  Wallet,
  X,
} from 'lucide-react';
import {
  type ChainState,
  type ChainOrder,
  type ChainJob,
  chainAvailable,
  ordersForAccount,
} from '../../shared/chain';
import { type CreateOrder, type Extraction, money, createSchema } from '../../shared/schema';
import { Badge, Metric } from '../components/primitives';
import { ModalShell } from '../components/ModalShell';
import { CreateForm } from '../components/CreateOrderForm';
import { walletConnector, accountId, sendCall } from './Wallet';
import { PaymentHistory } from './PaymentHistory';
import { RecoveryPanel } from './RecoveryPanel';
import type { ChainRecovery } from '../../shared/chain';

const explorer = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
function label(o: ChainOrder, recovery?: ChainRecovery) {
  return recovery?.phase === 'Closed'
    ? 'Closed'
    : recovery?.phase === 'RefundPending'
      ? 'Refund pending'
      : recovery?.phase === 'RefundFailed'
        ? 'Refund failed'
        : !o.accepted_terms
          ? 'Awaiting acceptance'
          : o.funded === '0'
            ? 'Awaiting funding'
            : o.pending !== '0'
              ? 'Payment in progress'
              : chainAvailable(o) > 0n
                ? 'Ready to pay'
                : o.paid === o.terms.ordered
                  ? 'Fulfilled'
                  : 'Awaiting delivery';
}

export function TestnetWorkspace() {
  const [state, setState] = useState<ChainState | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [account, setAccount] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null);
  const [modal, setModal] = useState<'create' | 'receipt' | 'invoice' | 'accept' | 'fund' | null>(
      null,
    ),
    [total, setTotal] = useState(''),
    [text, setText] = useState(''),
    [extraction, setExtraction] = useState<Extraction | null>(null),
    [quantity, setQuantity] = useState(''),
    [transaction, setTransaction] = useState('');
  const [jobs, setJobs] = useState<ChainJob[]>([]);
  const session = useRef<{ accountId: string; token: string; expires: number } | null>(null);
  const [view, setView] = useState<'orders' | 'payments'>('orders');
  const refresh = useCallback(async () => {
    if (!account) return;
    const r = await fetch(
      '/api/chain/state' + (account ? '?account=' + encodeURIComponent(account) : ''),
    );
    const body = await r.json();
    if (!r.ok) throw new Error(body.error ?? 'Testnet state is unavailable.');
    setState(body);
    const j = await fetch('/api/chain/jobs');
    if (j.ok) setJobs((await j.json()).jobs);
  }, [account]);
  useEffect(() => {
    session.current = null;
    if (!account) {
      setState(null);
      setSelected(null);
      setView('orders');
      setJobs([]);
      setError('');
      return;
    }
    refresh().catch((e) => setError(e.message));
    const id = setInterval(() => refresh().catch(() => {}), 10000);
    return () => clearInterval(id);
  }, [refresh]);
  useEffect(() => {
    accountId().then(setAccount);
    const c = walletConnector();
    const signIn = ({ accounts }: { accounts: { accountId: string }[] }) =>
      setAccount(accounts[0]?.accountId ?? null);
    const signOut = () => setAccount(null);
    c.on('wallet:signIn', signIn);
    c.on('wallet:signOut', signOut);
    return () => {
      c.off('wallet:signIn', signIn);
      c.off('wallet:signOut', signOut);
    };
  }, []);
  const orders = ordersForAccount(state?.orders ?? [], account);
  const order = orders.find((o) => o.id === selected),
    d = state?.deployment;
  const recovery = order ? state?.recoveries?.[order.id] : undefined;
  const open = !recovery || recovery.phase === 'Open';
  async function run(fn: () => Promise<unknown>, close = true) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      if (close) setModal(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(`/api/chain${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? 'Request failed.');
    return data;
  }
  async function extractInvoice() {
    if (!order || !account) throw new Error('Connect your wallet and open an order first.');
    const headers: Record<string, string> = {};
    if (state?.authRequired) {
      if (
        !session.current ||
        session.current.accountId !== account ||
        session.current.expires <= Date.now()
      ) {
        const challenge = await post('/session/challenge', { accountId: account });
        const signed = await (
          await walletConnector().wallet()
        ).signMessage({
          message: challenge.message,
          recipient: challenge.recipient,
          nonce: Uint8Array.from(atob(challenge.nonce), (c) => c.charCodeAt(0)),
          network: 'testnet',
          signerId: account,
        });
        session.current = await post('/session', { challengeId: challenge.id, ...signed });
      }
      headers.Authorization = `Bearer ${session.current!.token}`;
    }
    try {
      return await post(
        `/orders/${encodeURIComponent(order.id)}/extract`,
        { text, mode: 'live' },
        headers,
      );
    } catch (error) {
      session.current = null;
      throw error;
    }
  }
  async function call(method: string, args: Record<string, unknown>, deposit = '0') {
    if (!d) throw new Error('Testnet deployment is not configured.');
    setTransaction(await sendCall(d.vault, method, args, deposit));
  }
  async function create(input: CreateOrder) {
    if (!account || !d) throw new Error('Connect your wallet first.');
    input = createSchema.parse(input);
    if (new Set([account, input.supplier, input.receiver, input.operator]).size !== 4)
      throw new Error('Buyer, supplier, receiver and operator must use separate accounts.');
    const id = `PO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    await call(
      'create_order',
      {
        order_id: id,
        terms: {
          supplier: input.supplier,
          receiver: input.receiver,
          operator: input.operator,
          payout: input.payout,
          line_id: 'cartons',
          description: input.description,
          unit: 'carton',
          ordered: String(input.ordered),
          unit_price: input.unitPrice,
          expires_at: (BigInt(Date.now() + 7 * 86400000) * 1_000_000n).toString(),
        },
      },
      '1000000000000000000000000',
    );
    setSelected(id);
  }
  async function fund() {
    if (!d || !order) throw new Error('Order not loaded.');
    for (const id of [d.vault, order.terms.payout])
      setTransaction(
        await sendCall(
          d.token,
          'storage_deposit',
          { account_id: id, registration_only: true },
          '100000000000000000000000',
        ),
      );
    setTransaction(
      await sendCall(
        d.token,
        'ft_transfer_call',
        {
          receiver_id: d.vault,
          amount: (BigInt(order.terms.ordered) * BigInt(order.terms.unit_price)).toString(),
          msg: order.id,
        },
        '1',
      ),
    );
  }
  async function payment() {
    if (!order || !extraction) throw new Error('Review an invoice first.');
    if (
      BigInt(quantity) <= 0n ||
      BigInt(quantity) > chainAvailable(order) ||
      BigInt(quantity) > BigInt(extraction.invoice.quantity)
    )
      throw new Error('Requested quantity exceeds current order or invoice quantity.');
    const challenge = await post('/challenge', {
      orderId: order.id,
      quantity,
      auditHash: extraction.documentHash,
    });
    const bytes = Uint8Array.from(atob(challenge.nonce), (c) => c.charCodeAt(0));
    const signed = await (
      await walletConnector().wallet()
    ).signMessage({
      message: challenge.message,
      recipient: challenge.recipient,
      nonce: bytes,
      network: 'testnet',
      signerId: account!,
    });
    await post('/submit', { challengeId: challenge.id, ...signed });
  }
  const totals = orders.reduce(
    (t, o) => ({
      funded: t.funded + BigInt(o.funded) - BigInt(state?.recoveries?.[o.id]?.refunded ?? '0'),
      paid: t.paid + BigInt(o.paid) * BigInt(o.terms.unit_price),
      available: t.available + chainAvailable(o) * BigInt(o.terms.unit_price),
      pending: t.pending + BigInt(o.pending) * BigInt(o.terms.unit_price),
    }),
    { funded: 0n, paid: 0n, available: 0n, pending: 0n },
  );
  const role = order
    ? account === order.buyer
      ? 'buyer'
      : account === order.terms.supplier
        ? 'supplier'
        : account === order.terms.receiver
          ? 'receiver'
          : account === order.terms.operator
            ? 'operator'
            : 'observer'
    : 'observer';
  if (!account)
    return (
      <div className="wallet-gate">
        <header className="wallet-gate-header">
          <a className="gate-brand" href="/" aria-label="Accord home">
            <span className="brand-symbol">
              <i />
              <i />
            </span>
            accord<span>.</span>
          </a>
          <a className="gate-home-link" href="/">
            Back to website
            <ArrowUpRight size={14} />
          </a>
        </header>
        <main className="wallet-gate-main">
          <div className="wallet-gate-art" aria-hidden="true">
            <div />
            <div />
            <span className="brand-symbol">
              <i />
              <i />
            </span>
          </div>
          <span className="eyebrow">LET’S GET IN AGREEMENT</span>
          <h1>Connect your wallet.</h1>
          <p>
            Your wallet is your account.
            <br />
            Connect to manage your orders and supplier payments.
          </p>
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await walletConnector().connect();
                setAccount(await accountId());
              })
            }
          >
            <Wallet size={17} />
            Connect wallet
            <ArrowRight size={16} />
          </button>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          <small>
            <LockKeyhole size={12} />
            You stay in control. We never ask for your private keys.
          </small>
        </main>
        <footer className="wallet-gate-footer">
          <span>Accord</span>
          <span>{d?.network === 'mainnet' ? 'NEAR Mainnet' : 'NEAR Testnet'}</span>
          <a href="/#safeguards">
            Security & safeguards
            <ArrowUpRight size={12} />
          </a>
        </footer>
      </div>
    );
  return (
    <div className="app-shell testnet-shell">
      <aside className="sidebar">
        <a className="wordmark" href="/">
          <span className="brand-symbol">
            <i />
            <i />
          </span>
          accord<span className="wordmark-period">.</span>
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">N</span>
          <div>
            {account}
            <small>Connected wallet</small>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          <button
            className={`nav-item ${view === 'orders' ? 'active' : ''}`}
            onClick={() => {
              setSelected(null);
              setView('orders');
            }}
          >
            <Layers2 size={18} />
            Purchase orders
          </button>
          <button
            className={`nav-item ${view === 'payments' ? 'active' : ''}`}
            onClick={() => {
              setSelected(null);
              setView('payments');
            }}
          >
            <ArrowUpRight size={18} />
            Payments
          </button>
          <a className="nav-item" href="/">
            <ArrowLeft size={18} />
            Overview
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="network-note">
            <span className="connection-dot" />
            NEAR testnet<small>Connected to NEAR</small>
          </div>
          <div className="profile">
            <ShieldCheck size={18} />
            <div>
              Agreed terms<small>Clear payment limits</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            Workspace
            <ChevronRight size={13} />
            <button onClick={() => setSelected(null)}>
              {view === 'payments' ? 'Payments' : 'Purchase orders'}
            </button>
            {order && (
              <>
                <ChevronRight size={13} />
                <span>{order.id}</span>
              </>
            )}
          </div>
          <div className="wallet-controls">
            {account ? (
              <>
                <span className="connected-account">{account}</span>
                <button
                  className="button secondary"
                  onClick={() => run(() => walletConnector().disconnect())}
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await walletConnector().connect();
                    setAccount(await accountId());
                  })
                }
              >
                <Wallet size={15} />
                Connect wallet
              </button>
            )}
          </div>
        </header>
        <div className="environment-strip">
          <span>
            <span className="connection-dot" />
            NEAR TESTNET
          </span>
          <p>Purchase orders and supplier payments</p>
          {d && (
            <a
              href={`https://testnet.nearblocks.io/address/${d.vault}`}
              target="_blank"
              rel="noreferrer"
            >
              View contract
              <ArrowUpRight size={12} />
            </a>
          )}
        </div>
        <main>
          {error && (
            <div className="alert error" role="alert">
              <ShieldCheck size={17} />
              <div>{error}</div>
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {transaction && (
            <div className="chain-receipt" role="status">
              <Check size={15} />
              <span>Transaction submitted. Current contract state determines the outcome.</span>
              <a href={explorer(transaction)} target="_blank" rel="noreferrer">
                Inspect receipt
                <ArrowUpRight size={13} />
              </a>
            </div>
          )}
          {!state ? (
            <div className="loading">
              <Loader2 className="spin" />
              Loading your workspace…
            </div>
          ) : !state.configured ? (
            <div className="empty-state">
              <Wallet size={32} />
              <h2>Testnet deployment is not configured.</h2>
              <p>The workspace is temporarily unavailable. Please try again shortly.</p>
              <a className="button secondary" href="/workspace">
                Return home
                <ArrowRight size={14} />
              </a>
            </div>
          ) : view === 'payments' ? (
            <PaymentHistory
              state={state}
              jobs={jobs}
              account={account}
              onOrder={(id) => {
                setSelected(id);
                setView('orders');
              }}
            />
          ) : order ? (
            <>
              <button className="back-link" onClick={() => setSelected(null)}>
                ← All purchase orders
              </button>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">{order.id} / NEAR TESTNET</div>
                  <h1>{order.terms.description}</h1>
                  <p>{order.terms.supplier}</p>
                </div>
                <Badge tone={chainAvailable(order) > 0n ? 'green' : 'neutral'}>
                  {label(order, recovery)}
                </Badge>
              </div>
              <div className="detail-grid">
                <div className="detail-main">
                  <section className="line-section">
                    <div className="section-heading">
                      <h2>Order breakdown</h2>
                      <span>Onchain · fixed price</span>
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
                              <strong>{order.terms.description}</strong>
                              <small className="block muted">
                                {money(order.terms.unit_price)} aUSD / {order.terms.unit}
                              </small>
                            </td>
                            <td>{order.terms.ordered}</td>
                            <td>{order.accepted}</td>
                            <td>{order.paid}</td>
                            <td>{order.pending}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </section>
                  <section className="eligibility-section">
                    <div className="section-heading">
                      <h2>What can be paid now?</h2>
                      <ShieldCheck size={19} />
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
                        <strong>{chainAvailable(order).toString()}</strong>
                        <span>Eligible cartons</span>
                      </div>
                    </div>
                    <p>
                      Eligible value:{' '}
                      {money((chainAvailable(order) * BigInt(order.terms.unit_price)).toString())}{' '}
                      aUSD. The onchain contract fixes the price and recipient.
                    </p>
                  </section>
                  <section className="ledger-section">
                    <div className="section-heading">
                      <h2>Payment attempts</h2>
                      <span>Read from the contract</span>
                    </div>
                    {state.attempts.filter((a) => a.order_id === order.id).length ? (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Request</th>
                              <th>Quantity</th>
                              <th>Amount</th>
                              <th>Result</th>
                            </tr>
                          </thead>
                          <tbody>
                            {state.attempts
                              .filter((a) => a.order_id === order.id)
                              .map((a) => (
                                <tr key={a.request_id}>
                                  <td>{a.request_id.slice(0, 16)}</td>
                                  <td>{a.quantity}</td>
                                  <td>{money(a.amount)} aUSD</td>
                                  <td>
                                    <Badge
                                      tone={
                                        a.status === 'Settled' || a.status === 'ReceiptAcknowledged'
                                          ? 'green'
                                          : a.status === 'TransferFailed'
                                            ? 'red'
                                            : 'amber'
                                      }
                                    >
                                      {a.status === 'Reserved'
                                        ? 'Awaiting outcome'
                                        : a.status === 'ReceiptAcknowledged'
                                          ? 'Recipient confirmed'
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
                        <FileText size={22} />
                        <div>
                          No tracked attempts
                          <small>Signed operator jobs appear here after dispatch.</small>
                        </div>
                      </div>
                    )}
                    {jobs
                      .filter((j) => j.orderId === order.id)
                      .map((j) => (
                        <div className="chain-job" key={j.id}>
                          <Badge
                            tone={
                              j.status === 'settled'
                                ? 'green'
                                : j.status === 'failed'
                                  ? 'red'
                                  : 'amber'
                            }
                          >
                            {j.status}
                          </Badge>
                          <code>{j.id.slice(0, 8)}</code>
                          {j.transactionHash && (
                            <a href={explorer(j.transactionHash)} target="_blank" rel="noreferrer">
                              Transaction
                              <ArrowUpRight size={12} />
                            </a>
                          )}
                          {j.error && <p>{j.error}</p>}
                        </div>
                      ))}
                  </section>
                  {recovery && (
                    <RecoveryPanel
                      key={`${order.id}:${account}`}
                      order={order}
                      recovery={recovery}
                      account={account}
                      attempts={state.attempts}
                      busy={busy}
                      onCall={async (method, args) => {
                        setBusy(true);
                        try {
                          await call(method, args);
                          await refresh();
                        } finally {
                          setBusy(false);
                        }
                      }}
                    />
                  )}
                </div>
                <aside className="order-aside">
                  <div className="next-action">
                    <span className="eyebrow">CONNECTED AUTHORITY</span>
                    <h2>
                      {role === 'observer'
                        ? 'Read-only access'
                        : role === 'buyer'
                          ? 'Buyer'
                          : role === 'supplier'
                            ? 'Supplier'
                            : role === 'receiver'
                              ? 'Delivery receiver'
                              : 'Payment operator'}
                    </h2>
                    <p>
                      {account
                        ? 'Authority follows the connected wallet and accepted order terms.'
                        : 'Connect a wallet to act on this order. Public order records are visible without signing.'}
                    </p>
                    {!order.accepted_terms && (
                      <button
                        className="button primary full"
                        disabled={busy || role !== 'supplier'}
                        onClick={() => setModal('accept')}
                      >
                        Review & accept
                        <ArrowRight size={15} />
                      </button>
                    )}
                    {order.accepted_terms && order.funded === '0' && (
                      <button
                        className="button primary full"
                        disabled={busy || role !== 'buyer'}
                        onClick={() => setModal('fund')}
                      >
                        Prepare & fund
                        <ArrowRight size={15} />
                      </button>
                    )}
                    {open &&
                      order.funded !== '0' &&
                      BigInt(order.accepted) < BigInt(order.terms.ordered) && (
                        <button
                          className="button secondary full"
                          disabled={busy || role !== 'receiver'}
                          onClick={() => {
                            setTotal((BigInt(order.accepted) + 1n).toString());
                            setModal('receipt');
                          }}
                        >
                          <PackageCheck size={15} />
                          Confirm delivery
                        </button>
                      )}
                    {open && chainAvailable(order) > 0n && (
                      <button
                        className="button primary full"
                        disabled={busy || role !== 'operator' || !state.operatorReady}
                        onClick={() => {
                          setText('');
                          setExtraction(null);
                          setQuantity(chainAvailable(order).toString());
                          setModal('invoice');
                        }}
                      >
                        Review invoice
                        <ArrowRight size={15} />
                      </button>
                    )}
                  </div>
                  <div className="terms-summary">
                    <h3>Accepted authorities</h3>
                    <dl>
                      {Object.entries({
                        Buyer: order.buyer,
                        Supplier: order.terms.supplier,
                        'Fixed payout': order.terms.payout,
                        Receiver: order.terms.receiver,
                        Operator: order.terms.operator,
                        Token: d?.token,
                      }).map(([k, v]) => (
                        <div key={k}>
                          <dt>{k}</dt>
                          <dd>{v}</dd>
                        </div>
                      ))}
                    </dl>
                    <button
                      className="copy-hash"
                      onClick={() => navigator.clipboard.writeText(order.terms_hash)}
                    >
                      Terms commitment
                      <LockKeyhole size={12} />
                      <code>{order.terms_hash.slice(0, 24)}…</code>
                    </button>
                  </div>
                  <div className="limit-note">
                    <LockKeyhole size={15} />
                    <p>
                      Testnet only. Invoice authenticity is not verified. Deployment keys are
                      retained during testing.
                      {!recovery && ' Closure and refunds are unavailable for this deployment.'}
                    </p>
                  </div>
                </aside>
              </div>
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">PROCUREMENT</div>
                  <h1>Purchase orders</h1>
                  <p>Your orders, accepted deliveries, and supplier payments.</p>
                </div>
                <button
                  className="button primary"
                  disabled={!account || busy}
                  onClick={() => setModal('create')}
                >
                  <Plus size={16} />
                  New purchase order
                </button>
              </div>
              <div className="metrics">
                <Metric
                  label="Funded budget"
                  amount={totals!.funded.toString()}
                  caption="In onchain order ledgers"
                  icon={<Wallet size={16} />}
                />
                <Metric
                  label="Paid to suppliers"
                  amount={totals!.paid.toString()}
                  caption="Finalized in the contract"
                  icon={<ArrowUpRight size={16} />}
                />
                <Metric
                  label="Eligible to pay"
                  amount={totals!.available.toString()}
                  caption="Accepted minus paid and pending"
                  accent
                  icon={<ShieldCheck size={16} />}
                />
                <Metric
                  label="In progress"
                  amount={totals!.pending.toString()}
                  caption="Reservations stay locked"
                  icon={<LockKeyhole size={16} />}
                />
              </div>
              <section className="panel">
                <div className="table-scroll">
                  <table className="orders-table">
                    <thead>
                      <tr>
                        <th>Purchase order</th>
                        <th>Supplier</th>
                        <th>Approved value</th>
                        <th>Accepted</th>
                        <th>Status</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((o) => (
                        <tr key={o.id} onClick={() => setSelected(o.id)}>
                          <td>
                            <button className="order-id">
                              <span className="document-icon">
                                <FileText size={18} />
                              </span>
                              {o.id}
                            </button>
                          </td>
                          <td>
                            <span className="supplier-name">{o.terms.supplier}</span>
                            <small className="block muted">{o.terms.description}</small>
                          </td>
                          <td>
                            {money(
                              (BigInt(o.terms.ordered) * BigInt(o.terms.unit_price)).toString(),
                            )}{' '}
                            aUSD
                          </td>
                          <td>
                            {o.accepted} / {o.terms.ordered}
                          </td>
                          <td>
                            <Badge tone={chainAvailable(o) > 0n ? 'green' : 'neutral'}>
                              {label(o, state.recoveries?.[o.id])}
                            </Badge>
                          </td>
                          <td>
                            <ChevronRight size={15} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!orders.length && (
                  <div className="empty-state">
                    <FileText size={30} />
                    <h2>No purchase orders yet</h2>
                    <p>Create your first purchase order to get started.</p>
                  </div>
                )}
              </section>
              <div className="workspace-footer">
                <ShieldCheck size={18} />
                <p>Payments follow your agreed terms and confirmed deliveries.</p>
                <a
                  href={`https://testnet.nearblocks.io/address/${d?.vault}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Inspect contract
                  <ArrowUpRight size={14} />
                </a>
              </div>
            </>
          )}
        </main>
        <footer className="app-footer">
          <span>Accord / NEAR testnet</span>
          <span>Supplier payments, in agreement.</span>
        </footer>
      </div>
      {modal && (
        <ModalShell
          title={
            modal === 'create'
              ? 'New purchase order'
              : modal === 'receipt'
                ? 'Confirm received goods'
                : modal === 'accept'
                  ? 'Accept fixed order terms'
                  : modal === 'fund'
                    ? 'Prepare token funding'
                    : 'Review supplier invoice'
          }
          subtitle={order?.id ?? 'Sign with your connected wallet'}
          onClose={() => {
            if (!busy) setModal(null);
          }}
          wide={modal === 'invoice'}
          busy={busy}
        >
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          {modal === 'create' ? (
            <CreateForm
              busy={busy}
              role="buyer"
              buyerAccount={account ?? ''}
              testnet
              operatorAccount={d?.operator}
              recoveryEnabled={d?.features?.includes('recovery-v1')}
              onCreate={(input) => run(() => create(input as CreateOrder))}
            />
          ) : order && modal === 'accept' ? (
            <>
              <p className="modal-description">
                Accept the exact order commitment, fixed payout, unit price, and receiver authority.
                Your wallet must match the supplier account.
              </p>
              <div className="review-summary">
                <dl>
                  <div>
                    <dt>Goods</dt>
                    <dd>
                      {order.terms.ordered} × {order.terms.description}
                    </dd>
                  </div>
                  <div>
                    <dt>Unit price</dt>
                    <dd>{money(order.terms.unit_price)} aUSD</dd>
                  </div>
                  <div>
                    <dt>Fixed payout</dt>
                    <dd>{order.terms.payout}</dd>
                  </div>
                </dl>
              </div>
              <button
                className="button primary full"
                disabled={busy}
                onClick={() =>
                  run(() =>
                    call('accept_order', { order_id: order.id, terms_hash: order.terms_hash }),
                  )
                }
              >
                Sign acceptance
                <Check size={15} />
              </button>
            </>
          ) : order && modal === 'fund' ? (
            <>
              <p className="modal-description">
                Register the vault and fixed payout with the test token, then transfer exactly{' '}
                {money((BigInt(order.terms.ordered) * BigInt(order.terms.unit_price)).toString())}{' '}
                aUSD. Wallet approval is required for each transaction.
              </p>
              <div className="alert warning">
                <LockKeyhole size={16} />
                Registration attaches up to 0.1 testnet NEAR per account; excess is returned by the
                token.{' '}
                {recovery
                  ? 'Unused tokens require buyer and supplier approval to refund.'
                  : 'Unspent order tokens cannot be withdrawn.'}
              </div>
              <button className="button primary full" disabled={busy} onClick={() => run(fund)}>
                Register & fund with wallet
                <ArrowRight size={15} />
              </button>
            </>
          ) : order && modal === 'receipt' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  if (
                    BigInt(total) <= BigInt(order.accepted) ||
                    BigInt(total) > BigInt(order.terms.ordered)
                  )
                    throw new Error('Cumulative quantity must increase and stay within the order.');
                  const bytes = new TextEncoder().encode(
                    JSON.stringify({ order: order.id, total }),
                  );
                  const digest = Array.from(
                    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                  )
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join('');
                  await call('confirm_delivery', {
                    order_id: order.id,
                    sequence: (BigInt(order.sequence) + 1n).toString(),
                    cumulative_quantity: total,
                    receipt_hash: digest,
                  });
                });
              }}
            >
              <p className="modal-description">
                Previously accepted: {order.accepted}. Enter the new cumulative total, including
                previous deliveries.
              </p>
              <label className="field">
                New cumulative quantity
                <input
                  type="number"
                  required
                  min={Number(order.accepted) + 1}
                  max={Number(order.terms.ordered)}
                  value={total}
                  onChange={(e) => setTotal(e.target.value)}
                />
              </label>
              <button className="button primary full" disabled={busy}>
                Sign delivery receipt
                <Check size={15} />
              </button>
            </form>
          ) : order && modal === 'invoice' ? (
            <>
              <p className="modal-description">
                Add your invoice text, then review the extracted details before requesting payment.
              </p>
              <div className="invoice-review">
                <div className="invoice-document">
                  <div className="document-heading">
                    <FileText size={16} />
                    Invoice source
                  </div>
                  <textarea
                    aria-label="Invoice source text"
                    placeholder="Paste the supplier invoice text here…"
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      setExtraction(null);
                    }}
                  />
                </div>
                <div className="extracted-fields">
                  {extraction ? (
                    <>
                      <span className="eyebrow">EXTRACTED FIELDS</span>
                      <h3>{extraction.invoice.reference}</h3>
                      <dl>
                        <div>
                          <dt>Invoiced quantity</dt>
                          <dd>{extraction.invoice.quantity}</dd>
                        </div>
                        <div>
                          <dt>Eligible quantity</dt>
                          <dd>{chainAvailable(order).toString()}</dd>
                        </div>
                        <div>
                          <dt>Fixed payout</dt>
                          <dd>{order.terms.payout}</dd>
                        </div>
                      </dl>
                      <label className="field">
                        Quantity to pay
                        <input
                          type="number"
                          min={1}
                          max={chainAvailable(order).toString()}
                          value={quantity}
                          onChange={(e) => setQuantity(e.target.value)}
                        />
                      </label>
                      <p className="field-note">
                        Your wallet signs a one-time authorization. The worker uses a restricted key
                        to request the payment. The contract independently enforces entitlement.
                      </p>
                    </>
                  ) : (
                    <div className="extraction-empty">
                      <FileText size={28} />
                      <h3>Review the invoice</h3>
                      <p>Extraction does not authorize payment or confirm invoice authenticity.</p>
                    </div>
                  )}
                </div>
              </div>
              <div className="modal-actions">
                <p>Settlement uses real testnet token transfers.</p>
                {extraction ? (
                  <button className="button primary" disabled={busy} onClick={() => run(payment)}>
                    Authorize bounded request
                    <ArrowUpRight size={15} />
                  </button>
                ) : (
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => run(async () => setExtraction(await extractInvoice()), false)}
                  >
                    {busy ? <Loader2 className="spin" size={15} /> : <FileText size={15} />}Extract
                    invoice
                  </button>
                )}
              </div>
            </>
          ) : null}
        </ModalShell>
      )}
    </div>
  );
}
