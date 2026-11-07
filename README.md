# Accord

**Keep business moving.**

Orders, deliveries and payments, brought together. Less chasing. More progress.

Accord keeps buying teams and suppliers on the same page, from the first order to the final payment. AI prepares invoice details for review. Suppliers confirm them, receivers record deliveries, and the NEAR contract keeps each payment within what was agreed and received.

The hosted product is [accord-payments.vercel.app](https://accord-payments.vercel.app). It includes a public landing page and a wallet-gated procurement workspace. **The current chain deployment is NEAR testnet.** Wallet transactions, token transfers, contract callbacks, and the restricted operator have been exercised on testnet. Mainnet follows the remaining validation gates; it has not been deployed.

## Run

Requires Node 24.12.0 (or a compatible Node 24 release). Document processing also needs Poppler and Tesseract in Linux. On Windows, the development document worker uses Ubuntu/WSL (override its distribution with ACCORD_DOCUMENT_WSL). The hosted document tools are installed in their own image.

```sh
npm ci
npm run dev
```

For Linux/WSL document tools, install poppler-utils, tesseract-ocr and tesseract-ocr-eng. The development command starts the API, frontend and document worker.

Open http://127.0.0.1:5173 for development. The landing page links to /workspace. Before connection, users see only the wallet gate. Connected wallets see orders where they are buyer, supplier, receiver, operator, or payout recipient. This filtering organizes public onchain records; it is not an onchain privacy mechanism.

To read the existing testnet deployment, copy fixtures/testnet-deployment.json to ignored .data/deployment.json. New installations do not receive another user's wallet or signing keys. The development server reads its restricted operator key from .data/operator-key.json when present. Keys and databases stay ignored.

## Payment flow

1. Buyer creates an order with fixed terms; supplier accepts its terms hash.
2. Buyer registers the necessary token accounts and funds the exact order amount.
3. Receiver confirms a strictly increasing cumulative accepted quantity.
4. Upload a PDF or scan, or paste invoice text. NEAR AI extracts fields and the application checks them against the order.
5. The supplier reviews and confirms those exact fields and the document hash on NEAR.
6. The operator authorizes an eligible partial request referencing that confirmation. The durable worker uses a key scoped to request_payment; the private contract callback determines settlement.

```text
paid + pending <= accepted <= ordered
available = accepted - paid - pending
payment amount = requested quantity × agreed unit price
```

The payment agent cannot change recipients, prices, accepted terms, or delivery records. Each request ID is consumed once. Definite transfer failure releases capacity only when its callback completes. An uncertain callback retains the reservation.

## Invoice extraction

Set NEAR_AI_API_KEY in ignored .env to enable server-side NEAR AI Cloud extraction. The connected product accepts invoice text and uses the live adapter; it does not substitute generated sample results. The response must match a strict schema and the order's fixed fields. Live extraction and the running app endpoint have been verified using GLM-5.3 Flash. The sanitized real response, input hash, and provider request IDs are recorded in fixtures/near-ai-extraction.json. The request uses JSON mode; schema and fixed-order checks remain independent of the model. Incomplete or mismatched invoices fail review. PDF, PNG and JPEG uploads are supported up to 2 MB; PDFs may contain at most five pages. Poppler extracts PDF text and Tesseract reads English scans in an isolated container with no signing or AI credentials and no internet access. The original file stays on the VPS; only extracted text is sent to NEAR AI. Originals are available to authenticated order members for seven days.

The supplier confirms a canonical UTF-8 JSON array covering network, vault, order, terms version/hash, document SHA-256, invoice reference, line, quantity, token contract and amount. The Rust contract recomputes the same hash and every new payment requires a stored supplier confirmation. Changing any field requires fresh confirmation. The pinned cross-language vector is fixtures/invoice-canonical.json. This is simple supplier confirmation, with no separate invoice paid/pending ledger or semantic duplicate detection.

The default NEAR_AI_MODEL is z-ai/glm-5.3-flash. To repeat the explicit live check, run npx tsx scripts/near-ai-smoke.ts --http --negative with the API server running. This makes real provider requests and rewrites the synthetic-input evidence fixture. Ordinary unit tests replay the captured response without contacting the provider.

## Code and verification

- src/landing: marketing page, interactive product visual, and original generated photography.
- src/testnet: wallet connection, contract reads, order creation, acceptance, funding, delivery, invoice review, payment authorization, payables and supplier overviews, payment history, remittance advice and CSV exports.
- contracts/vault: Rust payment boundary and private asynchronous callbacks.
- contracts/test-token: six-decimal aUSD using the NEAR standard FT implementation.
- server: separate development and production Fastify entries, durable SQLite jobs, wallet sessions, invoice quotas, and extraction.
- api/proxy.ts and deploy/: Vercel frontend proxy, isolated VPS container, HTTPS route, persistent database, and daily backups.
- cloud, drizzle: optional earlier Sites Worker/D1 target; unused by the active Vercel/VPS deployment.
- sandbox: real disposable NEAR node tests, separate from browser tests.

```sh
npm run check
npx playwright install chromium
npm run test:ui
cargo test --locked -p accord-vault
bash sandbox/build.sh
cd sandbox
npm ci
npm test
```

Checks run on the development machine. GitHub Actions is disabled for this repository; pushes do not start remote checks.

npm run build produces the frontend in dist and the VPS API in dist-api. The separate optional build:sites command produces the earlier Worker target. The build excludes the internal simulator from the production JavaScript. The development-only /dev/simulator route is an isolated deterministic test harness with an actor selector; its tests do not count as wallet authorization or chain evidence. It has no customer navigation.

Rust is pinned to 1.99.1; Windows contract development uses Ubuntu/WSL. The sandbox uses pinned nearcore 2.14.0. Its negative-test fault-injection build must never be deployed. The build script restores the ordinary artifact afterward.

## Hosted operations

The frontend runs on Vercel. Its small server-side proxy forwards API requests over HTTPS to the VPS using a secret origin credential. NEAR AI and operator credentials stay on the VPS; Vercel receives only its proxy credential and API base URL. GitHub Actions and Git-triggered Vercel deployments are disabled. Releases are deployed manually.

The VPS installation is isolated under /home/ubuntu/accord:

| Folder  | Contents                                              |
| ------- | ----------------------------------------------------- |
| app     | Application source and deployment files               |
| data    | Persistent accord.sqlite database                     |
| config  | Public NEAR testnet deployment configuration          |
| secrets | Protected API environment and restricted operator key |
| backups | Verified SQLite snapshots and deployment backups      |

The API container is accord-api, bound to loopback port 8794. The accord-documents container is reachable only through its internal Docker network, has no published port or credential mounts, and is limited to one CPU and 512 MB of memory. It uses Node 24.22.2 from a pinned official image, a non-root user, a read-only root filesystem, and a restart policy. The HTTPS gateway forwards only /accord/api/. Daily backups run through accord-backup.timer; accord-backup.service can be started manually. Both source units are in deploy/.

From the VPS app directory, use docker compose -f deploy/compose.yaml ps or docker compose -f deploy/compose.yaml logs --tail 50 api for status. Never publish the secrets folder or a full container environment dump.

Invoice processing requires a one-time NEP-413 wallet sign-in, an unexpired 30-minute session, and membership in the purchase order. Only a session hash is stored. Uploads and AI extraction share limits of five requests per order per minute, 100 per order per UTC day, and 1,000 globally per UTC day. Private reads require order membership and do not consume that processing quota. Payment requests keep their separate operator authorization and contract limits. Transaction hashes are stored before broadcast; uncertain requests are reconciled without blind retries.

The hosted integration verified real wallet signatures, live AI, a 300 aUSD testnet payment, restart persistence, and database backups. See fixtures/hosted-evidence.json. npm run verify:hosted is an explicit live test using the ignored development wallet credentials. It recovers an existing request rather than paying twice; ordinary unit tests make no live provider or blockchain writes.

## Payables and reporting

The connected workspace opens Payables for buyers or Supplier view for supplier/payout-only accounts. Overview and Supplier navigation let an account inspect each role separately. These views show ready-for-review, invoice-review, in-progress, remaining commitments, accepted deliveries, payments and refunds. A ready amount requires accepted goods, full funding, an open order and a matching supplier-confirmed invoice. Pending transfers and queued/uncertain worker requests hold capacity; review-held money is a subset of in-progress money. Remaining commitments subtract paid and refunded amounts. Confirmations are not summed into an invoice balance: the largest valid confirmation caps a new individual request, while the contract remains authoritative.

Open Payments, then Remittance advice on a confirmed payment. Advice records the actual recipient, quantity, amount, order, recorded invoice reference and available receipt. Contract settlement and recipient acknowledgment are labeled separately. Pending requests cannot produce final advice. Print / Save PDF uses the browser print dialog; unknown invoice references, request dates or transaction hashes are not invented. Stable links use /workspace?view=overview, /workspace?view=supplier and /workspace?view=payments&payment=REQUEST_ID.

Export CSV downloads the currently filtered orders and their associated payments or refunds; Payments also exports its filtered list. Amounts use exact decimal strings with token identity and up to six decimal places, timestamps are UTC, missing metadata stays blank, and untrusted spreadsheet formulas are neutralized. Reports read the existing capped source: up to 50 listed orders and the latest 100 known request IDs. Incomplete coverage is shown in the workspace and CSV; these are scoped snapshots, not a complete accounting indexer. Application checks cover 42 tests; 19 isolated Playwright journeys include role scoping, totals, exports, advice guards, printing, deep links and mobile layouts.

On small screens, order cards show balances, delivery progress and status without horizontal scrolling. The single wallet control at the top opens the full connected account and Disconnect; keyboard Escape closes the menu. Order creation defaults to paying the supplier account, with an explicit separate-account option. The form shows an exact order total, the full configured operator, separate-role requirement, non-refundable storage deposit and refund conditions before creation. Nineteen browser journeys cover these flows, including 320–1024 px form layouts and exact wallet-call arguments for both payout choices.

## Current scope

The current release supports one line per order, integer quantities, fixed six-decimal test-token amounts, exact funding, partial deliveries and payments, bounded attempts, and distinct role accounts. Creation retains 1 native NEAR for bounded storage/outgoing call deposits separately from token funding.

Closure and token refunds are implemented on testnet. Buyer and supplier approve the same 24-hour state snapshot after all accepted deliveries are paid and no transfer is unresolved. The order freezes before dispatch; unused tokens return only to the original buyer. A definite failed refund can be retried. Missing callbacks keep their reservation until the actual recipient explicitly acknowledges receipt; acknowledgment consumes it as paid and never reopens spending capacity. Unreceived, ambiguous transfers remain reserved. The native 1 NEAR storage/call deposit is retained.

The real testnet check refunded 300 aUSD on PO-TESTNET-001. See fixtures/recovery-testnet-evidence.json and fixtures/recovery-sandbox-evidence.json. The explicit npm run verify:recovery:testnet command verifies the tested artifact, upgrades the generated testnet vault if needed, and closes that known order; repeat runs read its existing refund. It never deploys the callback-starvation artifact.

Supplier invoice confirmation and PDF/OCR are implemented and verified through the hosted app. The live check processed both a text PDF and a scanned PDF with real NEAR AI extraction, confirmed the scanned invoice through the supplier account, rejected missing/tampered confirmations, and settled another 100 aUSD. PO-WORKER-001 now has paid quantity 80 and pending 0. See fixtures/invoice-release-evidence.json.

Run npm run verify:documents in Linux/WSL for seven native file checks. npm run verify:invoices:testnet is an explicit live test using ignored generated credentials; it verifies all three sandbox artifact hashes before upgrading and recovers the existing request on repeat runs. Mainnet still requires network integration, independent recovery/storage/upgrade review, production token validation, and a complete real-wallet browser journey. Submission drafts are in submission/materials.json; recording, public posting and actual submission remain pending.

A real Intear buyer wallet has now created and funded a 100 aUSD order through the hosted browser, authenticated a scanned-invoice upload, and approved closure after a 40 aUSD partial payment. The remaining 60 aUSD returned to the buyer; the order is Closed with no pending amount. Supplier, receiver and operator actions in this check used companion SDK accounts. Their full browser signing journeys remain pending. See fixtures/browser-wallet-evidence.json. Expired wallet sessions return to Connect wallet, covered by two new browser checks; 19 browser checks pass.

Target: ready before 10 November 2026, meaning by the end of 9 November in Lagos. See [JUDGE.md](JUDGE.md), [SECURITY.md](SECURITY.md), and [FOUNDATION.md](FOUNDATION.md) for reproduction, authority boundaries, and executed evidence. MIT licensed. Built for the NEAR Hackathon.
