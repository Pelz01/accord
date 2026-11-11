import { useEffect, useRef, useState } from 'react';
import type { FundingRecord } from '../../server/intents';
import { nativeDisplay } from '../../shared/mainnet-readiness';
import { money } from '../../shared/schema';
import { explorerBase } from './network';
import './intents-funding.css';

export function IntentsFundingPanel({
  account,
  request,
  onFund,
  onBusy,
}: {
  account: string;
  request: (path: string, body?: unknown) => Promise<unknown>;
  onFund: (record: FundingRecord) => Promise<string>;
  onBusy: (busy: boolean) => void;
}) {
  const [record, setRecord] = useState<FundingRecord | null>(null),
    [amount, setAmount] = useState('0.01');
  const [loading, setLoading] = useState(true),
    [working, setWorking] = useState(false),
    [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState(''),
    [reference, setReference] = useState('');
  const requestRef = useRef(request),
    reading = useRef(false);
  requestRef.current = request;
  useEffect(() => {
    let active = true;
    requestRef
      .current('/intents/current')
      .then((value) => {
        if (active) setRecord(value as FundingRecord | null);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [account]);
  async function check(current: FundingRecord) {
    if (reading.current) return;
    reading.current = true;
    try {
      const hash = current.sourceHash || sessionStorage.getItem('accord:intents:' + current.id);
      if (hash && !current.sourceVerified) {
        try {
          current = (await requestRef.current(`/intents/${current.id}/receipt`, {
            hash,
          })) as FundingRecord;
        } catch {
          /* Status reconciliation still runs; never request another deposit. */
        }
      }
      const value = (await requestRef.current(`/intents/${current.id}`)) as FundingRecord;
      setRecord(value);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Funding status is temporarily unavailable.');
    } finally {
      reading.current = false;
    }
  }
  const pending = !!record && !['quoted', 'settled', 'cancelled'].includes(record.stage);
  useEffect(() => {
    if (!record || !pending) return;
    const timer = setInterval(() => void check(record), 10000);
    return () => clearInterval(timer);
  }, [record, pending]);
  async function quote() {
    setWorking(true);
    setError('');
    setReviewed(false);
    try {
      setRecord(
        (await requestRef.current('/intents/quote', { amountNear: amount })) as FundingRecord,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'A quote is not available right now.');
    } finally {
      setWorking(false);
    }
  }
  async function fund() {
    if (!record || record.account !== account || !reviewed) return;
    setWorking(true);
    onBusy(true);
    setError('');
    let reserved: FundingRecord | null = null;
    try {
      reserved = (await requestRef.current(`/intents/${record.id}/begin`, {})) as FundingRecord;
      setRecord(reserved);
      const hash = await onFund(reserved);
      sessionStorage.setItem('accord:intents:' + reserved.id, hash);
      const submitted = (await requestRef.current(`/intents/${reserved.id}/receipt`, {
        hash,
      })) as FundingRecord;
      setRecord(submitted);
      await check(submitted);
    } catch (e) {
      if (reserved)
        setRecord({
          ...reserved,
          error:
            'Check the original wallet request and transaction reference before doing anything else.',
        });
      setError(e instanceof Error ? e.message : 'The funding result needs review.');
    } finally {
      setWorking(false);
      onBusy(false);
    }
  }
  async function cancel() {
    if (!record) return;
    setWorking(true);
    setError('');
    try {
      setRecord((await requestRef.current(`/intents/${record.id}/cancel`, {})) as FundingRecord);
      setReviewed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'This request cannot be cancelled.');
    } finally {
      setWorking(false);
    }
  }
  async function reconcile() {
    if (!record) return;
    setWorking(true);
    setError('');
    try {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,60}$/.test(reference.trim()))
        throw new Error('Enter only the public NEAR transaction hash.');
      sessionStorage.setItem('accord:intents:' + record.id, reference.trim());
      const value = (await requestRef.current(`/intents/${record.id}/receipt`, {
        hash: reference.trim(),
      })) as FundingRecord;
      setRecord(value);
      await check(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The transaction could not be confirmed.');
    } finally {
      setWorking(false);
    }
  }
  const active = record && record.stage !== 'cancelled';
  const expired = active && Date.parse(record.quote.deadline) <= Date.now() + 30000;
  return (
    <section className="intents-funding" aria-label="Add USDC through NEAR Intents">
      <p>Receive USDC in your wallet. Fund your order separately when you’re ready.</p>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading funding requests…</p>
      ) : !active ? (
        <>
          <label className="field">
            Pay with NEAR
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={working}
            />
          </label>
          <p className="field-note">Maximum 0.01 NEAR.</p>
          <button className="button primary full" disabled={working} onClick={() => void quote()}>
            {working ? 'Getting quote…' : 'Get quote'}
          </button>
        </>
      ) : (
        <>
          <dl className="funding-amounts">
            <div>
              <dt>You pay</dt>
              <dd>{nativeDisplay(BigInt(record.quote.amountIn))} NEAR</dd>
            </div>
            <div>
              <dt>Expected</dt>
              <dd>{money(record.quote.amountOut)} USDC</dd>
            </div>
            <div>
              <dt>Minimum received</dt>
              <dd>{money(record.quote.minAmountOut)} USDC</dd>
            </div>
            {record.registrations.length > 0 && (
              <div>
                <dt>Registration deposit</dt>
                <dd>
                  {nativeDisplay(record.registrations.reduce((n, r) => n + BigInt(r.deposit), 0n))}{' '}
                  NEAR
                </dd>
              </div>
            )}
          </dl>
          <p className="funding-recipient">
            Receive and refund to <strong>{record.account}</strong>
          </p>
          {record.stage === 'quoted' ? (
            <>
              <p className="field-note">
                Quote expires {new Date(record.quote.deadline).toLocaleTimeString()}. Wallet gas is
                additional.
              </p>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I reviewed the amount and destination.
              </label>
              <button
                className="button primary full"
                disabled={working || !reviewed || !!expired}
                onClick={() => void fund()}
              >
                {expired ? 'Quote expired' : working ? 'Waiting for wallet…' : 'Continue in wallet'}
              </button>
              <button
                className="button secondary full"
                disabled={working}
                onClick={() => void cancel()}
              >
                Discard quote
              </button>
            </>
          ) : record.stage === 'settled' ? (
            <p className="funding-success" role="status">
              USDC received. Your wallet can now fund an order.
            </p>
          ) : (
            <>
              <p role="status">
                {record.stage === 'awaiting-wallet'
                  ? 'Waiting for the wallet result.'
                  : 'Checking the USDC transfer.'}{' '}
                A second deposit will not be requested.
              </p>
              {record.error && <p className="field-note">{record.error}</p>}
              <button
                className="button secondary full"
                disabled={working}
                onClick={() => void check(record)}
              >
                Check status
              </button>
              {!record.sourceVerified && (
                <details>
                  <summary>Have a transaction reference?</summary>
                  <label className="field">
                    NEAR transaction hash
                    <input
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <button
                    className="button secondary full"
                    disabled={working || !reference.trim()}
                    onClick={() => void reconcile()}
                  >
                    Verify transaction
                  </button>
                </details>
              )}
            </>
          )}
          {(record.sourceHash || record.destinationHash) && (
            <div className="funding-receipts">
              {record.sourceHash && (
                <a
                  href={`${explorerBase}/txns/${record.sourceHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Deposit receipt
                </a>
              )}
              {record.destinationHash && (
                <a
                  href={`${explorerBase}/txns/${record.destinationHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  USDC receipt
                </a>
              )}
            </div>
          )}
        </>
      )}
      <p className="funding-provider">
        Via{' '}
        <a
          href="https://docs.agentsonintents.com/integration/distribution-channels/1click-api/about-1click-api"
          target="_blank"
          rel="noreferrer"
        >
          NEAR Intents
        </a>
        . The quote includes swap fees.
      </p>
    </section>
  );
}
