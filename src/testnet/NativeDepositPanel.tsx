import { useState } from 'react';
import type { ChainNativeDeposit, ChainOrder, ChainRecovery } from '../../shared/chain';
import { nativeDisplay, nativeAmount } from '../../shared/mainnet-readiness';
import { ModalShell } from '../components/ModalShell';
import './recovery.css';

export function NativeDepositPanel({
  order,
  value,
  recovery,
  account,
  busy,
  onCall,
}: {
  order: ChainOrder;
  value: ChainNativeDeposit;
  recovery?: ChainRecovery;
  account: string;
  busy: boolean;
  onCall: (method: string, args: Record<string, unknown>, deposit?: string) => Promise<void>;
}) {
  const [review, setReview] = useState<'claim' | 'topup' | 'cancel' | 'ack' | null>(null);
  const [topup, setTopup] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const d = value.deposit;
  const owner = account === d?.owner;
  const amount = (raw: string) => nativeDisplay(BigInt(raw));
  const summaryAmount = (raw: string) => {
    const exact = amount(raw);
    const [whole, fraction = ''] = exact.split('.');
    return fraction.length > 6 ? `${whole}.${fraction.slice(0, 6)}…` : exact;
  };
  const pending = Boolean(d && d.pending !== '0');
  const net = d
    ? BigInt(d.deposited) - BigInt(d.call_deposits_spent) - BigInt(d.refunded) - BigInt(d.pending)
    : 0n;
  const canTopUp = recovery?.phase !== 'Closed' || net < BigInt(value.retained_required);
  function open(action: typeof review) {
    setError('');
    setConfirmed(false);
    setReview(action);
  }
  async function submit() {
    setError('');
    try {
      const args = { order_id: order.id };
      if (review === 'topup') {
        const units = nativeAmount(topup);
        if (units <= 0n) throw new Error('Enter a positive NEAR amount.');
        await onCall('top_up_order_storage', args, units.toString());
      } else if (review === 'claim') await onCall('claim_native_excess', args);
      else if (review === 'cancel') await onCall('cancel_unfunded_order', args);
      else if (review === 'ack' && d)
        await onCall('acknowledge_native_refund', { ...args, sequence: d.claim_sequence });
      setReview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not complete this action.');
    }
  }
  return (
    <section className="recovery-section native-deposit" aria-label="Order storage deposit">
      <div className="section-heading">
        <h2>{account === order.buyer ? 'Storage deposit' : 'Buyer’s storage deposit'}</h2>
      </div>
      {!value.tracked || !d ? (
        <p>This order predates storage deposit tracking. No refundable NEAR amount is recorded.</p>
      ) : (
        <>
          <div className="refund-overview">
            <div>
              <span>{account === order.buyer ? 'Available to claim' : 'Available to buyer'}</span>
              <strong>
                {summaryAmount(value.claimable)} <small>NEAR</small>
              </strong>
            </div>
            <div>
              <span>Held for this order</span>
              <strong>
                {summaryAmount(value.retained_required)} <small>NEAR</small>
              </strong>
            </div>
          </div>
          <p>
            {recovery?.phase === 'Closed'
              ? `The order's records remain stored. The amount held includes a ${value.margin_percent}% storage buffer.`
              : value.incremental
                ? `Records use this storage balance. Add to the deposit when needed, up to ${value.invoice_limit} invoices and ${value.payment_attempt_limit} payment attempts.`
                : `The deposit reserves room for up to ${value.invoice_limit} invoices and ${value.payment_attempt_limit} payment attempts.`}
          </p>
          <p>
            Deposited {amount(d.deposited)} NEAR · Returned {amount(d.refunded)} NEAR
          </p>
          {pending && (
            <p role="status">
              {amount(d.pending)} NEAR is awaiting a confirmed refund result. It cannot be claimed
              again.
            </p>
          )}
          {d.claim_status === 'Failed' && (
            <p role="status">
              The NEAR refund failed. Its amount has been restored to your available credit.
            </p>
          )}
          {(order.pending !== '0' ||
            (recovery?.refund_pending !== '0' && recovery?.refund_pending !== undefined) ||
            recovery?.phase === 'RefundFailed') && (
            <p>NEAR claims wait until pending supplier payments and token refunds are resolved.</p>
          )}
          {owner && (
            <div className="recovery-actions">
              <button
                className="button primary"
                disabled={busy || value.claimable === '0'}
                onClick={() => open('claim')}
              >
                Claim available NEAR
              </button>
              {canTopUp && (
                <button className="button secondary" disabled={busy} onClick={() => open('topup')}>
                  Add to deposit
                </button>
              )}
              {order.funded === '0' && recovery?.phase === 'Open' && (
                <button className="button secondary" disabled={busy} onClick={() => open('cancel')}>
                  Cancel unfunded order
                </button>
              )}
              {pending && (
                <button className="button secondary" disabled={busy} onClick={() => open('ack')}>
                  Confirm refund received
                </button>
              )}
            </div>
          )}
          {review && (
            <ModalShell
              title={
                review === 'claim'
                  ? 'Claim your NEAR'
                  : review === 'topup'
                    ? 'Add to storage deposit'
                    : review === 'cancel'
                      ? 'Cancel unfunded order'
                      : 'Confirm NEAR received'
              }
              subtitle={order.id}
              busy={busy}
              onClose={() => setReview(null)}
            >
              <p className="recovery-review-copy">
                {review === 'claim'
                  ? `${amount(value.claimable)} NEAR will return to ${d.owner}. The amount required for retained records stays held.`
                  : review === 'topup'
                    ? 'This adds NEAR to the order’s storage deposit. Supplier payments use separate tokens.'
                    : review === 'cancel'
                      ? 'This stops acceptance and funding of this unfunded order. You can then claim the available deposit; its records remain stored.'
                      : `Confirm only if you independently verified receipt of ${amount(d.pending)} NEAR. This sends no further money and cannot be undone.`}
              </p>
              {review === 'topup' && (
                <label>
                  Amount in NEAR
                  <input
                    inputMode="decimal"
                    value={topup}
                    onChange={(e) => setTopup(e.target.value)}
                  />
                </label>
              )}
              <label className="recovery-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {review === 'ack'
                  ? 'I verified the NEAR arrived in my account.'
                  : 'I reviewed this action and amount.'}
              </label>
              {error && (
                <p className="alert error" role="alert">
                  {error}
                </p>
              )}
              <button
                className="button primary full"
                disabled={busy || !confirmed}
                onClick={submit}
              >
                {busy ? 'Waiting for wallet…' : 'Continue in wallet'}
              </button>
            </ModalShell>
          )}
        </>
      )}
    </section>
  );
}
