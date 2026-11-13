# Accord screenshot demo

Publish the main post yourself and attach the four numbered images. Use its public X URL as the demo-post link in the application. A video is optional for this hosted demo. Nothing in this pack has been posted or submitted.

## Main post

```text
Supplier payments should follow the goods.

I built Accord at NEAR HACKATHON. Confirm delivery and the invoice; NEAR enforces what can be paid in USDC.

What would your team need?
https://accord-payments.vercel.app
https://github.com/Pelz01/accord
@NEARProtocol #NEARHackathon
```

## Attach in this order

1. Order and payment: two cartons ordered, one delivered and paid, no payment pending, order closed.
2. Remittance advice: confirmed 0.01 USDC supplier payment, linked invoice and transaction reference.
3. Refunds: unused 0.01 USDC returned to the buyer, plus unused native storage allowance. Retained records remain backed.
4. Intents: the buyer's NEAR-to-USDC funding request completed. The finalized receipt records 0.033796 USDC received for 0.01 NEAR; the screenshot's Expected amount is the original quote, not the actual received amount.

## Optional follow-up post: product workflow

```text
In Accord, the buyer confirms delivery and the supplier confirms the invoice. NEAR AI prepares invoice fields for review; it cannot approve spending. The worker requests payment within the contract's limits.

@NEARProtocol #NEARHackathon
```

## Optional follow-up post: verified mainnet result

```text
Mainnet check: 0.02 USDC funded, 0.01 paid for one carton, and the unused 0.01 refunded. NEAR Intents also converted 0.01 NEAR into 0.033796 USDC in the buyer wallet. Order funding is a separate approval.

@NEARProtocol #NEARHackathon
```

## Image descriptions / alt text

- Order: Accord on NEAR mainnet. PO-7886D7BD is closed. Two cartons were ordered; one was accepted and paid. Pending quantity is zero. A 0.01 USDC payment is settled.
- Receipt: Accord remittance advice for PO-7886D7BD. Confirmed supplier payment of 0.01 USDC for one carton, with invoice ACC-MAINNET-7886D7BD-1 and a mainnet transaction reference.
- Refunds: Closed Accord order showing 0.01 USDC returned to mainnett12.near. Unused native storage allowance was also returned; 0.0310375 NEAR remains for retained records and their buffer.
- Intents: Accord's Add USDC dialog for mainnett12.near. Input 0.01 NEAR, quoted minimum 0.033461 USDC, and a USDC received confirmation with deposit and destination receipt links.
- Optional landing image: Accord's public landing page, headed Keep business moving, with links to open the workspace and learn how purchase orders, deliveries and supplier payments fit together. The landing visual is an interactive product illustration; the numbered images show the actual mainnet check.

## Evidence and limits

The four images show recorded results from controlled accounts, not a full recording of every action. The source receipts, live mainnet order, AI extraction metadata and testnet PDF/OCR evidence are indexed in materials.json and JUDGE.md. The Intents check used NEAR as its origin on NEAR mainnet; no origin on another chain is claimed. This release has not received an external security audit.

Rules checked on 13 November 2026, Africa/Lagos: https://nearhackathon.com/HACKATHON.md
