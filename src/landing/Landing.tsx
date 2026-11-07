import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  FileCheck2,
  FileText,
  LockKeyhole,
  Menu,
  Minus,
  PackageCheck,
  Plus,
  ShieldCheck,
  X,
} from 'lucide-react';
import '@fontsource/bodoni-moda/latin-400-italic.css';
import './landing.css';
import './product-art.css';

const vault = 'vault.accord-v2-8e0a631d.testnet';
const contractUrl = `https://testnet.nearblocks.io/address/${vault}`;
const firstPayment =
  'https://testnet.nearblocks.io/txns/GTntahDMfctnQyW8UauV2t7vF27swdgFh98jrw1f63tQ';
function Brand({ light = false }: { light?: boolean }) {
  return (
    <a className={`landing-brand ${light ? 'light' : ''}`} href="/" aria-label="Accord home">
      <span className="brand-symbol">
        <i />
        <i />
      </span>
      accord<span>.</span>
    </a>
  );
}

function ProductIllustration() {
  const [accepted, setAccepted] = useState(40),
    [paid, setPaid] = useState(0),
    [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const eligible = accepted - paid;
  function settle() {
    if (!eligible || pending) return;
    setPending(true);
    const quantity = eligible;
    timer.current = setTimeout(() => {
      setPaid((v) => v + quantity);
      setPending(false);
    }, 1100);
  }
  return (
    <div className="product-stage" id="product">
      <img
        className="product-backdrop"
        src="/images/accord-commerce.jpg"
        alt=""
        fetchPriority="high"
      />
      <div className="product-window">
        <aside className="product-mini-sidebar">
          <Brand />
          <div className="mini-workspace">
            <span>M</span>Meridian workspace
          </div>
          <div className="mini-nav selected">
            <FileText size={15} />
            Purchase orders
          </div>
          <div className="mini-nav">
            <ArrowUpRight size={15} />
            Payments
          </div>
          <div className="mini-nav">
            <ShieldCheck size={15} />
            Controls
          </div>
          <div className="mini-sidebar-note">
            <LockKeyhole size={14} />
            Bound by your agreement
          </div>
        </aside>
        <div className="product-main">
          <div className="product-breadcrumb">
            Purchase orders
            <ChevronRight size={12} />
            <span>PO-0001</span>
            <div className="product-window-mark">ACCORD</div>
          </div>
          <div className="product-title">
            <div>
              <span className="product-id">PURCHASE ORDER / 0001</span>
              <h3>Meridian Supply Co.</h3>
            </div>
            <span className="product-status">
              <span />
              {pending ? 'Processing payment' : eligible > 0 ? 'Ready to pay' : 'Up to date'}
            </span>
          </div>
          <div className="product-budget">
            <div>
              <span>Order value</span>
              <strong>
                1,000<small>aUSD</small>
              </strong>
            </div>
            <div>
              <span>Paid to supplier</span>
              <strong>
                {paid * 10}
                <small>aUSD</small>
              </strong>
            </div>
            <div className="product-budget-eligible">
              <span>Eligible to pay</span>
              <strong>
                {pending ? 0 : eligible * 10}
                <small>aUSD</small>
              </strong>
            </div>
          </div>
          <div className="product-table">
            <div className="product-table-head">
              <span>ORDER DETAILS</span>
              <span>Fixed price · aUSD</span>
            </div>
            <div className="product-table-labels">
              <span>Item</span>
              <span>Ordered</span>
              <span>Accepted</span>
              <span>Paid</span>
            </div>
            <div className="product-table-line">
              <div>
                <span className="package-box">
                  <PackageCheck size={19} />
                </span>
                <div>
                  Packing cartons<small>10 aUSD per carton</small>
                </div>
              </div>
              <span>100</span>
              <span>{accepted}</span>
              <span>{paid}</span>
            </div>
          </div>
          <div className="product-confirmation">
            <div>
              <span className="product-confirmation-icon">
                <ShieldCheck size={19} />
              </span>
              <div>
                <strong>
                  {pending
                    ? 'Payment reserved'
                    : eligible
                      ? `${eligible} cartons earned. ${eligible * 10} tokens eligible.`
                      : 'Every accepted carton is paid.'}
                </strong>
                <p>
                  {pending
                    ? 'Entitlement is reserved while the outcome is checked.'
                    : `Fixed recipient · supplier.testnet · ${100 - accepted} cartons awaiting delivery`}
                </p>
              </div>
            </div>
            <button onClick={settle} disabled={pending || eligible === 0}>
              {pending ? <span className="landing-spinner" /> : <ArrowUpRight size={14} />}
              <span>{pending ? 'Processing' : eligible ? 'Preview payment' : 'Settled'}</span>
            </button>
          </div>
        </div>
      </div>
      <div className="stage-controls">
        <label htmlFor="hero-delivery">
          Try a partial delivery
          <span>
            Accepted: <strong>{accepted} / 100</strong>
          </span>
        </label>
        <input
          id="hero-delivery"
          aria-label="Example accepted cartons"
          type="range"
          min={Math.max(paid, 1)}
          max={100}
          value={accepted}
          disabled={pending}
          onChange={(e) => setAccepted(Number(e.target.value))}
        />
        <button
          onClick={() => {
            if (timer.current) clearTimeout(timer.current);
            setAccepted(40);
            setPaid(0);
            setPending(false);
          }}
        >
          Reset example
          <ArrowRight size={12} />
        </button>
      </div>
      <div className="floating-receipt" aria-hidden="true">
        <div className="floating-receipt-heading">
          <FileCheck2 size={18} />
          <span>DELIVERY RECEIPT</span>
          <Check size={15} />
        </div>
        <strong>{accepted} cartons</strong>
        <p>Accepted by the receiver</p>
        <div className="receipt-rule" />
        <div className="receipt-match">
          <span>Matched to order</span>
          <span>PO-0001</span>
        </div>
        <span className="receipt-stamp">ACCEPTED</span>
      </div>
    </div>
  );
}

const steps = [
  {
    number: '01',
    title: 'Agree before anything moves.',
    body: 'The buyer sets the order, price, and authorities. The supplier accepts the same terms and fixed payout account.',
    icon: FileCheck2,
    tag: 'A shared commitment',
  },
  {
    number: '02',
    title: 'Confirm what actually arrived.',
    body: 'Your receiver records accepted goods as a cumulative total. A partial delivery creates a partial entitlement.',
    icon: PackageCheck,
    tag: 'Delivery creates entitlement',
  },
  {
    number: '03',
    title: 'Pay the amount that’s earned.',
    body: 'The agent reads the invoice and requests an eligible payment. The contract checks the numbers before transferring tokens.',
    icon: ArrowUpRight,
    tag: 'The contract has the final say',
  },
];
const questions = [
  {
    q: 'What does the AI agent actually control?',
    a: 'The operator can request payment for accepted, unpaid, unreserved quantities at the fixed order price. It cannot approve its own order, confirm a delivery, change prices, or select a different payout account.',
  },
  {
    q: 'How do I get started?',
    a: 'Connect your NEAR wallet, create a purchase order, and invite the supplier to accept its terms. Once the order is funded, accepted deliveries determine how much the payment agent can request.',
  },
  {
    q: 'What happens when the same payment is requested twice?',
    a: 'Each onchain request ID is used once. Pending quantities are reserved before a transfer, so concurrent requests cannot spend the same order entitlement. Invoice records remain audit references; the order’s accepted entitlement is the financial boundary.',
  },
  {
    q: 'Can the agent change the agreed payout?',
    a: 'No. The supplier accepts a fixed payout account as part of the order. The payment agent cannot replace that recipient, change the unit price, or grant itself delivery authority.',
  },
  {
    q: 'Why build this on NEAR?',
    a: 'Accepted terms, funding, delivery quantities, and payment reservations are held in a shared contract. A restricted function-call key lets the operator request payments without authority to change the agreement. You can inspect the contract and its payment records.',
  },
];

export function Landing() {
  const [menu, setMenu] = useState(false),
    [activeStep, setActiveStep] = useState(0),
    [openQuestion, setOpenQuestion] = useState<number | null>(0);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const elements = root.current?.querySelectorAll('.landing-reveal');
    if (!elements) return;
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        }),
      { threshold: 0.12 },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);
  return (
    <div className="landing" ref={root}>
      <div className="landing-announcement">
        <span>Business, in accord.</span>
        <span className="announcement-divider" />
        <a href={contractUrl} target="_blank" rel="noreferrer">
          Explore the payment trail
          <ArrowUpRight size={12} />
        </a>
      </div>
      <header className="landing-header">
        <div className="landing-nav">
          <Brand />
          <nav aria-label="Website navigation" className={menu ? 'open' : ''}>
            <a href="#product" onClick={() => setMenu(false)}>
              Product
            </a>
            <a href="#how-it-works" onClick={() => setMenu(false)}>
              How it works
            </a>
            <a href="#safeguards" onClick={() => setMenu(false)}>
              Safeguards
            </a>
            <a href="#questions" onClick={() => setMenu(false)}>
              Questions
            </a>
          </nav>
          <div className="landing-nav-actions">
            <a className="landing-login" href="/workspace">
              Sign in
              <ArrowUpRight size={13} />
            </a>
            <a className="landing-button dark small" href="/workspace">
              Open workspace
              <ArrowUpRight size={14} />
            </a>
            <button
              className="landing-menu"
              aria-label={menu ? 'Close navigation' : 'Open navigation'}
              aria-expanded={menu}
              onClick={() => setMenu((v) => !v)}
            >
              {menu ? <X size={21} /> : <Menu size={21} />}
            </button>
          </div>
        </div>
      </header>
      <main className="landing-main">
        <section className="landing-hero">
          <div className="hero-kicker">
            <span className="landing-dot" />
            BUY. RECEIVE. PAY.
          </div>
          <h1>
            Keep business <br />
            <em>moving.</em>
          </h1>
          <p className="hero-description">
            Orders, deliveries and payments, brought together. <br />
            Less chasing. More progress.
          </p>
          <div className="hero-actions">
            <a className="landing-button dark" href="/workspace">
              Explore the workspace
              <ArrowUpRight size={17} />
            </a>
            <a className="landing-button text" href="#how-it-works">
              See how it works
              <ArrowDown size={15} />
            </a>
          </div>
          <ProductIllustration />
        </section>
        <div className="landing-proof-strip">
          <p>
            Real enforcement.
            <br />
            <strong>Evidence you can inspect.</strong>
          </p>
          <a href={contractUrl} target="_blank" rel="noreferrer">
            <span className="near-emblem">N</span>
            <span>
              NEAR TESTNET<small>Deployed payment contract</small>
            </span>
            <ArrowUpRight size={15} />
          </a>
          <a href={firstPayment} target="_blank" rel="noreferrer">
            <span className="proof-symbol">
              <ArrowUpRight size={23} />
            </span>
            <span>
              PARTIAL SETTLEMENT<small>Inspect a real 400 aUSD payment</small>
            </span>
            <ArrowUpRight size={15} />
          </a>
          <a href="https://github.com/Pelz01/accord" target="_blank" rel="noreferrer">
            <span className="proof-symbol">
              <FileText size={23} />
            </span>
            <span>
              OPEN SOURCE<small>Code and reproducible checks</small>
            </span>
            <ArrowUpRight size={15} />
          </a>
        </div>
        <section className="landing-problem landing-section landing-reveal">
          <span className="landing-section-label">A BETTER AGREEMENT</span>
          <div className="problem-layout">
            <h2>
              Goods arrive in parts.
              <br />
              Your payments
              <br />
              <em>should follow.</em>
            </h2>
            <div className="problem-copy">
              <p>
                A supplier invoices for the whole order. Only part of it has arrived. Now someone
                has to reconcile the order, the receipt, and every payment that came before.
              </p>
              <p>
                With Accord, the order, delivery record and invoice stay connected. Your team knows
                what arrived, what’s been paid, and what comes next.
              </p>
              <a href="#how-it-works" className="landing-link">
                Follow an order through Accord
                <ArrowRight size={16} />
              </a>
            </div>
          </div>
        </section>
        <section className="landing-workflow landing-section" id="how-it-works">
          <div className="workflow-heading landing-reveal">
            <div>
              <span className="landing-section-label">FROM AGREED TO PAID</span>
              <h2>
                A familiar workflow.
                <br />
                <em>A firmer foundation.</em>
              </h2>
            </div>
            <p>
              Keep people in charge of the decisions.
              <br />
              Turn invoices into a clear next step.
            </p>
          </div>
          <div className="workflow-body landing-reveal">
            <div className="workflow-steps" role="tablist" aria-label="How Accord works">
              {steps.map((step, i) => (
                <button
                  key={step.number}
                  role="tab"
                  aria-selected={activeStep === i}
                  aria-controls={`workflow-panel-${i}`}
                  id={`workflow-tab-${i}`}
                  className={activeStep === i ? 'selected' : ''}
                  onClick={() => setActiveStep(i)}
                >
                  <span className="step-number">{step.number}</span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.body}</p>
                  </div>
                  <span className="step-toggle">
                    {activeStep === i ? <Minus size={17} /> : <Plus size={17} />}
                  </span>
                </button>
              ))}
            </div>
            <div
              className={`workflow-visual visual-step-${activeStep}`}
              role="tabpanel"
              id={`workflow-panel-${activeStep}`}
              aria-labelledby={`workflow-tab-${activeStep}`}
            >
              <img
                className="workflow-photo"
                src="/images/accord-delivery.jpg"
                alt="A warehouse receiver checking a delivery beside packed cartons"
                loading="lazy"
              />
              <div className="workflow-document">
                <div className="workflow-doc-top">
                  <span className="brand-symbol">
                    <i />
                    <i />
                  </span>
                  <span>
                    {activeStep === 0
                      ? 'PURCHASE ORDER'
                      : activeStep === 1
                        ? 'ACCEPTED DELIVERY'
                        : 'PAYMENT REQUEST'}
                  </span>
                  <span>0001</span>
                </div>
                <h3>
                  {activeStep === 0
                    ? 'An agreement to build on.'
                    : activeStep === 1
                      ? '40 cartons, accounted for.'
                      : '400 tokens. Within bounds.'}
                </h3>
                <div className="workflow-doc-lines">
                  {(activeStep === 0
                    ? [
                        ['Supplier', 'Meridian Supply Co.'],
                        ['Order quantity', '100 cartons'],
                        ['Price per carton', '10 aUSD'],
                        ['Committed budget', '1,000 aUSD'],
                      ]
                    : activeStep === 1
                      ? [
                          ['Ordered', '100 cartons'],
                          ['Accepted so far', '40 cartons'],
                          ['Awaiting delivery', '60 cartons'],
                          ['Authorized receiver', 'Warehouse'],
                        ]
                      : [
                          ['Accepted entitlement', '400 aUSD'],
                          ['Already paid', '0 aUSD'],
                          ['Pending reservations', '0 aUSD'],
                          ['Eligible now', '400 aUSD'],
                        ]
                  ).map(([k, v]) => (
                    <div key={k}>
                      <span>{k}</span>
                      <strong>{v}</strong>
                    </div>
                  ))}
                </div>
                <div className="workflow-doc-stamp">
                  <Check size={14} />
                  {steps[activeStep].tag}
                </div>
              </div>
              <div className="workflow-floating-tag">
                {activeStep === 0 ? (
                  <FileCheck2 size={16} />
                ) : activeStep === 1 ? (
                  <PackageCheck size={16} />
                ) : (
                  <ShieldCheck size={16} />
                )}
                <span>
                  {activeStep === 0
                    ? 'Accepted by both parties'
                    : activeStep === 1
                      ? 'Confirmed by the receiver'
                      : 'Checked by the contract'}
                </span>
              </div>
            </div>
          </div>
        </section>
        <section className="landing-safeguards" id="safeguards">
          <div className="safeguards-inner">
            <div className="safeguards-intro landing-reveal">
              <span className="landing-section-label">AUTONOMY WITH BOUNDARIES</span>
              <h2>
                Give your agent a job.
                <br />
                <em>
                  Keep the agreement
                  <br />
                  in charge.
                </em>
              </h2>
              <p>
                The agent can interpret an invoice and ask for payment. The contract independently
                checks whether that request belongs inside your order.
              </p>
              <a href={contractUrl} className="landing-link light" target="_blank" rel="noreferrer">
                Inspect the deployed contract
                <ArrowUpRight size={16} />
              </a>
            </div>
            <div className="safeguards-list landing-reveal">
              {[
                {
                  n: '01',
                  title: 'A recipient that stays put.',
                  text: 'The payout account is fixed in the supplier-accepted terms. The operator cannot send the payment somewhere else.',
                  icon: LockKeyhole,
                },
                {
                  n: '02',
                  title: 'A limit that moves with delivery.',
                  text: 'Only accepted, unpaid, unreserved quantities are eligible. An oversized request is rejected.',
                  icon: PackageCheck,
                },
                {
                  n: '03',
                  title: 'Room for uncertainty.',
                  text: 'Pending transfers reserve their entitlement. An unclear callback outcome keeps that reservation locked.',
                  icon: ShieldCheck,
                },
              ].map((c) => (
                <div className="safeguard" key={c.n}>
                  <span>{c.n}</span>
                  <div>
                    <c.icon size={20} />
                    <h3>{c.title}</h3>
                    <p>{c.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="safeguards-watermark" aria-hidden="true">
            accord.
          </div>
        </section>
        <section className="landing-equation landing-section landing-reveal">
          <div>
            <span className="landing-section-label">THE RULE BEHIND EVERY PAYMENT</span>
            <h2>
              A little arithmetic.
              <br />
              <em>A lot of clarity.</em>
            </h2>
            <p>The contract keeps one simple relationship true for every order.</p>
          </div>
          <div className="equation-display">
            <div>
              <span>Accepted</span>
              <strong>40</strong>
            </div>
            <i>−</i>
            <div>
              <span>Paid</span>
              <strong>0</strong>
            </div>
            <i>−</i>
            <div>
              <span>Pending</span>
              <strong>0</strong>
            </div>
            <i>=</i>
            <div className="equation-result">
              <span>Eligible now</span>
              <strong>40</strong>
            </div>
            <p>At 10 aUSD per carton, that’s a 400 aUSD partial payment.</p>
          </div>
        </section>
        <section className="landing-questions landing-section" id="questions">
          <div className="questions-heading landing-reveal">
            <span className="landing-section-label">A FEW THINGS TO KNOW</span>
            <h2>
              Clear terms.
              <br />
              <em>Clear answers.</em>
            </h2>
            <p>
              A shared agreement is a better starting point.
              <br />
              Here’s how it works.
            </p>
          </div>
          <div className="questions-list landing-reveal">
            {questions.map((item, i) => (
              <div className={openQuestion === i ? 'question open' : 'question'} key={item.q}>
                <button
                  aria-expanded={openQuestion === i}
                  aria-controls={`answer-${i}`}
                  onClick={() => setOpenQuestion(openQuestion === i ? null : i)}
                >
                  {item.q}
                  {openQuestion === i ? <Minus size={17} /> : <Plus size={17} />}
                </button>
                <div id={`answer-${i}`} hidden={openQuestion !== i}>
                  <p>{item.a}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="landing-final">
          <div className="landing-final-lines" aria-hidden="true" />
          <span className="landing-section-label">LET’S GET IN AGREEMENT</span>
          <h2>
            Put your next order
            <br />
            <em>in motion.</em>
          </h2>
          <p>Bring your team and suppliers onto the same page.</p>
          <div>
            <a className="landing-button dark" href="/workspace">
              Open your workspace
              <ArrowUpRight size={17} />
            </a>
            <a className="landing-button text" href="#how-it-works">
              See how it works
              <ArrowRight size={15} />
            </a>
          </div>
        </section>
      </main>
      <footer className="landing-footer">
        <div className="landing-footer-top">
          <Brand />
          <p>
            Keep business
            <br />
            moving.
          </p>
          <nav aria-label="Footer navigation">
            <a href="#product">Product</a>
            <a href="#safeguards">Safeguards</a>
            <a href="/workspace">Workspace</a>
            <a href="https://github.com/Pelz01/accord" target="_blank" rel="noreferrer">
              GitHub
              <ArrowUpRight size={12} />
            </a>
          </nav>
        </div>
        <div className="landing-footer-bottom">
          <span>© 2026 Accord</span>
          <span>Made for better agreements.</span>
        </div>
      </footer>
    </div>
  );
}
