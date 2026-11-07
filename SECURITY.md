# Accord authority and known limits

The current deployed contracts use testnet aUSD. An external contract audit and mainnet release review have not been completed.

## Authorities

The buyer creates and funds an order, a separate supplier accepts immutable economic terms, a separate receiver confirms cumulative deliveries, and a separate operator requests payments. The contract checks the immediate NEAR caller. The operator cannot supply a replacement payout account or mutate the agreed unit price.

The connected browser uses NEAR wallets for direct calls. Operator dispatch requires a signed NEP-413 challenge bound to network, vault, request ID, order, quantity, document hash, and expiry. Challenges expire after five minutes and can be consumed only once. The signer must own the operator account. A restricted function-call key may call only request_payment on the deployed vault. Its allowance limits gas, not token expenditure; the contract enforces the financial boundary.

The development-only simulator has separate deterministic role headers. It is excluded from the production frontend and is not an authentication mechanism. Its Fastify server binds to loopback and rejects unexpected Host/Origin headers. Do not expose that development server as the hosted product. The separate hosted Worker uses D1 jobs/challenges, same-origin checks, and secret environment bindings; its live deployment is still awaiting verification.

Wallet filtering is a navigation aid. Orders, quantities, prices, and attempts are public onchain. Connecting a wallet does not make these records private.

## Asynchronous funds

The contract reserves quantity before standard-token ft_transfer, maintaining paid + pending <= accepted <= ordered. The private callback finalizes an immutable attempt once. A definite failed transfer releases entitlement only when the callback runs successfully. Missing or unexpected outcomes retain the reservation. A browser timeout does not establish transfer failure.

A successful transfer with a starved callback leaves capacity locked. No administrator can redirect payments, reset reservations, or sweep the settlement token. Reconciliation and user recovery remain unresolved for mainnet. Request IDs stay consumed after transfer failure.

Funding accepts only the pinned token, original buyer, accepted unexpired order, and exact amount. Standard token resolution returns unused deposits. Plain token transfers do not grant order credit. Token account registration must precede transfers. Cross-order ledgers must remain isolated.

Creation retains 1 native NEAR separately from the token budget, with no P0 refund. Each order allows at most 64 payment attempts. The request requires at least 80 Tgas and allocates 25/20 Tgas for transfer/callback. Sandbox receipts measured successful callbacks around 2.39 Tgas. These measurements do not replace storage, gas-price, and failure-path review for mainnet.

## Documents and models

Invoice text is untrusted, bounded to 32 KiB, and sent only to the fixed NEAR AI Cloud endpoint. The model has no tools or signing keys. Strict schema checks and order matching happen outside the model. React renders document text as text. Provider credentials remain server-side; never put them in VITE\_ variables.

P0 document hashes are audit references. They do not authenticate invoices or maintain invoice-specific paid/pending accounting. A fresh request can use later accepted order entitlement even with an older invoice. P1 supplier invoice commitments, private uploads, OCR, and a real recorded provider fixture remain unimplemented. Live extraction has no synthetic fallback.

## Deployment control

The existing testnet deployment retains generated development full-access keys in ignored .data. Code can therefore be replaced by that authority. The operator process reads only its limited key; deployment and role full-access keys must not be passed to it. Review upgrade control and recovery before a mainnet deployment. No mainnet transaction has been signed or sent.

The fault-injection Cargo feature deliberately starves callbacks for disposable sandbox tests only. Never deploy that artifact. The build script restores the normal output and testnet deployment verifies its hash against the passed sandbox artifact.

The receiver is trusted to report physical delivery honestly. Disputes, returns, changed prices/receivers/payouts, token issuer behavior, mutual closure, and refunds remain outside P0. Undisbursed tokens have no withdrawal path.

## Dependencies

Application packages and Rust dependencies are pinned. The latest main application audit reports no known vulnerabilities. The isolated near-workspaces sandbox uses legacy dependencies with separate findings; it must not be bundled into the web server or used with customer keys. tar is overridden to 7.5.22. No external specialist audit has been completed. Executed checks are tracked in FOUNDATION.md.
