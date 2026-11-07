import { ArrowUpRight } from 'lucide-react';
import type { OrderPosition } from '../../shared/payables';
import { money } from '../../shared/schema';
import { Badge } from '../components/primitives';

export function OrderCards({
  positions,
  supplier = false,
  account,
  onOrder,
}: {
  positions: OrderPosition[];
  supplier?: boolean;
  account: string;
  onOrder: (id: string) => void;
}) {
  return (
    <ul className="order-cards" aria-label={supplier ? 'Supplier orders' : 'Purchase orders'}>
      {positions.map((row) => {
        const closed = row.status === 'Closed' || row.status === 'Fulfilled';
        const showBuyer =
          supplier ||
          (row.order.buyer !== account &&
            (row.order.terms.supplier === account || row.order.terms.payout === account));
        return (
          <li key={row.order.id}>
            <div className="order-card-heading">
              <button className="order-card-link" onClick={() => onOrder(row.order.id)}>
                {row.order.id}
                <ArrowUpRight size={17} />
              </button>
              <Badge
                tone={
                  row.needsReview ? 'amber' : closed || BigInt(row.ready) > 0n ? 'green' : 'neutral'
                }
              >
                {row.status}
              </Badge>
            </div>
            <h2>{row.order.terms.description}</h2>
            <p className="order-card-account">
              <span>{showBuyer ? 'Buyer' : 'Supplier'}</span>
              {showBuyer ? row.order.buyer : row.order.terms.supplier}
            </p>
            <dl className="order-card-balances">
              <div>
                <dt>{closed ? 'Paid' : 'Still committed'}</dt>
                <dd>
                  {money(closed ? row.paid : row.committed)} <small>aUSD</small>
                </dd>
              </div>
              <div>
                <dt>{closed ? 'Returned to buyer' : 'Ready to review'}</dt>
                <dd>
                  {money(closed ? row.refunded : row.ready)} <small>aUSD</small>
                </dd>
              </div>
            </dl>
            <div className="order-card-footer">
              <span>
                {row.order.accepted} of {row.order.terms.ordered} {row.order.terms.unit}
                {row.order.terms.ordered === '1' ? '' : 's'} accepted
              </span>
              {BigInt(row.processing) > 0n && <span>{money(row.processing)} aUSD in progress</span>}
              {supplier && row.order.terms.supplier !== account && <span>Payout recipient</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
