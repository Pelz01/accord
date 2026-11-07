import { useEffect, useMemo, useState } from 'react';
import { FileText, Upload, Download, Check, ArrowUpRight } from 'lucide-react';
import type { ChainOrder, Deployment } from '../../shared/chain';
import { chainAvailable } from '../../shared/chain';
import { type Extraction, money } from '../../shared/schema';
import {
  invoicePayload,
  invoiceCommitment,
  type InvoicePayload,
  type InvoiceConfirmation,
  type SavedInvoice,
} from '../../shared/invoices';
import type { StoredDocument } from '../../server/documents';
import { Badge } from '../components/primitives';
import './invoice-review.css';

function encode(bytes: Uint8Array) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768)
    text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}
export function InvoiceReview({
  order,
  deployment,
  account,
  confirmations,
  busy,
  operatorReady,
  liveAiAvailable,
  onBusy,
  request,
  onConfirm,
  onPayment,
}: {
  order: ChainOrder;
  deployment: Deployment;
  account: string;
  confirmations: InvoiceConfirmation[];
  busy: boolean;
  operatorReady: boolean;
  liveAiAvailable: boolean;
  onBusy: (busy: boolean) => void;
  request: (path: string, body?: unknown) => Promise<unknown>;
  onConfirm: (invoice: InvoicePayload) => Promise<void>;
  onPayment: (invoice: InvoicePayload, quantity: string) => Promise<void>;
}) {
  const [text, setText] = useState(''),
    [document, setDocument] = useState<StoredDocument | null>(null),
    [selection, setSelection] = useState<SavedInvoice | null>(null),
    [saved, setSaved] = useState<SavedInvoice[]>([]);
  const [source, setSource] = useState<'upload' | 'text'>('upload'),
    [preview, setPreview] = useState(true),
    [commitment, setCommitment] = useState(''),
    [quantity, setQuantity] = useState(chainAvailable(order).toString()),
    [checked, setChecked] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const payload = useMemo(() => selection?.payload ?? null, [selection]);
  const approved = Boolean(commitment && confirmations.some((c) => c.commitment === commitment));
  const base = `/orders/${encodeURIComponent(order.id)}`;
  function changeSource(next: 'upload' | 'text') {
    if (next !== source) {
      setSource(next);
      setDocument(null);
      setSelection(null);
      setText('');
      setChecked(false);
    }
  }
  useEffect(() => {
    let current = true;
    setCommitment('');
    if (payload)
      void invoiceCommitment(deployment.network, deployment.vault, payload).then((hash) => {
        if (current) setCommitment(hash);
      });
    return () => {
      current = false;
    };
  }, [payload, deployment.network, deployment.vault]);
  async function run(action: () => Promise<void>) {
    onBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'This action could not be completed.');
    } finally {
      onBusy(false);
    }
  }
  function selected(record: SavedInvoice) {
    setSelection(record);
    setText(record.sourceText);
    setChecked(false);
    setQuantity(
      (chainAvailable(order) < BigInt(record.payload.quantity)
        ? chainAvailable(order)
        : BigInt(record.payload.quantity)
      ).toString(),
    );
  }
  async function upload(file: File) {
    if (file.size > 2 * 1024 * 1024) throw Error('Upload a file no larger than 2 MB.');
    const mediaType =
      file.type ||
      (/\.pdf$/i.test(file.name)
        ? 'application/pdf'
        : /\.png$/i.test(file.name)
          ? 'image/png'
          : 'image/jpeg');
    const data = (await request(`${base}/documents`, {
      name: file.name,
      mediaType,
      bytesBase64: encode(new Uint8Array(await file.arrayBuffer())),
    })) as StoredDocument;
    setDocument(data);
    setText(data.text);
    setSelection(null);
    setSource('upload');
    setPreview(true);
  }
  async function pick(record: SavedInvoice) {
    selected(record);
    setDocument(null);
    if (record.documentId) {
      const doc = (await request(`${base}/documents/${record.documentId}`)) as StoredDocument;
      setDocument(doc);
      setSource('upload');
    } else setSource('text');
  }
  function pickConfirmed(record: InvoiceConfirmation) {
    const i = record.invoice;
    selected({
      id: record.commitment,
      orderId: order.id,
      mode: 'live',
      invoice: {
        orderId: order.id,
        reference: i.reference,
        lineId: i.line_id,
        quantity: Number(i.quantity),
        token: 'aUSD',
        amountBaseUnits: i.amount,
      },
      documentHash: i.document_hash,
      model: null,
      recordedAt: '',
      providerRequestId: null,
      payload: i,
      documentId: null,
      sourceText: '',
    });
    setDocument(null);
    setSource('text');
  }
  async function extract() {
    const result = (await request(
      `${base}/extract`,
      document ? { documentId: document.id, mode: 'live' } : { text, mode: 'live' },
    )) as Extraction & Partial<SavedInvoice>;
    const record: SavedInvoice = {
      ...result,
      payload: result.payload ?? invoicePayload(order, result),
      documentId: result.documentId ?? document?.id ?? null,
      sourceText: result.sourceText ?? text,
    };
    selected(record);
    setSaved((rows) => [record, ...rows.filter((r) => r.id !== record.id)]);
  }
  async function download() {
    if (!document) return;
    const file = (await request(
      `${base}/documents/${document.id}?download=1`,
    )) as StoredDocument & { bytesBase64: string };
    const blob = new Blob([Uint8Array.from(atob(file.bytesBase64), (c) => c.charCodeAt(0))], {
      type: file.mediaType,
    });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const validQuantity =
    /^[1-9]\d{0,18}$/.test(quantity) &&
    payload &&
    BigInt(quantity) <= BigInt(payload.quantity) &&
    BigInt(quantity) <= chainAvailable(order);
  return (
    <div className="invoice-center">
      <div className="invoice-library">
        <div>
          <span className="eyebrow">SUPPLIER INVOICES</span>
          <p>Review the source, then confirm the extracted fields.</p>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const data = (await request(`${base}/invoices`)) as { invoices: SavedInvoice[] };
              setSaved(data.invoices);
              if (!data.invoices.length) setNotice('No saved invoice reviews yet.');
            })
          }
        >
          Load saved invoices
        </button>
      </div>
      {saved.length > 0 && (
        <div className="invoice-records" aria-label="Saved invoice reviews">
          {saved.map((record) => (
            <button
              key={record.id}
              disabled={busy}
              aria-pressed={selection?.id === record.id}
              onClick={() => run(() => pick(record))}
            >
              <FileText size={15} />
              <span>
                {record.invoice.reference}
                <small>{record.documentId ? 'Uploaded document' : 'Invoice text'}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      {!saved.length && confirmations.length > 0 && (
        <div className="invoice-records" aria-label="Confirmed invoices">
          {confirmations.map((record) => (
            <button
              key={record.commitment}
              disabled={busy}
              aria-pressed={commitment === record.commitment}
              onClick={() => pickConfirmed(record)}
            >
              <Check size={15} />
              <span>
                {record.invoice.reference}
                <small>Supplier confirmed</small>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="invoice-review invoice-center-grid">
        <div className="invoice-document">
          <div className="invoice-source-tabs" role="group" aria-label="Invoice source">
            <button
              disabled={busy}
              aria-pressed={source === 'upload'}
              onClick={() => changeSource('upload')}
            >
              PDF or scan
            </button>
            <button
              disabled={busy}
              aria-pressed={source === 'text'}
              onClick={() => changeSource('text')}
            >
              Invoice text
            </button>
          </div>
          {source === 'upload' ? (
            document ? (
              <>
                <div className="uploaded-document-heading">
                  <span title={document.name}>
                    {document.name}
                    <small>
                      {document.pages} page{document.pages === 1 ? '' : 's'} ·{' '}
                      {document.source === 'ocr' ? 'OCR' : 'PDF text'}
                    </small>
                  </span>
                  <button
                    className="icon-button"
                    aria-label="Download original invoice"
                    disabled={busy}
                    onClick={() => run(download)}
                  >
                    <Download size={17} />
                  </button>
                </div>
                <div className="invoice-source-tabs">
                  <button aria-pressed={preview} onClick={() => setPreview(true)}>
                    Preview
                  </button>
                  <button aria-pressed={!preview} onClick={() => setPreview(false)}>
                    Extracted text
                  </button>
                </div>
                {preview ? (
                  <img
                    className="invoice-page-preview"
                    src={`data:${document.previewType};base64,${document.previewBase64}`}
                    alt={`First page of ${document.name}`}
                  />
                ) : (
                  <textarea aria-label="Extracted document text" readOnly value={document.text} />
                )}
                <label className="replace-invoice">
                  Choose another file
                  <input
                    type="file"
                    aria-label="Replace invoice file"
                    accept=".pdf,.png,.jpg,.jpeg"
                    disabled={busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void run(() => upload(file));
                    }}
                  />
                </label>
              </>
            ) : (
              <label
                className={`invoice-upload ${busy ? 'processing' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files[0];
                  if (file && !busy) void run(() => upload(file));
                }}
              >
                <Upload size={26} />
                <strong>{busy ? 'Reading your document…' : 'Upload an invoice'}</strong>
                <span>PDF, PNG or JPEG · up to 2 MB</span>
                <small>Up to five pages. English scanned text is supported.</small>
                <input
                  type="file"
                  aria-label="Upload invoice file"
                  accept=".pdf,.png,.jpg,.jpeg"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void run(() => upload(file));
                  }}
                />
              </label>
            )
          ) : (
            <textarea
              aria-label="Invoice source text"
              placeholder="Paste the supplier invoice text here…"
              value={text}
              readOnly={Boolean(document)}
              onChange={(e) => {
                setText(e.target.value);
                setSelection(null);
              }}
            />
          )}
          {document && (
            <p className="field-note">
              Original files are available for seven days. Review all pages before confirmation.
            </p>
          )}
        </div>
        <div className="extracted-fields">
          {selection && payload ? (
            <>
              <div className="invoice-field-heading">
                <span className="eyebrow">REVIEWED FIELDS</span>
                <Badge tone={approved ? 'green' : 'amber'}>
                  {approved ? 'Supplier confirmed' : 'Awaiting supplier confirmation'}
                </Badge>
              </div>
              <h3>{payload.reference}</h3>
              <dl>
                <div>
                  <dt>Purchase order</dt>
                  <dd>{payload.order_id}</dd>
                </div>
                <div>
                  <dt>Line</dt>
                  <dd>{payload.line_id}</dd>
                </div>
                <div>
                  <dt>Invoiced quantity</dt>
                  <dd>
                    {payload.quantity} {order.terms.unit}
                  </dd>
                </div>
                <div>
                  <dt>Invoice amount</dt>
                  <dd>{money(payload.amount)} aUSD</dd>
                </div>
                <div>
                  <dt>Fixed payout</dt>
                  <dd>{order.terms.payout}</dd>
                </div>
              </dl>
              {approved ? (
                <>
                  <label className="field">
                    Quantity to pay
                    <input
                      type="number"
                      min="1"
                      max={(chainAvailable(order) < BigInt(payload.quantity)
                        ? chainAvailable(order)
                        : BigInt(payload.quantity)
                      ).toString()}
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      disabled={busy || account !== order.terms.operator}
                    />
                  </label>
                  <p className="field-note">
                    Eligible now: {chainAvailable(order).toString()} {order.terms.unit}. The
                    contract checks both the confirmed invoice and delivery limits.
                  </p>
                  {account === order.terms.operator && (
                    <button
                      className="button primary full"
                      disabled={busy || !operatorReady || !validQuantity}
                      onClick={() =>
                        run(async () => {
                          await onPayment(payload, quantity);
                          setNotice('Payment requested. The order shows its settlement result.');
                        })
                      }
                    >
                      Authorize bounded request
                      <ArrowUpRight size={15} />
                    </button>
                  )}
                </>
              ) : account === order.terms.supplier ? (
                <>
                  <label className="invoice-confirm">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => setChecked(e.target.checked)}
                    />
                    I reviewed these fields against the invoice. The confirmed fields and document
                    hash will be public on NEAR.
                  </label>
                  <button
                    className="button primary full"
                    disabled={busy || !checked || !commitment}
                    onClick={() =>
                      run(async () => {
                        await onConfirm(payload);
                        setChecked(false);
                        setNotice('Supplier confirmation recorded on NEAR.');
                      })
                    }
                  >
                    Confirm invoice
                    <Check size={15} />
                  </button>
                </>
              ) : (
                <p className="field-note">
                  The supplier must confirm these fields before payment can be authorized.
                </p>
              )}
              <div className="invoice-commitment">
                <span>Document SHA-256</span>
                <code>{payload.document_hash}</code>
              </div>
            </>
          ) : (
            <div className="extraction-empty">
              <FileText size={28} />
              <h3>Review the invoice</h3>
              <p>Upload a document or paste its text to extract the fields.</p>
            </div>
          )}
        </div>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="alert success" role="status">
          {notice}
        </div>
      )}
      <div className="modal-actions">
        <span className="field-note">Supplier approval is required before payment.</span>
        <button
          className="button secondary"
          disabled={busy || !liveAiAvailable || !text.trim()}
          onClick={() => run(extract)}
        >
          <FileText size={15} />
          {busy ? 'Processing…' : 'Extract invoice'}
        </button>
      </div>
    </div>
  );
}
