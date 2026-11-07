# Reproduce Accord

## Product

Run npm ci and npm run dev, then open http://127.0.0.1:5173. The first page is the landing page. Open the workspace to connect a NEAR testnet wallet. Orders and balances remain hidden until connection; unrelated wallets do not inherit the supplied test records.

The browser sends creation, acceptance, funding, and delivery transactions through the connected wallet. Authorities are enforced by the contract. Invoice extraction requires the server's NEAR_AI_API_KEY; it fails visibly when unavailable. Payment requests need the order operator's NEP-413 wallet signature, a fresh one-time challenge, and the server's restricted function-call key. Never share a private key in chat or commit it.

## Existing chain evidence

Vault: [vault.accord-v2-8e0a631d.testnet](https://testnet.nearblocks.io/address/vault.accord-v2-8e0a631d.testnet)

Token: token.accord-v2-8e0a631d.testnet (six-decimal aUSD test token).

PO-TESTNET-001 was funded for 100 cartons at 10 aUSD. Acceptance increased from 40 to 70 cartons. Payments were 400 then 300 aUSD; the final state was paid 70, pending 0.

- [First partial payment](https://testnet.nearblocks.io/txns/GTntahDMfctnQyW8UauV2t7vF27swdgFh98jrw1f63tQ)
- [Second partial payment](https://testnet.nearblocks.io/txns/EDdo6pkNvffgXguaKPqXjvgfpJ7WDtzy34CvSERWTmgJ)
- [Authenticated worker payment for PO-WORKER-001](https://testnet.nearblocks.io/txns/ACXH4sQ2rncuYCfmEDk8hWCFzBmJ4MhZ7FUgs7hfL6Qz): 40 cartons / 400 aUSD settled, pending 0.

Sanitized public evidence is in fixtures/testnet-evidence.json and fixtures/worker-evidence.json. The worker fixture records verification of an existing completed job; the smoke's earlier run also checked invalid-account and invalid-signature rejection and one-time replay rejection. Do not treat the fixture as proof of a live AI call.

## Reproduction tools

npm run check runs application tests, TypeScript, production builds, and a built-Worker routing/configuration smoke. npm run test:ui checks the landing page, wallet gate, and isolated development harness. The harness tests exercise deterministic state transitions, not NEAR transfers.

For contract checks, run cargo test --locked -p accord-vault. For real cross-contract execution, run bash sandbox/build.sh, then npm ci and npm test from sandbox. The nine executed checks include the standard FT resolver, 400/300 partial settlement, replay, unauthorized delivery/private callback rejection, transfer failure, retained reservation after successful transfer with a starved callback, and cross-order isolation. See fixtures/sandbox-evidence.json for receipts and artifact hashes.

scripts/testnet-bootstrap.ts, scripts/testnet-deploy.ts, and scripts/testnet-worker-smoke.ts support a disposable testnet deployment. They use ignored .data credentials, never mainnet. The deploy script requires artifacts to match the passing sandbox evidence before deployment. Do not rerun a money-out smoke against customer funds.

## Remaining gates

Live NEAR AI credentials and a recorded provider fixture; hosted Worker/D1 deployment verification; mainnet network wiring and deployment; recovery/storage/upgrade review. P1 invoice confirmation and P2 closure/refunds are not included. No hackathon submission or social post has been made.
