import { useState } from 'react';
import { ArrowLeft, ArrowUpRight, Download, Printer } from 'lucide-react';
import type { Deployment } from '../../shared/chain';
import type { PaymentRow } from '../../shared/payments';
import { hasAdvice, isoDate, paymentCSV } from '../../shared/reports';
import { money } from '../../shared/schema';
import { downloadCSV } from './Exports';
import './reporting.css';

function utcDate(value: string) {
  return (
    new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(new Date(value)) + ' UTC'
  );
}
export function RemittanceAdvice({
  row,
  deployment,
  onBack,
}: {
  row?: PaymentRow;
  deployment: Deployment;
  onBack: () => void;
}) {
  const [generatedAt] = useState(() => new Date().toISOString());
  if (!row || !hasAdvice(row))
    return (
      <div className="empty-state advice-unavailable">
        <h1>{row ? 'Payment awaiting confirmation' : 'Payment not available'}</h1>
        <p>
          {row
            ? 'Remittance advice is available after payment is confirmed.'
            : 'Open a payment associated with your connected account.'}
        </p>
        <button className="button secondary" onClick={onBack}>
          <ArrowLeft size={14} />
          Back to payments
        </button>
      </div>
    );
  const explorer =
    deployment.network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';
  return (
    <div className="advice-view">
      <div className="advice-actions">
        <button className="back-link" onClick={onBack}>
          <ArrowLeft size={14} />
          Back to payments
        </button>
        <div>
          <button
            className="button secondary"
            onClick={() =>
              downloadCSV(
                `accord-remittance-${row.id}.csv`,
                paymentCSV([row], deployment, generatedAt),
              )
            }
          >
            <Download size={15} />
            Download CSV
          </button>
          <button
            className="button primary"
            onClick={() => {
              const title = document.title;
              try {
                document.title = `Remittance ${row.order.id} · Accord`;
                window.print();
              } finally {
                document.title = title;
              }
            }}
          >
            <Printer size={15} />
            Print / Save PDF
          </button>
        </div>
      </div>
      <article className="remittance-advice" aria-label="Remittance advice">
        <header className="advice-header">
          <div className="advice-brand">
            <img src="/brand/accord-mark.svg?v=orange-1" alt="" />
            accord<span>.</span>
          </div>
          <span>NEAR {deployment.network}</span>
        </header>
        <div className="advice-title">
          <div className="eyebrow">PAYMENT RECORD</div>
          <h1>Remittance advice</h1>
          <p>{row.order.id}</p>
        </div>
        <div className="advice-amount">
          <div>
            <span>Amount paid</span>
            <strong>
              {money(row.amount)} <small>aUSD</small>
            </strong>
          </div>
          <div className="advice-confirmation">
            <span className="badge green">Confirmed</span>
            <p>
              {row.settlement === 'recipient'
                ? 'Receipt acknowledged by recipient'
                : 'Settlement confirmed by contract'}
            </p>
          </div>
        </div>
        <div className="advice-parties">
          <div>
            <span>From</span>
            <h2>Buyer</h2>
            <p>{row.order.buyer}</p>
          </div>
          <div>
            <span>To</span>
            <h2>Supplier</h2>
            <p>{row.order.terms.supplier}</p>
            <small>Paid to {row.recipient}</small>
          </div>
        </div>
        <div className="advice-order-meta">
          <div>
            <span>Purchase order</span>
            <strong>{row.order.id}</strong>
          </div>
          <div>
            <span>Invoice reference</span>
            <strong>{row.invoice?.reference ?? 'Not recorded'}</strong>
          </div>
          {isoDate(row.createdAt) && (
            <div>
              <span>Requested</span>
              <strong>{utcDate(isoDate(row.createdAt))}</strong>
            </div>
          )}
        </div>
        <section className="advice-line-mobile" aria-label="Paid item">
          <h2>{row.order.terms.description}</h2>
          <p>Line: {row.order.terms.line_id}</p>
          <dl>
            <div>
              <dt>Quantity</dt>
              <dd>
                {row.quantity} {row.order.terms.unit}
                {row.quantity === '1' ? '' : 's'}
              </dd>
            </div>
            <div>
              <dt>Unit price</dt>
              <dd>{money(row.order.terms.unit_price)} aUSD</dd>
            </div>
            <div className="advice-line-total">
              <dt>Paid</dt>
              <dd>{money(row.amount)} aUSD</dd>
            </div>
          </dl>
        </section>
        <table className="advice-lines">
          <thead>
            <tr>
              <th>Description</th>
              <th>Quantity</th>
              <th>Unit price</th>
              <th>Paid</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                {row.order.terms.description}
                <small>Line: {row.order.terms.line_id}</small>
              </td>
              <td>
                {row.quantity} {row.order.terms.unit}
                {row.quantity === '1' ? '' : 's'}
              </td>
              <td>{money(row.order.terms.unit_price)} aUSD</td>
              <td>{money(row.amount)} aUSD</td>
            </tr>
          </tbody>
        </table>
        <section className="advice-verification" aria-label="Payment verification">
          <h2>Payment details</h2>
          <dl>
            <div>
              <dt>Request ID</dt>
              <dd>{row.id}</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>NEAR {deployment.network}</dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd>
                {row.order.token} <span>(aUSD, 6 decimals)</span>
              </dd>
            </div>
            <div>
              <dt>Payment contract</dt>
              <dd>{deployment.vault}</dd>
            </div>
            <div>
              <dt>Document SHA-256</dt>
              <dd>{row.auditHash}</dd>
            </div>
            {row.transactionHash && (
              <div>
                <dt>Transaction</dt>
                <dd>
                  <a
                    href={`${explorer}/txns/${encodeURIComponent(row.transactionHash)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {row.transactionHash}
                    <ArrowUpRight size={12} />
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </section>
        <footer className="advice-footer">
          <p>Generated {utcDate(generatedAt)}</p>
          <p>Prepared from Accord’s recorded payment information.</p>
        </footer>
      </article>
    </div>
  );
}
