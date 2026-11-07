import { useMemo, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CircleHelp, Clock3, Search, Wallet } from 'lucide-react';
import { type ChainState, type ChainJob } from '../../shared/chain';
import { paymentRows, type PaymentRow } from '../../shared/payments';
import { money } from '../../shared/schema';
import { Badge, Metric } from '../components/primitives';
import './payment-history.css';

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
}: {
  state: ChainState;
  jobs: ChainJob[];
  account: string;
  onOrder: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('All payments');
  const [query, setQuery] = useState('');
  const rows = useMemo(
    () => paymentRows(state.orders, state.attempts, jobs, account),
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
  const totals = rows.reduce(
    (sum, row) => {
      if (row.status === 'Paid') sum.paid += BigInt(row.amount);
      if (['Pending', 'Queued', 'Processing', 'Checking'].includes(row.status))
        sum.pending += BigInt(row.amount);
      if (row.status === 'Needs review') sum.review += BigInt(row.amount);
      return sum;
    },
    { paid: 0n, pending: 0n, review: 0n },
  );
  const explorer =
    state.deployment?.network === 'mainnet'
      ? 'https://nearblocks.io'
      : 'https://testnet.nearblocks.io';
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PAYMENT ACTIVITY</div>
          <h1>Payments</h1>
          <p>From payment request to confirmed settlement.</p>
        </div>
        <span className="payment-live">
          <span className="connection-dot" />
          Updated automatically
        </span>
      </div>
      <div className="metrics payment-metrics">
        <Metric
          label="Paid"
          amount={totals.paid.toString()}
          caption="Confirmed payment records"
          icon={<Check size={16} />}
          accent
        />
        <Metric
          label="In progress"
          amount={totals.pending.toString()}
          caption="Awaiting dispatch or confirmation"
          icon={<Clock3 size={16} />}
        />
        <Metric
          label="Needs review"
          amount={totals.review.toString()}
          caption="Outcome requires reconciliation"
          icon={<CircleHelp size={16} />}
        />
      </div>
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
                      {money(row.amount)} <small>aUSD</small>
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
