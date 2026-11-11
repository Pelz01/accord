import { settlementSymbol as currency } from './network';
import { useState } from 'react';
import type { ChainAttempt, ChainOrder, ChainRecovery } from '../../shared/chain';
import { money } from '../../shared/schema';
import { ModalShell } from '../components/ModalShell';
import { Badge } from '../components/primitives';
import './recovery.css';

type Review = {
  method: string;
  args: Record<string, unknown>;
  title: string;
  amount: string;
  recipient: string;
  acknowledgment?: boolean;
};

export function RecoveryPanel({
  order,
  recovery,
  attempts,
  account,
  busy,
  onCall,
}: {
  order: ChainOrder;
  recovery: ChainRecovery;
  attempts: ChainAttempt[];
  account: string;
  busy: boolean;
  onCall: (method: string, args: Record<string, unknown>) => Promise<void>;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const commercialParty = account === order.buyer || account === order.terms.supplier;
  const ready = order.funded !== '0' && order.pending === '0' && order.paid === order.accepted;
  const proposal = recovery.proposal;
  const expired = proposal && BigInt(proposal.expires_at) <= BigInt(Date.now()) * 1_000_000n;
  const refundable = (
    BigInt(order.funded) -
    BigInt(order.paid) * BigInt(order.terms.unit_price)
  ).toString();
  const refund = recovery.refunds.at(-1);
  function open(value: Review) {
    setConfirmed(false);
    setError('');
    setReview(value);
  }
  async function submit(method: string, args: Record<string, unknown>) {
    setError('');
    try {
      await onCall(method, args);
      setReview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The transaction could not be completed.');
    }
  }
  const paymentReceipts = attempts.filter(
    (a) => a.order_id === order.id && a.status === 'Reserved' && a.recipient === account,
  );
  return (
    <section className="recovery-section" aria-label="Closure and recovery">
      <div className="section-heading">
        <h2>Closure & refunds</h2>
        <Badge tone={recovery.phase === 'Closed' ? 'green' : 'neutral'}>
          {recovery.phase === 'Closed'
            ? 'Closed'
            : recovery.phase === 'RefundPending'
              ? 'Refund pending'
              : recovery.phase === 'RefundFailed'
                ? 'Refund failed'
                : 'Open'}
        </Badge>
      </div>
      <div className="refund-overview">
        <div>
          <span>{recovery.phase === 'Closed' ? 'Returned to buyer' : 'Unused budget'}</span>
          <strong>
            {money(recovery.phase === 'Closed' ? recovery.refunded : refundable)}{' '}
            <small>{currency}</small>
          </strong>
        </div>
        <div>
          <span>Refund account</span>
          <strong className="refund-account">{order.buyer}</strong>
        </div>
      </div>
      {recovery.phase === 'Open' && (
        <>
          <p>Buyer and supplier approve closure after all accepted deliveries are paid.</p>
          {!ready && (
            <p className="field-note">
              {order.pending !== '0'
                ? 'A payment is still unresolved.'
                : 'Settle accepted deliveries before closing this order.'}
            </p>
          )}
          {proposal && (
            <div className="close-proposal">
              <span>{expired ? 'Proposal expired' : 'Closure proposed'}</span>
              <strong>{proposal.proposed_by}</strong>
              <small>
                {money(proposal.refund_amount)} {currency} to {order.buyer}
              </small>
            </div>
          )}
          {commercialParty && (
            <div className="recovery-actions">
              {!proposal || expired ? (
                <button
                  className="button secondary"
                  disabled={busy || !ready}
                  onClick={() =>
                    open({
                      method: 'propose_close',
                      args: { order_id: order.id },
                      title: 'Propose order closure',
                      amount: refundable,
                      recipient: order.buyer,
                    })
                  }
                >
                  Propose closure
                </button>
              ) : (
                <>
                  {proposal.proposed_by !== account && (
                    <button
                      className="button primary"
                      disabled={busy || !ready || proposal.refund_amount !== refundable}
                      onClick={() =>
                        open({
                          method: 'accept_close',
                          args: { order_id: order.id, proposal_hash: proposal.hash },
                          title: 'Approve closure & refund',
                          amount: proposal.refund_amount,
                          recipient: order.buyer,
                        })
                      }
                    >
                      Review closure
                    </button>
                  )}
                  {proposal.proposed_by === account && (
                    <span className="field-note">
                      Waiting for the supplier or buyer to approve.
                    </span>
                  )}
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => submit('cancel_close', { order_id: order.id })}
                  >
                    Cancel proposal
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
      {recovery.phase === 'RefundFailed' && (
        <>
          <p>
            The token transfer failed. The refund remains owed to the buyer and the order is frozen.
          </p>
          {account === order.buyer && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                open({
                  method: 'retry_refund',
                  args: { order_id: order.id },
                  title: 'Retry buyer refund',
                  amount: refundable,
                  recipient: order.buyer,
                })
              }
            >
              Retry refund
            </button>
          )}
        </>
      )}
      {recovery.phase === 'RefundPending' && (
        <>
          <p>
            Funds are reserved while the refund result is confirmed. Please check the transaction
            receipt before taking another action.
          </p>
          {refund && account === order.buyer && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                open({
                  method: 'acknowledge_refund',
                  args: { order_id: order.id, refund_id: refund.id },
                  title: 'Confirm refund received',
                  amount: refund.amount,
                  recipient: order.buyer,
                  acknowledgment: true,
                })
              }
            >
              I received this refund
            </button>
          )}
        </>
      )}
      {recovery.phase === 'Closed' && (
        <p>
          {refund?.status === 'ReceiptAcknowledged'
            ? 'Refund receipt was confirmed by the buyer.'
            : 'Closure is final. No further deliveries or payments can be recorded.'}
        </p>
      )}
      {paymentReceipts.map((attempt) => (
        <div className="payment-recovery" key={attempt.request_id}>
          <div>
            <strong>Payment awaiting confirmation</strong>
            <small>
              {money(attempt.amount)} {currency} · {attempt.request_id}
            </small>
          </div>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              open({
                method: 'acknowledge_payment',
                args: { request_id: attempt.request_id },
                title: 'Confirm payment received',
                amount: attempt.amount,
                recipient: attempt.recipient,
                acknowledgment: true,
              })
            }
          >
            I received this payment
          </button>
        </div>
      ))}
      {error && !review && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {review && (
        <ModalShell
          title={review.title}
          subtitle={order.id}
          busy={busy}
          onClose={() => setReview(null)}
        >
          <div className="refund-review">
            <span>{review.acknowledgment ? 'Receipt to confirm' : 'Buyer refund'}</span>
            <strong>
              {money(review.amount)} <small>{currency}</small>
            </strong>
            <span>{review.recipient}</span>
          </div>
          <p className="recovery-review-copy">
            {review.acknowledgment
              ? 'Confirm only after verifying the funds reached this account. This finalizes the reservation as paid, sends no additional tokens, and cannot be undone.'
              : review.method === 'propose_close'
                ? 'This asks the other party to approve the same order state. No refund is sent until both parties agree.'
                : 'This permanently stops new deliveries and payments. Unused tokens return only to the original buyer.'}
          </p>
          <label className="recovery-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {review.acknowledgment
              ? 'I verified receipt of these funds.'
              : 'I reviewed the amount and refund account.'}
          </label>
          {error && (
            <p className="alert error" role="alert">
              {error}
            </p>
          )}
          <button
            className="button primary full"
            disabled={busy || !confirmed}
            onClick={() => submit(review.method, review.args)}
          >
            {busy
              ? 'Waiting for wallet…'
              : review.acknowledgment
                ? 'Confirm receipt'
                : 'Continue in wallet'}
          </button>
        </ModalShell>
      )}
    </section>
  );
}
