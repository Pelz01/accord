# Reproduce Accord

## Product

Open [accord-payments.vercel.app](https://accord-payments.vercel.app) for the hosted product. The default workspace uses mainnet and native USDC. Use [/workspace?network=testnet](https://accord-payments.vercel.app/workspace?network=testnet) for the separate testnet service and historical fixtures. See [mainnet release status](MAINNET_RELEASE.md) for executed evidence and remaining work. For development, run npm ci and npm run dev and open http://127.0.0.1:5173. The first page is the landing page. Orders and balances remain hidden until wallet connection; unrelated wallets do not inherit supplied records.

The normal flow uses two customer wallets: buyer and supplier. The buyer creates and funds the order, then confirms delivery using the same wallet. An optional warehouse reviewer can be assigned at creation. The supplier accepts terms and confirms invoice fields. Accord’s restricted background worker requests eligible payment; the contract enforces the financial limits. Creation, acceptance, funding, delivery and supplier invoice confirmation remain wallet transactions. Invoice extraction requires the server's NEAR_AI_API_KEY and fails visibly when unavailable. Existing manual-policy orders retain their operator NEP-413 authorization flow. Never share a private key in chat or commit it.


## Verified mainnet demonstration

PO-7886D7BD is Closed: 2 cartons ordered, 1 accepted and paid, pending 0. It was funded with 0.02 native USDC; 0.01 USDC reached the supplier and 0.01 USDC returned to the buyer. The buyer also recovered 0.0689625 NEAR of its native allowance; 0.0310375 NEAR remains backing retained records and the buffer. [Evidence](fixtures/mainnet-settlement-evidence.json) links actual mainnet receipts. [Live NEAR AI metadata](fixtures/mainnet-ai-invoice-evidence.json) records the text-invoice extraction. PDF/OCR has separate historical testnet evidence. The supplier closure proposal and operational recovery used controlled SDK keys; the customer acceptance, invoice confirmation, buyer actions and refunds were exercised through Intear.

Read the public state without a wallet:

```sh
node --input-type=module -e "const r=await fetch('https://accord-payments.vercel.app/api/chain/state?account=mainnett12.near',{headers:{'x-accord-network':'mainnet'}});const s=await r.json();console.log(JSON.stringify({order:s.orders[0],recovery:s.recoveries['PO-7886D7BD'],nativeDeposit:s.nativeDeposits['PO-7886D7BD']},null,2));"
```

The regular workspace requires a related wallet for its customer views. The public proof above does not expose invoice files or source text. The mainnet WASM is unchanged by the worker gas correction. Current application checks include 73 unit/service cases and the existing isolated browser journeys. Historical testnet evidence below remains labeled testnet.

## Two-wallet automatic orders

Version 2.3.0-automatic adds create_automatic_order and get_payment_policy without changing stored Vault/Order/Attempt layouts. The buyer is the default receiver; a separate reviewer is optional. The service account stays separate. Automatic execution is agreed at creation and bound into the terms hash; existing orders remain manual. The UI contains no service-wallet setup or payment-authorization step for automatic orders. After a supplier-confirmed invoice and delivery, follow Payments for settlement and remittance.

The contract bounds invoice usage as well as order capacity for automatic orders. Paid and reserved quantities cannot be reused; definitive failure releases invoice capacity, while unknown outcomes and recipient acknowledgment preserve consumption. The worker uses deterministic request IDs and pauses an order with queued, uncertain or failed jobs. A failed automatic payment currently requires operational review before another dispatch. It never retries an ambiguous transfer blindly. It scans up to 50 orders per pass and advances through subsequent pages; no payment latency guarantee is claimed.

Run npm run check and npm run test:ui; run the Rust tests and all four sandbox suites. The eight additional automatic checks include a funded upgrade from 2.2.0, default and delegated receiving, invoice reuse rejection, definitive failure/recovery, and successful transfer with a failed callback. npx tsx scripts/testnet-automatic.ts upgrade verifies all four artifact hashes and preserves existing testnet state. The explicit verify mode uses two ignored SDK customer fixture accounts and the real hosted worker; it does not sign an operator authorization or count as real browser-wallet evidence. Repeat verification recovers the existing order and jobs.

## Existing chain evidence

Vault: [vault.accord-v2-8e0a631d.testnet](https://testnet.nearblocks.io/address/vault.accord-v2-8e0a631d.testnet)

Token: token.accord-v2-8e0a631d.testnet (six-decimal aUSD test token).

PO-TESTNET-001 was funded for 100 cartons at 10 aUSD. Acceptance increased from 40 to 70 cartons. Payments were 400 then 300 aUSD; the final state was paid 70, pending 0.

- [First partial payment](https://testnet.nearblocks.io/txns/GTntahDMfctnQyW8UauV2t7vF27swdgFh98jrw1f63tQ)
- [Second partial payment](https://testnet.nearblocks.io/txns/EDdo6pkNvffgXguaKPqXjvgfpJ7WDtzy34CvSERWTmgJ)
- [Authenticated worker payment for PO-WORKER-001](https://testnet.nearblocks.io/txns/ACXH4sQ2rncuYCfmEDk8hWCFzBmJ4MhZ7FUgs7hfL6Qz): 40 cartons / 400 aUSD settled, pending 0.

Sanitized public evidence is in fixtures/testnet-evidence.json and fixtures/worker-evidence.json. The worker fixture records verification of an existing completed job; the smoke's earlier run also checked invalid-account and invalid-signature rejection and one-time replay rejection. Do not treat the fixture as proof of a live AI call.

## Reproduction tools

npm run check runs application tests, TypeScript, and the frontend/API production builds. npm run test:ui checks the landing page, wallet gate, and isolated development harness. The harness tests exercise deterministic state transitions, not NEAR transfers.

For contract checks, run cargo test --locked -p accord-vault. For real cross-contract execution, run bash sandbox/build.sh, then npm ci and npm test from sandbox. The original nine settlement checks include the standard FT resolver, 400/300 partial settlement, replay, unauthorized delivery/private callback rejection, transfer failure, retained reservation after successful transfer with a starved callback, and cross-order isolation. See fixtures/sandbox-evidence.json for receipts and artifact hashes. The additional eleven recovery checks cover mutual closure, stale snapshots, refunds, definitive-failure retries, successful transfers with failed callbacks, cross-order isolation, and upgrading the old funded schema; see fixtures/recovery-sandbox-evidence.json.

scripts/testnet-bootstrap.ts, scripts/testnet-deploy.ts, and scripts/testnet-worker-smoke.ts support a disposable testnet deployment. They use ignored .data credentials, never mainnet. The deploy script requires artifacts to match the passing sandbox evidence before deployment. Do not rerun a money-out smoke against customer funds.

## Live invoice extraction

Live NEAR AI Cloud extraction is verified with the configured server credential and z-ai/glm-5.3-flash. The recorded input is synthetic, and the model response is real. fixtures/near-ai-extraction.json contains the document hash, parsed fields, provider request IDs, timing, successful app HTTP result, and incomplete-invoice rejection. The testnet order did not change.

For a new live check, run npx tsx scripts/near-ai-smoke.ts --http --negative while the server is running. This explicitly calls the provider. Unit tests replay the recorded response and test malformed output, mismatched prices, upstream failures, and rejection sentinels without live requests. The Intear buyer browser check below is separate from these SDK/API checks.

## Hosted verification

The Vercel frontend forwards to the isolated VPS API. Real NEP-413 ownership and replay checks, live AI extraction, and the restricted worker have been verified through the public URL. The worker paid another 300 aUSD on PO-WORKER-001, reaching paid quantity 70 with pending 0. The completed job survived a container restart and the SQLite backup passed integrity checks. See fixtures/hosted-evidence.json and [the testnet receipt](https://testnet.nearblocks.io/txns/AYYhh1rsLzPndbSfB2ecwmqDGSra4F8dBNiXUkKXpBkm).

The explicit npm run verify:hosted command uses ignored generated testnet credentials. It can advance the known verification order and authorize its bounded payment; a repeat run recovers the existing job. This is SDK/API evidence, not an automated browser-wallet extension transaction.

## Closure and refund verification

The tested contract upgrade retained both existing orders and token balances. PO-TESTNET-001 is now closed: 700 aUSD paid to the supplier and 300 aUSD returned to its original buyer, with no pending refund. [Refund receipt](https://testnet.nearblocks.io/txns/5RzNhuARA7TWu7wpXwSArDG2ohmXxZemKXUfPQS9LVdZ). Its counters remain accepted 70, paid 70, pending 0. PO-WORKER-001 remains open. See fixtures/recovery-testnet-evidence.json.

For an eligible funded order, buyer or supplier selects Propose closure. The other party reviews the original buyer account and amount, then signs the stored proposal hash. State changes invalidate it. A failed refund permits a buyer retry after repairing the token registration problem. A refund with an unknown outcome cannot be retried. Only its recipient can explicitly acknowledge funds actually received. Unreceived ambiguous transfers remain reserved.

The explicit npm run verify:recovery:testnet command uses ignored generated testnet credentials. It verifies both sandbox artifact hashes before an atomic code upgrade/state check and recovers the known closed order on repeat runs. This uses SDK signatures; the browser tests use isolated wallet doubles and do not replace a real wallet extension journey. Native storage deposits remain retained.

## Supplier confirmation and PDF/OCR

Supplier confirmation was released in version 2.2.0-invoices; the current contract is 2.3.0-automatic. The upgrade retained existing orders, recovery states and token balances. Through the public URL, the live check uploaded both a text PDF and a scanned PDF, verified extraction through real NEAR AI, privately downloaded the original bytes, and rejected access by an unrelated wallet. The supplier then confirmed the scanned invoice fields. Missing/tampered confirmations were rejected, and the restricted worker settled a 100 aUSD payment. PO-WORKER-001 is now paid 80, pending 0; the earlier 300 aUSD buyer refund is unchanged.

- [Supplier confirmation](https://testnet.nearblocks.io/txns/GpkApCikL16Mhb8mPFhXuebzAVp18nnEtQxMQoFmFG84)
- [Supplier-confirmed payment](https://testnet.nearblocks.io/txns/Ab1rGxNWG6CKoEYUmKnFUHrujnfhG88B26QRPzrnwnG)
- Full proof: fixtures/invoice-release-evidence.json.

To try the UI, connect an order member, open its funded order and select Review invoice. Upload a PDF/PNG/JPEG or select Invoice text. Extract and review the source beside the fields. The supplier confirms after reviewing the public-field notice. The operator selects that confirmed record and signs an eligible quantity. The worker and contract determine settlement; submission is not payment success.

Run npm run verify:documents in Linux/WSL for text PDF, scanned PDF, PNG OCR, page-limit, unsupported-type, corrupt-file and size-limit checks. The production document image runs those same checks during its build. npm run verify:invoices:testnet is an explicit live check with ignored generated credentials. Repeat runs recover its saved document and payment rather than authorizing another transfer.

## Payables, supplier view and reporting

After connecting, buyers land on Payables; supplier or payout-only accounts land on Supplier view. Use the Overview and Supplier tabs to switch role scopes. Search and filter orders, then Export CSV for those orders and their payments/refunds. Ready to review requires full funding, accepted unreserved goods and a matching supplier-confirmed invoice. In-progress amounts include queued requests and uncertain reservations; refunds reduce remaining commitments after confirmation.

Open Payments and select Remittance advice on a confirmed payment. The advice shows actual order/quantity/recipient/amount and any recorded invoice reference, request timestamp and receipt. Contract settlement and recipient acknowledgment have distinct labels. Print / Save PDF opens the print dialog; Download CSV exports that payment. Pending or unrelated request links cannot produce final advice. CSVs preserve exact amounts, token units and UTC dates, leave unknown metadata blank, neutralize formula cells and disclose partial source coverage. The existing read source is capped at 50 orders and 100 known request IDs; no complete ledger/indexer is claimed. These four additions are covered by eight application checks and five isolated browser journeys, including mobile and printable output.

## Submission materials

submission/materials.json contains a 1,308-character product write-up, proposed track rationale, a two-minute demo script, a 210-character X post draft and verified receipt links. submission/accord-poster.png is the accompanying share image; the HTML source is alongside it. Rebuild with node scripts/build-submission.mjs after installing Playwright Chromium. Personal contact and payout details are intentionally deferred and absent from these public materials.

For a new payment recording, prepare a funded order with accepted quantity above paid plus pending; the existing verification order is fully paid for its current accepted 80 units. The linked receipt is the completed verification transaction. Record the actual wallet prompts and final receipt for any new transfer. Recording, publishing the post and sending a submission have not been performed.

## Remaining gates

Mainnet network wiring/deployment and transaction validation; independent recovery/storage/upgrade review; production token validation. Real Intear browser coverage now includes each role across two orders: buyer creation/funding/private scanned-invoice access/closure in fixtures/browser-wallet-evidence.json, and supplier acceptance/invoice confirmation, receiver delivery and operator payment authorization in fixtures/browser-roles-evidence.json. The second order used an SDK fixture buyer. Its restricted worker settled 40 aUSD for four cartons, with no pending quantity; the real browser remittance and downloaded CSV match [the payment receipt](https://testnet.nearblocks.io/txns/32XtoAMepPzBtkYwis1kMy6Pb1YiE49MgyXgk8sCH9m6). It remains Open with 60 aUSD unused; no refund is claimed for it. Forty-nine application checks and 23 isolated browser checks cover the current product. Demo recording, the public demo post, personal submission details and actual submission remain pending. No hackathon submission or social post has been made.
