import { useState, type FormEvent } from 'react';
import { ArrowRight, LockKeyhole } from 'lucide-react';
import { money, type Role } from '../../shared/schema';
import './create-order-form.css';

function priceInBaseUnits(value: string) {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}
export function CreateForm({
  onCreate,
  busy,
  role,
  buyerAccount = 'buyer.testnet',
  testnet = false,
  operatorAccount,
  recoveryEnabled = false,
}: {
  onCreate: (input: unknown) => void;
  busy: boolean;
  role: Role;
  buyerAccount?: string;
  testnet?: boolean;
  operatorAccount?: string;
  recoveryEnabled?: boolean;
}) {
  const [unitPrice, setUnitPrice] = useState('10');
  const [qty, setQty] = useState(100);
  const [supplier, setSupplier] = useState('');
  const [paySupplier, setPaySupplier] = useState(true);
  const price = priceInBaseUnits(unitPrice);
  const total =
    price !== null && Number.isSafeInteger(qty) && qty > 0
      ? money((price * BigInt(qty)).toString())
      : '—';
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (price === null) return;
    const form = new FormData(e.currentTarget);
    onCreate({
      supplierName: form.get('supplierName') || supplier,
      supplier,
      payout: paySupplier ? supplier : form.get('payout'),
      receiver: form.get('receiver'),
      operator: form.get('operator'),
      description: form.get('description'),
      ordered: qty,
      unitPrice: price.toString(),
    });
  }
  return (
    <form className="create-order-form" onSubmit={submit}>
      <fieldset disabled={busy}>
        <legend>Order details</legend>
        {!testnet && (
          <label className="field">
            Supplier name
            <input
              name="supplierName"
              placeholder="e.g. Meridian Supply Co."
              required
              minLength={2}
              maxLength={80}
              autoFocus
            />
          </label>
        )}
        <label className="field">
          Item description
          <input
            name="description"
            placeholder="e.g. Premium packing cartons"
            required
            minLength={2}
            maxLength={160}
            autoFocus={testnet}
          />
        </label>
        <div className="form-columns">
          <label className="field">
            Quantity (cartons)
            <input
              type="number"
              min={1}
              max={1000000}
              value={qty}
              onChange={(e) => setQty(Number(e.target.value))}
              required
            />
          </label>
          <label className="field">
            Unit price (aUSD)
            <input
              inputMode="decimal"
              pattern="[0-9]+(\.[0-9]{1,6})?"
              maxLength={38}
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
              required
            />
          </label>
        </div>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Supplier & payment</legend>
        <label className="field">
          Supplier account
          <input
            name="supplier"
            placeholder="supplier.testnet"
            required
            minLength={2}
            maxLength={64}
            pattern={'[a-z0-9._\\-]{2,64}'}
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <label className="payout-choice">
          <input
            type="checkbox"
            checked={paySupplier}
            onChange={(e) => setPaySupplier(e.target.checked)}
          />
          Pay this supplier account
        </label>
        {!paySupplier && (
          <label className="field separate-payout">
            Payment account
            <input
              name="payout"
              placeholder="payments.testnet"
              required
              minLength={2}
              maxLength={64}
              pattern={'[a-z0-9._\\-]{2,64}'}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
        )}
        <p className="form-help">
          Your supplier accepts the payment account before you fund the order.
        </p>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Your team</legend>
        <label className="field">
          Delivery reviewer
          <input
            name="receiver"
            defaultValue={testnet ? '' : 'warehouse.testnet'}
            placeholder="receiver.testnet"
            required
            minLength={2}
            maxLength={64}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        {operatorAccount ? (
          <div className="assigned-operator">
            <span>Payment operator</span>
            <p>{operatorAccount}</p>
            <input type="hidden" name="operator" value={operatorAccount} />
          </div>
        ) : (
          <label className="field">
            Payment operator
            <input
              name="operator"
              defaultValue="operator.testnet"
              required
              minLength={2}
              maxLength={64}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
        )}
        <p className="form-help">
          Buyer, supplier, delivery reviewer and payment operator each use a separate account.
        </p>
      </fieldset>
      <div className="create-order-summary">
        <div>
          <span>Order total</span>
          <strong>
            {total} <small>aUSD</small>
          </strong>
        </div>
        <p>
          Created by <span>{buyerAccount}</span>
        </p>
      </div>
      <div className="create-order-notes">
        {testnet && (
          <p>
            <strong>1 testnet NEAR storage deposit.</strong> Retained by the order contract; not
            refundable.
          </p>
        )}
        <p className={recoveryEnabled ? '' : 'refund-unavailable'}>
          <LockKeyhole size={14} />
          {recoveryEnabled
            ? 'Unused funds can be returned with your supplier’s approval after delivered goods are paid.'
            : 'Unspent funds cannot currently be refunded.'}
        </p>
      </div>
      {role !== 'buyer' && (
        <p className="field-note">Switch the demo actor to Buyer to create an order.</p>
      )}
      <button className="button primary full" disabled={busy || role !== 'buyer'}>
        Create purchase order
        <ArrowRight size={16} />
      </button>
    </form>
  );
}
