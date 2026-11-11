import { settlementSymbol as currency } from './network';
import { useMemo, useState } from 'react';
import { ArrowRight, Check, Clock3, FileCheck2, Layers2, Plus, Search, Wallet } from 'lucide-react';
import type { ChainJob, ChainState } from '../../shared/chain';
import { orderPositions, positionTotals } from '../../shared/payables';
import { paymentRows } from '../../shared/payments';
import { orderCSV, paymentCSV, refundCSV } from '../../shared/reports';
import { money } from '../../shared/schema';
import { Badge, Metric } from '../components/primitives';
import { Exports } from './Exports';
import { OrderCards } from './OrderCards';
import './reporting.css';

const filters = [
  'All orders',
  'Ready to review',
  'Invoice review',
  'In progress',
  'Awaiting delivery',
  'Needs attention',
  'Closed',
] as const;
type Filter = (typeof filters)[number];

export function PayablesOverview({
  state,
  jobs,
  account,
  supplier = false,
  onOrder,
  onCreate,
  capturedAt,
}: {
  state: ChainState;
  jobs: ChainJob[];
  account: string;
  supplier?: boolean;
  onOrder: (id: string) => void;
  onCreate: () => void;
  capturedAt: string;
}) {
  const [filter, setFilter] = useState<Filter>('All orders');
  const [query, setQuery] = useState('');
  const positions = useMemo(
    () => orderPositions(state, jobs, account, supplier ? 'supplier' : 'buyer'),
    [state, jobs, account, supplier],
  );
  const totals = positionTotals(positions);
  const automatic = state.deployment?.features?.includes('automatic-v1');
  const readyLabel = automatic ? 'Ready for payment' : 'Ready to review';
  const visible = positions.filter((row) => {
    const inFilter =
      filter === 'All orders' ||
      (filter === 'Ready to review' && BigInt(row.ready) > 0n) ||
      (filter === 'Invoice review' && BigInt(row.invoiceReview) > 0n) ||
      (filter === 'In progress' &&
        (BigInt(row.processing) > 0n || row.status === 'Refund pending')) ||
      (filter === 'Awaiting delivery' && BigInt(row.awaitingDelivery) > 0n) ||
      (filter === 'Needs attention' &&
        (row.needsReview ||
          ['Awaiting acceptance', 'Awaiting funding', 'Expired order'].includes(row.status))) ||
      (filter === 'Closed' && ['Closed', 'Fulfilled'].includes(row.status));
    const text = [
      row.order.id,
      row.order.terms.description,
      row.order.buyer,
      row.order.terms.supplier,
      row.order.terms.payout,
    ]
      .join(' ')
      .toLowerCase();
    return inFilter && text.includes(query.trim().toLowerCase());
  });
  const visibleIDs = new Set(visible.map((row) => row.order.id));
  const payments = paymentRows(
    state.orders,
    state.attempts,
    jobs,
    account,
    state.deployment,
  ).filter((row) => visibleIDs.has(row.order.id));
  const deployment = state.deployment!;
  const scope = supplier ? 'supplier' : 'payables';
  const snapshot = capturedAt || new Date().toISOString();
  const updated = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(snapshot));
  const prefix = `accord-${deployment.network}-${scope}-${snapshot.slice(0, 10)}`;
  return (
    <>
      <div className="page-heading report-heading">
        <div>
          <h1>{supplier ? 'Supplier view' : 'Payables'}</h1>
          <p>
            {supplier
              ? 'Your orders, confirmed deliveries and payments, together.'
              : 'Know what can move, and what needs your attention.'}
          </p>
        </div>
        <div className="report-heading-actions">
          <Exports
            options={[
              {
                label: 'Orders CSV',
                filename: prefix + '-orders.csv',
                contents: () => orderCSV(visible, deployment, snapshot, state.coverage),
                disabled: !visible.length,
              },
              {
                label: 'Payments CSV',
                filename: prefix + '-payments.csv',
                contents: () => paymentCSV(payments, deployment, snapshot, state.coverage),
                disabled: !payments.length,
              },
              {
                label: 'Refunds CSV',
                filename: prefix + '-refunds.csv',
                contents: () => refundCSV(visible, deployment, snapshot, state.coverage),
                disabled: !visible.some((row) => row.recovery?.refunds.length),
              },
            ]}
          />
          {!supplier && (
            <button className="button primary" onClick={onCreate}>
              <Plus size={15} />
              New purchase order
            </button>
          )}
        </div>
      </div>
      <div className="metrics report-metrics">
        <Metric
                  symbol={currency}
          label={readyLabel}
          amount={totals.ready}
          caption="Accepted, unreserved, invoice confirmed"
          icon={<FileCheck2 size={16} />}
          accent
        />
        <Metric
                  symbol={currency}
          label="Invoice review"
          amount={totals.invoiceReview}
          caption="Accepted goods needing invoice review"
          icon={<Layers2 size={16} />}
        />
        <Metric
                  symbol={currency}
          label="In progress"
          amount={totals.processing}
          caption="Reserved or awaiting dispatch"
          icon={<Clock3 size={16} />}
        />
        <Metric
                  symbol={currency}
          label="Still committed"
          amount={totals.committed}
          caption="Funded less paid and refunded"
          icon={<Wallet size={16} />}
        />
      </div>
      <section className="report-balance" aria-label="Order balance breakdown">
        <div>
          <span>Awaiting delivery</span>
          <strong>
            {money(totals.awaitingDelivery)} <small>{currency}</small>
          </strong>
        </div>
        <div>
          <span>{supplier ? 'Paid to your orders' : 'Paid to suppliers'}</span>
          <strong>
            {money(totals.paid)} <small>{currency}</small>
          </strong>
        </div>
        <div>
          <span>Returned to buyers</span>
          <strong>
            {money(totals.refunded)} <small>{currency}</small>
          </strong>
        </div>
        {BigInt(totals.refundHeld) > 0n && (
          <div>
            <span>Held for refund</span>
            <strong>
              {money(totals.refundHeld)} <small>{currency}</small>
            </strong>
          </div>
        )}
      </section>
      {state.coverage?.ordersComplete === false && (
        <div className="report-notice" role="status">
          More orders may exist. These totals and exports cover the orders currently loaded.
        </div>
      )}
      <section
        className="panel report-orders"
        aria-label={supplier ? 'Supplier orders' : 'Payables overview'}
      >
        <div className="report-toolbar">
          <div className="report-filters" aria-label="Filter orders">
            {filters.map((name) => (
              <button
                key={name}
                className={filter === name ? 'active' : ''}
                aria-pressed={filter === name}
                onClick={() => setFilter(name)}
              >
                {name === 'Ready to review' ? readyLabel : name}
              </button>
            ))}
          </div>
          <label className="payment-search">
            <Search size={15} />
            <input
              aria-label="Search orders"
              placeholder={supplier ? 'Search buyers or orders' : 'Search suppliers or orders'}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        {visible.length ? (
          <>
            <OrderCards
              positions={visible}
              supplier={supplier}
              account={account}
              onOrder={onOrder}
            />
            <div className="table-scroll desktop-order-table">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Order / {supplier ? 'buyer' : 'supplier'}</th>
                    <th>Still committed</th>
                    <th>{readyLabel}</th>
                    <th>In progress</th>
                    <th>Status</th>
                    <th aria-label="Order actions" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.order.id}>
                      <td>
                        <button className="payment-order" onClick={() => onOrder(row.order.id)}>
                          {row.order.id}
                          <ArrowRight size={13} />
                        </button>
                        <strong className="report-item">{row.order.terms.description}</strong>
                        <small
                          className="report-account"
                          title={supplier ? row.order.buyer : row.order.terms.supplier}
                        >
                          {supplier ? row.order.buyer : row.order.terms.supplier}
                        </small>
                      </td>
                      <td className="report-money">
                        {money(row.committed)} <small>{currency}</small>
                      </td>
                      <td className="report-money">
                        {money(row.ready)} <small>{currency}</small>
                        <small className="block muted">
                          {row.order.accepted} / {row.order.terms.ordered} {row.order.terms.unit}s
                          accepted
                        </small>
                      </td>
                      <td className="report-money">
                        {money(row.processing)} <small>{currency}</small>
                        {BigInt(row.awaitingDispatch) > 0n && (
                          <small className="block muted">
                            Includes {money(row.awaitingDispatch)} awaiting dispatch
                          </small>
                        )}
                      </td>
                      <td>
                        <Badge
                          tone={
                            row.needsReview
                              ? 'amber'
                              : BigInt(row.ready) > 0n || row.status === 'Closed'
                                ? 'green'
                                : 'neutral'
                          }
                        >
                          {row.status}
                        </Badge>
                        {supplier && row.order.terms.supplier !== account && (
                          <small className="block muted">Payout recipient</small>
                        )}
                      </td>
                      <td>
                        <button
                          className="report-open"
                          aria-label={`Open order ${row.order.id}`}
                          onClick={() => onOrder(row.order.id)}
                        >
                          <ArrowRight size={17} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <Layers2 size={28} />
            <h2>
              {positions.length
                ? 'No matching orders'
                : supplier
                  ? 'Your supplier orders will appear here'
                  : 'A clear view starts with your first order'}
            </h2>
            <p>
              {positions.length
                ? 'Try another status or search.'
                : supplier
                  ? 'Connect the account named as supplier or payout recipient on an order.'
                  : 'Create an order to bring deliveries and payments into one place.'}
            </p>
            {positions.length > 0 && (
              <button
                className="button secondary"
                onClick={() => {
                  setFilter('All orders');
                  setQuery('');
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        )}
        <div className="table-footer">
          <span>
            {visible.length} of {positions.length} order{positions.length === 1 ? '' : 's'}
          </span>
          <span>Updated {updated} UTC · CSV uses exact token amounts.</span>
        </div>
      </section>
      <div className="report-footnote">
        <Check size={14} />
        <p>
          {automatic
            ? 'Payments run after delivery and the supplier’s invoice are confirmed.'
            : 'Ready amounts are available under a confirmed invoice. Review the invoice before authorizing payment.'}
        </p>
      </div>
    </>
  );
}
