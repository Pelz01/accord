import { useState, type FormEvent } from 'react';
import { LockKeyhole, ArrowRight } from 'lucide-react';
import { type Role } from '../../shared/schema';
export function CreateForm({
  onCreate,
  busy,
  role,
  buyerAccount = 'buyer.testnet',
  testnet = false,
  operatorAccount,
}: {
  onCreate: (input: unknown) => void;
  busy: boolean;
  role: Role;
  buyerAccount?: string;
  testnet?: boolean;
  operatorAccount?: string;
}) {
  const [unitPrice, setUnitPrice] = useState('10'),
    [qty, setQty] = useState(100);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const [whole, fraction = ''] = unitPrice.split('.');
    const base = (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString();
    onCreate({
      supplierName: form.get('supplierName') || form.get('supplier'),
      supplier: form.get('supplier'),
      payout: form.get('payout'),
      receiver: form.get('receiver'),
      operator: form.get('operator'),
      description: form.get('description'),
      ordered: qty,
      unitPrice: base,
    });
  }
  return (
    <form onSubmit={submit}>
      <div className="form-section-label">01 / ORDER DETAILS</div>
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
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
            required
          />
        </label>
      </div>
      <div className="form-section-label">02 / AUTHORITY & PAYOUT</div>
      <label className="field">
        Supplier account
        <input
          name="supplier"
          placeholder="supplier.testnet"
          required
          pattern={'[a-z0-9._\\-]{2,64}'}
        />
      </label>
      <label className="field">
        Fixed payout account
        <input
          name="payout"
          placeholder="supplier.testnet"
          required
          pattern={'[a-z0-9._\\-]{2,64}'}
        />
      </label>
      <div className="form-columns">
        <label className="field">
          Receiver account
          <input
            name="receiver"
            defaultValue={testnet ? '' : 'warehouse.testnet'}
            placeholder="receiver.testnet"
            required
          />
        </label>
        <label className="field">
          Operator account
          <input
            name="operator"
            defaultValue={operatorAccount || 'operator.testnet'}
            readOnly={Boolean(operatorAccount)}
            required
          />
        </label>
      </div>
      <p className="field-note">
        Buyer: {buyerAccount}. Each authority must use a separate account. One line per order in
        Accord.
      </p>
      <div className="alert warning">
        <LockKeyhole size={16} />
        Unspent funds cannot currently be refunded.
      </div>
      {testnet && (
        <p className="field-note">
          Creation attaches 1 testnet NEAR for order storage and token-call deposits. It is retained
          without a refund.
        </p>
      )}
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
