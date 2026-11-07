# Accord

Accord helps buyers pay suppliers for accepted deliveries while an AI operator stays inside a funded purchase order. Supplier-accepted terms fix the price, authorities, and payout account. The NEAR contract reserves entitlement before sending tokens.

The product includes a public landing page and a wallet-gated procurement workspace. **The current chain deployment is NEAR testnet.** Wallet transactions, token transfers, contract callbacks, and the restricted operator have been exercised on testnet. Mainnet follows the remaining validation gates; it has not been deployed.

## Run

Requires Node 24.12.0 (or a compatible Node 24 release).

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173 for development. The landing page links to /workspace. Before connection, users see only the wallet gate. Connected wallets see orders where they are buyer, supplier, receiver, operator, or payout recipient. This filtering organizes public onchain records; it is not an onchain privacy mechanism.

To read the existing testnet deployment, copy fixtures/testnet-deployment.json to ignored .data/deployment.json. New installations do not receive another user's wallet or signing keys. The development server reads its restricted operator key from .data/operator-key.json when present. Keys and databases stay ignored.

## Payment flow

1. Buyer creates an order with fixed terms; supplier accepts its terms hash.
2. Buyer registers the necessary token accounts and funds the exact order amount.
3. Receiver confirms a strictly increasing cumulative accepted quantity.
4. Operator reviews an invoice and authorizes an eligible request with its connected wallet.
5. The durable worker dispatches through a key scoped to request_payment on the vault. The private contract callback determines settlement.

```text
paid + pending <= accepted <= ordered
available = accepted - paid - pending
payment amount = requested quantity × agreed unit price
```

The payment agent cannot change recipients, prices, accepted terms, or delivery records. Each request ID is consumed once. Definite transfer failure releases capacity only when its callback completes. An uncertain callback retains the reservation.

## Invoice extraction

Set NEAR_AI_API_KEY in ignored .env to enable server-side NEAR AI Cloud extraction. The connected product accepts invoice text and uses the live adapter; it does not substitute generated sample results. The response must match a strict schema and the order's fixed fields. Live extraction and the running app endpoint have been verified using GLM-5.3 Flash. The sanitized real response, input hash, and provider request IDs are recorded in fixtures/near-ai-extraction.json. The request uses JSON mode; schema and fixed-order checks remain independent of the model. Incomplete invoices fail review. PDF upload and OCR are not implemented.

The default NEAR_AI_MODEL is z-ai/glm-5.3-flash. To repeat the explicit live check, run npx tsx scripts/near-ai-smoke.ts --http --negative with the API server running. This makes real provider requests and rewrites the synthetic-input evidence fixture. Ordinary unit tests replay the captured response without contacting the provider.

## Code and verification

- src/landing: marketing page, interactive product visual, and original generated photography.
- src/testnet: wallet connection, contract reads, order creation, acceptance, funding, delivery, invoice review, payment authorization, and searchable payment history with receipt links.
- contracts/vault: Rust payment boundary and private asynchronous callbacks.
- contracts/test-token: six-decimal aUSD using the NEAR standard FT implementation.
- server: development Fastify API, durable SQLite operator jobs, and extraction adapter.
- cloud, drizzle: hosted Worker and D1 implementation; hosting integration is prepared but deployment and D1 execution remain unverified.
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

npm run build produces the frontend and dist/server/index.js hosted Worker. The build excludes the internal simulator from the production JavaScript. The development-only /dev/simulator route is an isolated deterministic test harness with an actor selector; its tests do not count as wallet authorization or chain evidence. It has no customer navigation.

Rust is pinned to 1.99.1; Windows contract development uses Ubuntu/WSL. The sandbox uses pinned nearcore 2.14.0. Its negative-test fault-injection build must never be deployed. The build script restores the ordinary artifact afterward.

## Current scope

P0 supports one line per order, integer quantities, fixed six-decimal test-token amounts, exact funding, partial deliveries and payments, bounded attempts, and distinct role accounts. Creation retains 1 native NEAR for bounded storage/outgoing call deposits separately from token funding.

P1 supplier invoice commitments and P2 closure/refunds are not implemented. Invoice hashes are audit references, not proof of authenticity or invoice-specific entitlement. Remaining tokens and uncertain reservations have no user recovery path yet. Mainnet requires explicit deployment/network integration, recovery and storage review, hosted provider validation, and further transaction testing.

Target: ready before 10 November 2026, meaning by the end of 9 November in Lagos. See [JUDGE.md](JUDGE.md), [SECURITY.md](SECURITY.md), and [FOUNDATION.md](FOUNDATION.md) for reproduction, authority boundaries, and executed evidence. MIT licensed. Built for the NEAR Hackathon.
