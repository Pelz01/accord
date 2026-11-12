# Accord

**Keep business moving.**

Manage purchase orders, confirm deliveries and pay suppliers in one place.

Accord keeps buying teams and suppliers on the same page, from the first order to the final payment. AI prepares invoice details for review. Suppliers confirm them, buyers confirm delivery, and Accord handles eligible payments within the NEAR contract’s limits. A buyer can optionally appoint someone else to confirm deliveries.

The hosted product is [accord-payments.vercel.app](https://accord-payments.vercel.app). It includes a public landing page and a wallet-gated procurement workspace. **The hosted default now uses NEAR mainnet and native USDC**, with a controlled release under the owner's 3 NEAR cap. The deployed code and restricted worker are verified; the first live USDC order has completed partial settlement, mutual closure and both token and native-deposit refunds. The existing testnet service remains separate at /workspace?network=testnet. See [mainnet release status](MAINNET_RELEASE.md) and [deployment evidence](fixtures/mainnet-deployment-evidence.json).

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
3. Buyer confirms a strictly increasing cumulative delivered quantity using the same wallet, or appoints a separate warehouse reviewer when creating the order.
4. Upload a PDF or scan, or paste invoice text. NEAR AI extracts fields and the application checks them against the order.
5. The supplier reviews and confirms those exact fields and the document hash on NEAR.
6. Accord’s durable background worker discovers the eligible payment and uses a key scoped to request_payment. The contract validates the recorded conditions and the private callback determines settlement. Customers never connect or import the service’s wallet.

New orders use create_automatic_order. Automatic execution is immutable, bound into the accepted terms hash and explained before buyer creation and supplier acceptance. Existing orders keep their manual policy and their original accepted terms; their operator NEP-413 flow remains available for compatibility. Four responsibilities do not require four customer accounts: buyer and delivery reviewer can be the same account, while the service account remains separate from buyer, supplier and reviewer.

```text
paid + pending <= accepted <= ordered
available = accepted - paid - pending
payment amount = requested quantity × agreed unit price
```

The payment agent cannot change recipients, prices, accepted terms, or delivery records. Each request ID is consumed once. Definite transfer failure releases capacity only when its callback completes. An uncertain callback retains the reservation.

## Invoice extraction

Set NEAR_AI_API_KEY in ignored .env to enable server-side NEAR AI Cloud extraction. The connected product accepts invoice text and uses the live adapter; it does not substitute generated sample results. The response must match a strict schema and the order's fixed fields. Live extraction and the running app endpoint have been verified using GLM-5.3 Flash. The sanitized real response, input hash, and provider request IDs are recorded in fixtures/near-ai-extraction.json. The request uses JSON mode; schema and fixed-order checks remain independent of the model. Incomplete or mismatched invoices fail review. PDF, PNG and JPEG uploads are supported up to 2 MB; PDFs may contain at most five pages. Poppler extracts PDF text and Tesseract reads English scans in an isolated container with no signing or AI credentials and no internet access. The original file stays on the VPS; only extracted text is sent to NEAR AI. Originals are available to authenticated order members for seven days.

The supplier confirms a canonical UTF-8 JSON array covering network, vault, order, terms version/hash, document SHA-256, invoice reference, line, quantity, token contract and amount. The Rust contract recomputes the same hash and every payment requires a stored supplier confirmation. Changing any field requires fresh confirmation. The pinned cross-language vector is fixtures/invoice-canonical.json. For automatic orders, the contract also tracks attempts against each confirmation: settled, acknowledged and reserved quantities consume it; only a definitive transfer failure releases its quantity. Reusing a paid invoice for a later delivery is rejected. This does not detect semantic duplicates across different supplier-confirmed records. Manual orders retain their original per-request invoice limits.

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

The internal contract, recovery and security review is recorded in SECURITY_REVIEW.md. It precedes mainnet and does not replace independent review. The security sandbox suite checks deposit-capable customer approvals, upgrade preservation and exact-transaction restart recovery. Reproduce the testnet security release with scripts/testnet-security.ts; the older automatic-release evidence remains a historical record.

For the separate code-level storage and native-deposit audit, run `npm run test:storage` inside `sandbox` in Linux/WSL after building the pinned artifacts. It measures ordinary and maximum-sized orders, records outcome gas charges and tests full-access-key teardown only on a disposable account. It does not implement production shutdown or customer deposit refunds. `npm run verify:mainnet:activity -- mainnett12.near` reads public account/history evidence without signing or sending any transaction.

That storage audit describes the historical 2.3.1 release; reproduce it from commit 910a0cc. The current [native-deposit release](NATIVE_DEPOSITS.md) adds owner credits, metered storage, top-ups and callback-safe allowance claims for new orders. Build it with `bash scripts/build-native-contracts.sh`, run `npm run test:deposits` inside `sandbox`, and use the explicit guarded `scripts/testnet-native-deposits.ts` release workflow. Existing orders remain untracked rather than receiving invented credit. Storage cleanup and production shutdown are separate work.

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

The connected workspace opens Payables for buyers or Supplier view for supplier/payout-only accounts. Overview and Supplier navigation let an account inspect each role separately. These views show ready-for-review, invoice-review, in-progress, remaining commitments, accepted deliveries, payments and refunds. A ready amount requires accepted goods, full funding, an open order and a matching supplier-confirmed invoice. Pending transfers and queued/uncertain worker requests hold capacity; review-held money is a subset of in-progress money. Remaining commitments subtract paid and refunded amounts. Manual orders use the largest matching confirmation to cap a new individual request. Automatic orders use the contract’s remaining quantity for each confirmation, capped by accepted unreserved goods. These are order-scoped payment records, not a complete invoice accounting system.

Open Payments, then Remittance advice on a confirmed payment. Advice records the actual recipient, quantity, amount, order, recorded invoice reference and available receipt. Contract settlement and recipient acknowledgment are labeled separately. Pending requests cannot produce final advice. Print / Save PDF uses the browser print dialog; unknown invoice references, request dates or transaction hashes are not invented. Stable links use /workspace?view=overview, /workspace?view=supplier and /workspace?view=payments&payment=REQUEST_ID.

Export CSV downloads the currently filtered orders and their associated payments or refunds; Payments also exports its filtered list. Amounts use exact decimal strings with token identity and up to six decimal places, timestamps are UTC, missing metadata stays blank, and untrusted spreadsheet formulas are neutralized. Reports read the existing capped source: up to 50 listed orders and the latest 100 known request IDs. Incomplete coverage is shown in the workspace and CSV; these are scoped snapshots, not a complete accounting indexer. Application checks cover 58 tests; 23 isolated Playwright journeys include role scoping, totals, exports, advice guards, printing, deep links and mobile layouts. Mobile remittance uses a full-width item description with labeled quantities and amounts; desktop and print retain a table.

On small screens, order cards show balances, delivery progress and status without horizontal scrolling. The single wallet control at the top opens the full connected account and Disconnect; keyboard Escape closes the menu. Order creation defaults to paying the supplier account, with an explicit separate-account option. The form shows an exact order total, optional delivery delegation, automatic payment conditions, the storage allowance and refund conditions before creation. Browser journeys cover these flows, including 320–1024 px form layouts and exact wallet-call arguments for both payout choices.

## Current scope

The current release supports one line per order, integer quantities, fixed six-decimal test-token amounts, exact funding, partial deliveries and payments, bounded attempts, and distinct role accounts. Creation retains 1 native NEAR for bounded storage/outgoing call deposits separately from token funding.

Closure and token refunds are implemented on testnet. Buyer and supplier approve the same 24-hour state snapshot after all accepted deliveries are paid and no transfer is unresolved. The order freezes before dispatch; unused tokens return only to the original buyer. A definite failed refund can be retried. Missing callbacks keep their reservation until the actual recipient explicitly acknowledges receipt; acknowledgment consumes it as paid and never reopens spending capacity. Unreceived, ambiguous transfers remain reserved. Newly tracked orders can return unused native storage allowance after closure; retained records and their 25% buffer stay backed. Older orders have no recorded refundable native credit. See [customer storage deposits](NATIVE_DEPOSITS.md).

The real testnet check refunded 300 aUSD on PO-TESTNET-001. See fixtures/recovery-testnet-evidence.json and fixtures/recovery-sandbox-evidence.json. The explicit npm run verify:recovery:testnet command verifies the tested artifact, upgrades the generated testnet vault if needed, and closes that known order; repeat runs read its existing refund. It never deploys the callback-starvation artifact.

Supplier invoice confirmation and PDF/OCR are implemented and verified through the hosted app. The live check processed both a text PDF and a scanned PDF with real NEAR AI extraction, confirmed the scanned invoice through the supplier account, rejected missing/tampered confirmations, and settled another 100 aUSD. PO-WORKER-001 now has paid quantity 80 and pending 0. See fixtures/invoice-release-evidence.json.

Run npm run verify:documents in Linux/WSL for seven native file checks. npm run verify:invoices:testnet is an explicit live test using ignored generated credentials; it verifies all three sandbox artifact hashes before upgrading and recovers the existing request on repeat runs. Mainnet network integration, production token validation and contract deployment are complete. The mainnet order completed buyer creation, supplier acceptance, 0.02 USDC funding, one-carton delivery, supplier invoice confirmation, a 0.01 USDC payment, a 0.01 USDC token refund and a 0.0689625 NEAR storage refund. The buyer and supplier used Intear for the customer steps; the controlled supplier’s closure proposal used the SDK. Intents funding is enabled for the controlled buyer and its first live transfer is being verified. Independent review and production operations remain outstanding. Submission drafts are in submission/materials.json; recording, public posting and actual submission remain pending.

A real Intear buyer wallet created and funded a 100 aUSD order through the hosted browser, authenticated a scanned-invoice upload, and approved closure after a 40 aUSD partial payment. The remaining 60 aUSD returned to the buyer; the order is Closed with no pending amount. See fixtures/browser-wallet-evidence.json. A separate real Intear journey now verifies supplier acceptance and invoice confirmation, receiver delivery confirmation, and operator NEP-413 authorization of a 40 aUSD payment. The hosted worker settled four cartons with zero pending; remittance and the actual CSV download match the chain receipt. That separate order used an SDK fixture buyer and remains Open with 60 aUSD for later deliveries or mutual closure. See fixtures/browser-roles-evidence.json. The user approved all wallet signing prompts. All four roles have real browser coverage across these two orders; no single all-browser order or mainnet execution is claimed.

Dashboard RPC reads are shared, paced and briefly cached to avoid read bursts against the public provider. Mutable display data is cached for five seconds, finalized attempts for 60 seconds, and operator readiness for 15 seconds. Payment validation, ownership verification and transaction submission retain fresh reads. Caches are memory-only and bounded; a failed read is not retained. Expired wallet sessions return to Connect wallet; 23 browser checks pass.

Target: ready before 10 November 2026, meaning by the end of 9 November in Lagos. See [JUDGE.md](JUDGE.md), [SECURITY.md](SECURITY.md), and [FOUNDATION.md](FOUNDATION.md) for reproduction, authority boundaries, and executed evidence. MIT licensed. Built for the NEAR Hackathon.

## Two-wallet release

Version 2.3.0-automatic is deployed on testnet. The hosted verification used one SDK buyer account to create/fund the order and confirm delivery, and one SDK supplier account to accept terms and confirm invoices. The actual hosted worker paid 40 then 20 aUSD without any operator-wallet signature. A later delivery did not reuse the first invoice. Mutual closure returned the unused 40 aUSD; paid quantity is six, pending zero and the order is Closed. See fixtures/automatic-release-evidence.json. This new path has 23 isolated browser checks and live SDK/worker execution; the earlier real Intear four-role proofs remain historical and are not relabeled as a new two-wallet browser journey.

The current 2.4.0-native-deposits testnet release also has a real Intear refund check through the ChatGPT in-app browser. PO-E13E0551 returned 1.238025 of its 1.25 testnet NEAR allowance, retaining 0.011975 NEAR for records and the buffer. It is Closed with zero pending and claimable balance. See [browser refund evidence](fixtures/native-deposit-browser-evidence.json). The frontend handles a failed refresh after submission without offering a misleading transaction retry; 28 isolated browser checks pass. A complete funded two-customer-wallet browser journey remains separate.
