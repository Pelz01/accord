import { settlementSymbol as currency } from './network';
import { useMemo, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CircleHelp, Clock3, Search, Wallet } from 'lucide-react';
import { ordersForAccount, type ChainState, type ChainJob } from '../../shared/chain';
import { paymentRows, type PaymentRow } from '../../shared/payments';
import { money } from '../../shared/schema';
import { Badge, Metric } from '../components/primitives';
import { advicePath, hasAdvice, paymentCSV } from '../../shared/reports';
import { Exports } from './Exports';
import { orderPositions, positionTotals } from '../../shared/payables';
import './payment-history.css';
import './reporting.css';

const filters = ['All payments', 'Paid', 'In progress', 'Needs review', 'Failed'] as const;
type Filter = (typeof filters)[number];
function inFilter(row: PaymentRow, filter: Filter) {
  return (
    filter === 'All payments' ||
    (filter === 'In progress'
      ? ['Pending', 'Queued', 'Processing', 'Checking'].includes(row.status)
      : row.status === filter)
  );
}
export function PaymentHistory({
  state,
  jobs,
  account,
  onOrder,
  onAdvice,
  capturedAt,
}: {
  state: ChainState;
  jobs: ChainJob[];
  account: string;
  onOrder: (id: string) => void;
  onAdvice: (id: string) => void;
  capturedAt: string;
}) {
  const [filter, setFilter] = useState<Filter>('All payments');
  const [query, setQuery] = useState('');
  const rows = useMemo(
    () => paymentRows(state.orders, state.attempts, jobs, account, state.deployment),
    [state, jobs, account],
  );
  const search = query.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      inFilter(row, filter) &&
      (!search ||
        [row.id, row.order.id, row.recipient, row.order.terms.supplier].some((v) =>
          v.toLowerCase().includes(search),
        )),
  );
  const totals = positionTotals(orderPositions(state, jobs, account, 'all'));
  const explorer =
    state.deployment?.network === 'mainnet'
      ? 'https://nearblocks.io'
      : 'https://testnet.nearblocks.io';
  const historyComplete =
    state.coverage?.attemptsComplete ??
    ordersForAccount(state.orders, account).every(
      (order) =>
        rows.filter((row) => row.order.id === order.id && row.source === 'contract').length ===
        order.attempts,
    );
  const snapshot = capturedAt || new Date().toISOString();
  const updated = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(snapshot));
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PAYMENT ACTIVITY</div>
          <h1>Payments</h1>
          <p>From payment request to confirmed settlement.</p>
        </div>
        <div className="payment-export-actions">
          <span className="payment-live">
            <span className="connection-dot" />
            Updated {updated} UTC
          </span>
          <Exports
            options={[
              {
                label: 'Payments CSV',
                filename: `accord-${state.deployment!.network}-payments-${snapshot.slice(0, 10)}.csv`,
                contents: () => paymentCSV(visible, state.deployment!, snapshot, state.coverage),
                disabled: !visible.length,
              },
            ]}
          />
        </div>
      </div>
      <div className="metrics payment-metrics">
        <Metric
                  symbol={currency}
          label="Paid"
          amount={totals.paid.toString()}
          caption="Confirmed order balances"
          icon={<Check size={16} />}
          accent
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
          label="Needs review"
          amount={totals.reviewHeld}
          caption="Included in the in-progress amount"
          icon={<CircleHelp size={16} />}
        />
      </div>
      {!historyComplete && (
        <div className="report-notice" role="status">
          Some payment attempts are not available in this view. Exports include the listed payment
          records; order balances remain current.
        </div>
      )}
      <section className="panel payment-history" aria-label="Payment history">
        <div className="payment-toolbar">
          <div className="payment-filters" aria-label="Filter payments">
            {filters.map((name) => (
              <button
                key={name}
                className={filter === name ? 'active' : ''}
                aria-pressed={filter === name}
                onClick={() => setFilter(name)}
              >
                {name}
                <span>{rows.filter((row) => inFilter(row, name)).length}</span>
              </button>
            ))}
          </div>
          <label className="payment-search">
            <Search size={15} />
            <input
              aria-label="Search payments"
              placeholder="Search payments"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        {visible.length ? (
          <div className="table-scroll">
            <table className="payment-table">
              <thead>
                <tr>
                  <th>Payment / order</th>
                  <th>Recipient</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Receipt</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <button className="payment-order" onClick={() => onOrder(row.order.id)}>
                        {row.order.id}
                        <ArrowRight size={13} />
                      </button>
                      <small className="payment-request" title={row.id}>
                        {row.id}
                      </small>
                      {row.invoice && (
                        <small className="block muted">Invoice {row.invoice.reference}</small>
                      )}
                    </td>
                    <td>
                      <span className="payment-recipient" title={row.recipient}>
                        {row.recipient}
                      </span>
                      <small className="block muted">
                        {row.quantity} {row.order.terms.unit}
                        {row.quantity === '1' ? '' : 's'}
                      </small>
                    </td>
                    <td className="payment-amount">
                      {money(row.amount)} <small>{currency}</small>
                    </td>
                    <td>
                      <Badge
                        tone={
                          row.status === 'Paid'
                            ? 'green'
                            : row.status === 'Failed'
                              ? 'red'
                              : row.status === 'Needs review'
                                ? 'amber'
                                : 'neutral'
                        }
                      >
                        {row.status}
                      </Badge>
                      {row.receiptAcknowledged && (
                        <small className="block muted">Confirmed by recipient</small>
                      )}
                    </td>
                    <td>
                      {row.transactionHash ? (
                        <a
                          className="payment-receipt"
                          href={`${explorer}/txns/${encodeURIComponent(row.transactionHash)}`}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`View receipt for ${row.id}`}
                        >
                          View receipt
                          <ArrowUpRight size={13} />
                        </a>
                      ) : (
                        <span className="muted">—</span>
                      )}
                      {hasAdvice(row) && (
                        <a
                          className="remittance-link"
                          href={advicePath(row.id)}
                          aria-label={`View remittance for ${row.id}`}
                          onClick={(event) => {
                            event.preventDefault();
                            onAdvice(row.id);
                          }}
                        >
                          Remittance advice
                          <ArrowRight size={12} />
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <Wallet size={30} />
            <h2>{rows.length ? 'No matching payments' : 'No payments yet'}</h2>
            <p>
              {rows.length
                ? 'Try another search or payment status.'
                : 'Payment requests for your orders will appear here.'}
            </p>
            {rows.length > 0 && (
              <button
                className="button secondary"
                onClick={() => {
                  setQuery('');
                  setFilter('All payments');
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        )}
        <div className="table-footer">
          <span>
            {visible.length} of {rows.length} payment{rows.length === 1 ? '' : 's'}
          </span>
          <span>Confirmed payments are final in the contract.</span>
        </div>
      </section>
    </>
  );
}
