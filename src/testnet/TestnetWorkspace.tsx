import { BrandMark } from '../components/BrandMark';
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
  LayoutDashboard,
  Loader2,
  LockKeyhole,
  PackageCheck,
  Plus,
  ShieldCheck,
  Store,
  Wallet,
  X,
} from 'lucide-react';
import {
  type ChainState,
  type ChainJob,
  chainAvailable,
  ordersForAccount,
} from '../../shared/chain';
import { type CreateOrder, money, createSchema } from '../../shared/schema';
import { Badge, Metric } from '../components/primitives';
import { ModalShell } from '../components/ModalShell';
import { CreateForm } from '../components/CreateOrderForm';
import { walletConnector, accountId, sendCall } from './Wallet';
import { customerApprovalDeposit } from '../../shared/customer-approval';
import { PaymentHistory } from './PaymentHistory';
import { PayablesOverview } from './PayablesOverview';
import { RemittanceAdvice } from './RemittanceAdvice';
import { RecoveryPanel } from './RecoveryPanel';
import { NativeDepositPanel } from './NativeDepositPanel';
import { InvoiceReview } from './InvoiceReview';
import type { InvoicePayload } from '../../shared/invoices';
import { orderPositions, positionTotals } from '../../shared/payables';
import { paymentRows } from '../../shared/payments';
import { OrderCards } from './OrderCards';
import { WalletMenu } from './WalletMenu';
import './workspace-polish.css';
import { chainFetch, selectedNetwork, explorerBase, settlementSymbol as currency } from './network';
import { assertDeploymentNetwork, orderAllowance, tokenRegistration } from '../../shared/network';
import { nativeDisplay } from '../../shared/mainnet-readiness';
import { IntentsFundingPanel } from './IntentsFundingPanel';
import { fundingActions, WRAPPED_NEAR } from '../../shared/intents';
import { walletResultHash, WalletReceiptUnavailable } from '../../shared/wallet-result';

const explorer = (hash: string) => `${explorerBase}/txns/${hash}`;
type WorkspaceView = 'home' | 'overview' | 'supplier' | 'orders' | 'payments';
function route() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('view');
  const view: WorkspaceView = ['overview', 'supplier', 'orders', 'payments'].includes(
    requested ?? '',
  )
    ? (requested as WorkspaceView)
    : 'home';
  return {
    view,
    order: view === 'orders' ? params.get('order') : null,
    payment: view === 'payments' ? params.get('payment') : null,
  };
}

export function TestnetWorkspace() {
  const [state, setState] = useState<ChainState | null>(null),
    [error, setError] = useState(''),
    [working, setBusy] = useState(false),
    [account, setAccount] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(() => route().order);
  const [modal, setModal] = useState<
      'create' | 'receipt' | 'invoice' | 'accept' | 'fund' | 'intents' | null
    >(null),
    [total, setTotal] = useState(''),
    [transaction, setTransaction] = useState('');
  const [jobs, setJobs] = useState<ChainJob[]>([]);
  const session = useRef<{ accountId: string; token: string; expires: number } | null>(null);
  const [view, setView] = useState<WorkspaceView>(() => route().view);
  const [adviceId, setAdviceId] = useState<string | null>(() => route().payment);
  const [capturedAt, setCapturedAt] = useState('');
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState('');
  const busy = working || refreshRequired;
  function navigate(
    next: WorkspaceView,
    orderId: string | null = null,
    paymentId: string | null = null,
    replace = false,
  ) {
    setView(next);
    setSelected(orderId);
    setAdviceId(paymentId);
    setModal(null);
    const url = new URL(window.location.href);
    url.pathname = '/workspace';
    for (const key of ['view', 'order', 'payment']) url.searchParams.delete(key);
    if (next !== 'home') url.searchParams.set('view', next);
    if (orderId) url.searchParams.set('order', orderId);
    if (paymentId) url.searchParams.set('payment', paymentId);
    window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
  }
  useEffect(() => {
    const changed = () => {
      const next = route();
      setView(next.view);
      setSelected(next.order);
      setAdviceId(next.payment);
      setModal(null);
    };
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);
  const refresh = useCallback(async () => {
    if (!account) return;
    const r = await chainFetch(
      '/api/chain/state' + (account ? '?account=' + encodeURIComponent(account) : ''),
    );
    const body = await r.json();
    if (!r.ok) throw new Error(body.error ?? 'Order state is unavailable.');
    if (body.deployment) assertDeploymentNetwork(body.deployment, selectedNetwork);
    setState(body);
    setRefreshRequired(false);
    setRefreshNotice('');
    // Job-list availability must not turn a successful chain read into a failure.
    try {
      const j = await chainFetch('/api/chain/jobs');
      if (j.ok) setJobs((await j.json()).jobs);
    } catch {
      // The next background refresh will retry this supplementary read.
    }
    setCapturedAt(new Date().toISOString());
  }, [account]);
  useEffect(() => {
    session.current = null;
    if (!account) {
      setState(null);
      setJobs([]);
      setRefreshRequired(false);
      setRefreshNotice('');
      return;
    }
    refresh().catch(() =>
      setRefreshNotice('Could not load the latest order records. Reconnecting automatically.'),
    );
    const id = setInterval(() => refresh().catch(() => {}), 10000);
    return () => clearInterval(id);
  }, [refresh]);
  useEffect(() => {
    accountId().then(setAccount);
    const c = walletConnector();
    const signIn = ({ accounts }: { accounts: { accountId: string }[] }) =>
      setAccount(accounts[0]?.accountId ?? null);
    const signOut = () => {
      setTransaction('');
      setAccount(null);
      navigate('home', null, null, true);
      setError('');
    };
    c.on('wallet:signIn', signIn);
    c.on('wallet:signOut', signOut);
    return () => {
      c.off('wallet:signIn', signIn);
      c.off('wallet:signOut', signOut);
    };
  }, []);
  const orders = ordersForAccount(state?.orders ?? [], account);
  const activeView =
    view === 'home'
      ? !orders.length || orders.some((order) => order.buyer === account)
        ? 'overview'
        : orders.some((order) => order.terms.supplier === account || order.terms.payout === account)
          ? 'supplier'
          : 'orders'
      : view;
  const positions = state ? orderPositions(state, jobs, account, 'all') : [];
  const positionByID = new Map(positions.map((position) => [position.order.id, position]));
  const order = orders.find((o) => o.id === selected),
    d = state?.deployment;
  const recovery = order ? state?.recoveries?.[order.id] : undefined;
  const open = !recovery || recovery.phase === 'Open';
  function walletError(value: unknown) {
    const message = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
    if (
      [
        'No accounts found',
        'No wallet selected',
        'Account is disconnected',
        'Account is not connected',
      ].includes(message)
    ) {
      const message = 'Your wallet connection ended. Connect again to continue.';
      session.current = null;
      navigate('home', null, null, true);
      setAccount(null);
      setError(message);
      return new Error(message);
    }
    return value instanceof Error
      ? value
      : new Error(message || 'This action could not be completed.');
  }
  async function signWalletMessage(challenge: {
    message: string;
    recipient: string;
    nonce: string;
  }) {
    try {
      const wallet = await walletConnector().wallet();
      return await wallet.signMessage({
        message: challenge.message,
        recipient: challenge.recipient,
        nonce: Uint8Array.from(atob(challenge.nonce), (c) => c.charCodeAt(0)),
        network: selectedNetwork,
        signerId: account!,
      });
    } catch (e) {
      throw walletError(e);
    }
  }
  async function run(fn: () => Promise<unknown>, close = true) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refreshAfterAction();
      if (close) setModal(null);
    } catch (e) {
      if (e instanceof WalletReceiptUnavailable) {
        setModal(null);
        await refreshAfterAction();
      }
      setError(walletError(e).message);
    } finally {
      setBusy(false);
    }
  }
  async function refreshAfterAction() {
    if (!account) return;
    setRefreshRequired(true);
    try {
      await refresh();
    } catch {
      setRefreshNotice(
        'Transaction submitted. Waiting for the latest order records. Actions will unlock after refresh; do not submit it again.',
      );
    }
  }
  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const r = await chainFetch(`/api/chain${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? 'Request failed.');
    return data;
  }
  async function authorizedRequest(path: string, body?: unknown) {
    if (!account) throw new Error('Connect your wallet first.');
    const headers: Record<string, string> = {};
    if (state?.authRequired) {
      if (
        !session.current ||
        session.current.accountId !== account ||
        session.current.expires <= Date.now()
      ) {
        const challenge = await post('/session/challenge', { accountId: account });
        const signed = await signWalletMessage(challenge);
        session.current = await post('/session', { challengeId: challenge.id, ...signed });
      }
      headers.Authorization = 'Bearer ' + session.current!.token;
    }
    const response = await chainFetch('/api/chain' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401) session.current = null;
      throw new Error(result.error ?? 'This action could not be completed.');
    }
    return result;
  }
  async function call(method: string, args: Record<string, unknown>, deposit = '0') {
    if (!d) throw new Error('Deployment is not configured.');
    const orderId =
      typeof args.order_id === 'string'
        ? args.order_id
        : state?.attempts.find((attempt) => attempt.request_id === args.request_id)?.order_id;
    if (deposit === '0')
      deposit = customerApprovalDeposit(
        d,
        method,
        orderId ? state?.paymentPolicies?.[orderId] : undefined,
      );
    setTransaction(await sendCall(d.vault, method, args, deposit));
  }
  async function create(input: CreateOrder) {
    if (!account || !d) throw new Error('Connect your wallet first.');
    const pendingKey = `accord:unresolved-create:${selectedNetwork}:${d.vault}:${account}`;
    const pendingId = sessionStorage.getItem(pendingKey);
    if (pendingId) {
      const response = await chainFetch('/api/chain/state?account=' + encodeURIComponent(account));
      if (!response.ok) throw new WalletReceiptUnavailable();
      const latest: ChainState = await response.json();
      assertDeploymentNetwork(latest.deployment!, selectedNetwork);
      if (!latest.orders.some((o) => o.id === pendingId && o.buyer === account))
        throw new Error(
          `The earlier creation request for ${pendingId} is still unresolved. Check its wallet receipt before starting another order.`,
        );
      sessionStorage.removeItem(pendingKey);
      navigate('orders', pendingId);
      return;
    }
    input = createSchema.parse(input);
    if (
      account === input.supplier ||
      account === input.operator ||
      input.receiver === input.supplier ||
      input.receiver === input.operator ||
      input.supplier === input.operator
    )
      throw new Error(
        'Choose separate buyer, supplier and delivery reviewer accounts. You can confirm your own deliveries.',
      );
    const id = `PO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    try {
      await call(
        d.features?.includes('automatic-v1') ? 'create_automatic_order' : 'create_order',
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
        orderAllowance(d.network),
      );
    } catch (e) {
      if (!(e instanceof WalletReceiptUnavailable)) throw e;
      sessionStorage.setItem(pendingKey, id);
      // Creation has a unique id: recover from the finalized contract read, never create again.
      const response = await chainFetch('/api/chain/state?account=' + encodeURIComponent(account));
      if (!response.ok) throw e;
      const latest: ChainState = await response.json();
      assertDeploymentNetwork(latest.deployment!, selectedNetwork);
      const created = latest.orders.find((o) => o.id === id && o.buyer === account);
      if (!created) throw e;
    }
    sessionStorage.removeItem(pendingKey);
    navigate('orders', id);
  }
  async function fund() {
    if (!d || !order) throw new Error('Order not loaded.');
    for (const id of [d.vault, order.terms.payout])
      setTransaction(
        await sendCall(
          d.token,
          'storage_deposit',
          { account_id: id, registration_only: true },
          tokenRegistration(d.network),
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
  async function payment(invoice: InvoicePayload, quantity: string) {
    if (!order) throw new Error('Open an order first.');
    if (
      BigInt(quantity) <= 0n ||
      BigInt(quantity) > chainAvailable(order) ||
      BigInt(quantity) > BigInt(invoice.quantity)
    )
      throw new Error('Requested quantity exceeds the order or invoice.');
    const challenge = await post('/challenge', {
      orderId: order.id,
      quantity,
      auditHash: invoice.document_hash,
      invoice,
    });
    const signed = await signWalletMessage(challenge);
    await post('/submit', { challengeId: challenge.id, ...signed });
  }
  const totals = positionTotals(positions);
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
  const automatic = Boolean(order && state?.paymentPolicies?.[order.id]?.mode === 'automatic');
  if (!account)
    return (
      <div className="wallet-gate">
        <header className="wallet-gate-header">
          <a className="gate-brand" href="/" aria-label="Accord home">
            <BrandMark />
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
            <BrandMark />
          </div>
          <span className="eyebrow">LET’S GET IN AGREEMENT</span>
          <h1>Connect your wallet.</h1>
          <p>
            Your wallet is your account.
            <br />
            Connect to manage your orders, invoices and payments.
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
          <span>NEAR {selectedNetwork}</span>
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
          <BrandMark />
          accord<span className="wordmark-period">.</span>
        </a>
        <nav aria-label="Workspace navigation">
          <button
            className={`nav-item ${activeView === 'overview' ? 'active' : ''}`}
            disabled={busy}
            onClick={() => navigate('overview')}
          >
            <LayoutDashboard size={18} />
            <span className="nav-long">Overview</span>
            <span className="nav-short">Overview</span>
          </button>
          <button
            className={`nav-item ${activeView === 'orders' ? 'active' : ''}`}
            disabled={busy}
            onClick={() => navigate('orders')}
          >
            <Layers2 size={18} />
            <span className="nav-long">Purchase orders</span>
            <span className="nav-short">Orders</span>
          </button>
          <button
            className={`nav-item ${activeView === 'supplier' ? 'active' : ''}`}
            disabled={busy}
            onClick={() => navigate('supplier')}
          >
            <Store size={18} />
            <span className="nav-long">Supplier view</span>
            <span className="nav-short">Supplier</span>
          </button>
          <button
            className={`nav-item ${activeView === 'payments' ? 'active' : ''}`}
            disabled={busy}
            onClick={() => navigate('payments')}
          >
            <ArrowUpRight size={18} />
            Payments
          </button>
          <a className="nav-item website-link" href="/">
            <ArrowLeft size={18} />
            Back to website
          </a>
        </nav>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="workspace-environment">
            <span>
              <span className="connection-dot" />
              NEAR {selectedNetwork}
            </span>
            {d && (
              <a
                href={`${explorerBase}/address/${d.vault}`}
                target="_blank"
                rel="noreferrer"
                aria-label="View payment contract"
              >
                <ArrowUpRight size={14} />
              </a>
            )}
          </div>
          <div className="wallet-controls">
            {account ? (
              <WalletMenu
                account={account}
                busy={busy}
                onDisconnect={() => run(() => walletConnector().disconnect())}
                onAddUSDC={
                  selectedNetwork === 'mainnet' &&
                  d?.features?.includes('intents-funding-v1') &&
                  account === d.accounts.buyer
                    ? () => setModal('intents')
                    : undefined
                }
              />
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
        <main>
          {refreshNotice && (
            <div className="chain-receipt" role="status">
              <Loader2 size={15} />
              <span>{refreshNotice}</span>
            </div>
          )}
          {error && (
            <div className="alert error" role="alert">
              <ShieldCheck size={17} />
              <div>{error}</div>
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {transaction && activeView === 'orders' && (
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
          ) : !state.configured || !d ? (
            <div className="empty-state">
              <Wallet size={32} />
              <h2>Deployment is not configured.</h2>
              <p>The workspace is temporarily unavailable. Please try again shortly.</p>
              <a className="button secondary" href="/workspace">
                Return home
                <ArrowRight size={14} />
              </a>
            </div>
          ) : activeView === 'overview' || activeView === 'supplier' ? (
            <PayablesOverview
              key={activeView}
              state={state}
              jobs={jobs}
              account={account}
              supplier={activeView === 'supplier'}
              onOrder={(id) => navigate('orders', id)}
              onCreate={() => setModal('create')}
              capturedAt={capturedAt}
            />
          ) : activeView === 'payments' && adviceId ? (
            <RemittanceAdvice
              row={paymentRows(state.orders, state.attempts, jobs, account, d).find(
                (row) => row.id === adviceId,
              )}
              deployment={d!}
              onBack={() => navigate('payments')}
            />
          ) : activeView === 'payments' ? (
            <PaymentHistory
              state={state}
              jobs={jobs}
              account={account}
              onOrder={(id) => navigate('orders', id)}
              onAdvice={(id) => navigate('payments', null, id)}
              capturedAt={capturedAt}
            />
          ) : order ? (
            <>
              <button className="back-link" onClick={() => navigate('orders')}>
                ← All purchase orders
              </button>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    {order.id} / NEAR {selectedNetwork.toUpperCase()}
                  </div>
                  <h1>{order.terms.description}</h1>
                  <p>{order.terms.supplier}</p>
                </div>
                <Badge
                  tone={BigInt(positionByID.get(order.id)?.ready ?? '0') > 0n ? 'green' : 'neutral'}
                >
                  {positionByID.get(order.id)?.status ?? 'Needs review'}
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
                                {money(order.terms.unit_price)} {currency} / {order.terms.unit}
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
                      {currency}. The onchain contract fixes the price and recipient.
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
                                  <td>
                                    {money(a.amount)} {currency}
                                  </td>
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
                          <small>
                            {automatic
                              ? 'Payments appear here once delivery and the invoice are confirmed.'
                              : 'Payment requests appear here after dispatch.'}
                          </small>
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
                  {state.nativeDeposits?.[order.id] && (
                    <NativeDepositPanel
                      key={`native:${order.id}:${account}`}
                      order={order}
                      value={state.nativeDeposits[order.id]}
                      recovery={recovery}
                      account={account}
                      busy={busy}
                      onCall={async (method, args, deposit) => {
                        setBusy(true);
                        try {
                          await call(method, args, deposit);
                          await refreshAfterAction();
                        } finally {
                          setBusy(false);
                        }
                      }}
                    />
                  )}
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
                          await refreshAfterAction();
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
                              : 'Accord payments'}
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
                          disabled={busy || account !== order.terms.receiver}
                          onClick={() => {
                            setTotal((BigInt(order.accepted) + 1n).toString());
                            setModal('receipt');
                          }}
                        >
                          <PackageCheck size={15} />
                          Confirm delivery
                        </button>
                      )}
                    {open && order.funded !== '0' && (
                      <button
                        className="button primary full"
                        disabled={busy || role === 'observer'}
                        onClick={() => {
                          setModal('invoice');
                        }}
                      >
                        Review invoice
                        <ArrowRight size={15} />
                      </button>
                    )}
                  </div>
                  <div className="terms-summary">
                    <h3>Order participants</h3>
                    <dl>
                      {Object.entries({
                        Buyer: order.buyer,
                        Supplier: order.terms.supplier,
                        'Fixed payout': order.terms.payout,
                        ...(order.terms.receiver !== order.buyer
                          ? { 'Delivery reviewer': order.terms.receiver }
                          : {}),
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
                      {selectedNetwork === 'testnet'
                        ? 'Testnet only. '
                        : 'Controlled mainnet release. '}
                      Invoice authenticity is not verified. Deployment keys are retained for this
                      release.
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
                  symbol={currency}
                  label="Still committed"
                  amount={totals.committed}
                  caption="Funded less paid and refunded"
                  icon={<Wallet size={16} />}
                />
                <Metric
                  symbol={currency}
                  label="Paid to suppliers"
                  amount={totals.paid}
                  caption="Finalized in the contract"
                  icon={<ArrowUpRight size={16} />}
                />
                <Metric
                  symbol={currency}
                  label={
                    d?.features?.includes('automatic-v1') ? 'Ready for payment' : 'Ready to review'
                  }
                  amount={totals.ready}
                  caption="Accepted and invoice confirmed"
                  accent
                  icon={<ShieldCheck size={16} />}
                />
                <Metric
                  symbol={currency}
                  label="In progress"
                  amount={totals.processing}
                  caption="Reserved or awaiting dispatch"
                  icon={<LockKeyhole size={16} />}
                />
              </div>
              <section className="panel">
                <OrderCards
                  positions={positions}
                  account={account!}
                  onOrder={(id) => navigate('orders', id)}
                />
                <div className="table-scroll desktop-order-table">
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
                        <tr key={o.id} onClick={() => navigate('orders', o.id)}>
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
                            {currency}
                          </td>
                          <td>
                            {o.accepted} / {o.terms.ordered}
                          </td>
                          <td>
                            <Badge
                              tone={
                                BigInt(positionByID.get(o.id)?.ready ?? '0') > 0n
                                  ? 'green'
                                  : 'neutral'
                              }
                            >
                              {positionByID.get(o.id)?.status ?? 'Needs review'}
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
                <a href={`${explorerBase}/address/${d?.vault}`} target="_blank" rel="noreferrer">
                  Inspect contract
                  <ArrowUpRight size={14} />
                </a>
              </div>
            </>
          )}
        </main>
        <footer className="app-footer">
          <span>Accord / NEAR {selectedNetwork}</span>
          <span>Keep business moving.</span>
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
                    : modal === 'intents'
                      ? 'Add USDC'
                      : 'Review supplier invoice'
          }
          subtitle={
            modal === 'create'
              ? 'Set the details. Your supplier reviews next.'
              : (order?.id ?? 'Review with your connected wallet')
          }
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
              network={selectedNetwork}
              tokenSymbol={currency}
              operatorAccount={d?.operator}
              recoveryEnabled={d?.features?.includes('recovery-v1')}
              automaticPayments={d?.features?.includes('automatic-v1')}
              nativeDeposits={d?.features?.includes('native-deposits-v1')}
              onCreate={(input) => run(() => create(input as CreateOrder))}
            />
          ) : modal === 'intents' && account && d ? (
            <IntentsFundingPanel
              key={`${d.network}:${d.vault}:${account}`}
              account={account}
              request={authorizedRequest}
              onBusy={setBusy}
              onFund={async (record) => {
                if (
                  selectedNetwork !== 'mainnet' ||
                  record.network !== 'mainnet' ||
                  record.vault !== d.vault ||
                  record.account !== account
                )
                  throw new Error('Reconnect the wallet for this funding request.');
                const wallet = await walletConnector().wallet();
                if ((await wallet.getAccounts({ network: 'mainnet' }))[0]?.accountId !== account)
                  throw new Error('Select the original buyer wallet before funding.');
                const result = await wallet.signAndSendTransaction({
                  network: 'mainnet',
                  signerId: account,
                  receiverId: WRAPPED_NEAR,
                  actions: fundingActions(record.quote, record.registrations),
                });
                return walletResultHash(result);
              }}
            />
          ) : order && modal === 'accept' ? (
            <>
              <p className="modal-description">
                Review the agreed price, payment account and delivery reviewer before accepting.
                {automatic &&
                  ' Accord pays automatically when delivery and your invoice are confirmed.'}
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
                    <dd>
                      {money(order.terms.unit_price)} {currency}
                    </dd>
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
                Register the vault and fixed payout with {currency}, then transfer exactly{' '}
                {money((BigInt(order.terms.ordered) * BigInt(order.terms.unit_price)).toString())}{' '}
                {currency}. Wallet approval is required for each transaction.
              </p>
              <div className="alert warning">
                <LockKeyhole size={16} />
                Registration attaches up to{' '}
                {nativeDisplay(BigInt(tokenRegistration(selectedNetwork)))}{' '}
                {selectedNetwork === 'testnet' ? 'testnet ' : ''}NEAR per account; excess is
                returned by the token.{' '}
                {recovery
                  ? 'Unused tokens require buyer and supplier approval to refund.'
                  : 'Unspent order tokens cannot be withdrawn.'}
              </div>
              <button className="button primary full" disabled={busy} onClick={() => run(fund)}>
                Register & fund with wallet
                <ArrowRight size={15} />
              </button>
              {d?.network === 'mainnet' && d.features?.includes('intents-funding-v1') && (
                <button
                  className="button secondary full"
                  disabled={busy}
                  onClick={() => setModal('intents')}
                >
                  Add USDC with NEAR
                </button>
              )}
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
                {automatic &&
                  ' Confirming delivery allows payment against a supplier-confirmed invoice.'}
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
          ) : order && d && modal === 'invoice' ? (
            <InvoiceReview
              key={order.id + ':' + account}
              order={order}
              deployment={d}
              account={account}
              confirmations={state?.confirmations?.[order.id] ?? []}
              busy={busy}
              operatorReady={state?.operatorReady ?? false}
              automatic={automatic}
              liveAiAvailable={state?.liveAiAvailable ?? false}
              onBusy={setBusy}
              request={authorizedRequest}
              onConfirm={async (invoice) => {
                await call('confirm_invoice', { order_id: order.id, invoice });
                await refreshAfterAction();
              }}
              onPayment={async (invoice, quantity) => {
                await payment(invoice, quantity);
                await refreshAfterAction();
              }}
            />
          ) : null}
        </ModalShell>
      )}
    </div>
  );
}
