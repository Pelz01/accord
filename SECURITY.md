# Accord authority and known limits

The current deployed contracts use testnet aUSD. An external contract audit and mainnet release review have not been completed.

## Authorities

The buyer creates and funds an order, a separate supplier accepts immutable economic terms, a separate receiver confirms cumulative deliveries, and a separate operator requests payments. The contract checks the immediate NEAR caller. The operator cannot supply a replacement payout account or mutate the agreed unit price.

The connected browser uses NEAR wallets for direct calls. Operator dispatch requires a signed NEP-413 challenge bound to network, vault, request ID, order, quantity, document hash, and expiry. Challenges expire after five minutes and can be consumed only once. The signer must own the operator account. A restricted function-call key may call only request_payment on the deployed vault. Its allowance limits gas, not token expenditure; the contract enforces the financial boundary.

The development-only simulator has separate deterministic role headers. It is excluded from the production frontend and is not an authentication mechanism. Its Fastify server binds to loopback and rejects unexpected Host/Origin headers. Do not expose that development server as the hosted product. The active hosted product uses a separate production-only Fastify entry on the VPS. Simulator endpoints are absent. The Vercel proxy authenticates to the origin with a timing-safe checked shared secret; requests remain on HTTPS and responses are not cached. The API checks the configured frontend origin. Direct unauthenticated origin requests are rejected. The API runs in an isolated non-root container with persistent SQLite storage and verified daily backups.

Wallet filtering is a navigation aid. Orders, quantities, prices, and attempts are public onchain. Connecting a wallet does not make these records private.

## Hosted invoice authorization

Invoice requests require a NEP-413 full-access wallet ownership proof bound to the website, account, network, nonce, and five-minute challenge. The challenge is atomically consumed once. The resulting 30-minute token is held in browser memory; only its SHA-256 hash is stored. Invoice access is limited to the order buyer, supplier, receiver, or operator. Persistent quotas limit each order to five requests per minute and 100 per UTC day, with a global limit of 1,000 per UTC day. Invalid or unavailable model output remains an error; no synthetic fallback is used.

Production keys remain outside the image and repository. The VPS receives only the restricted operator key, never the generated full-access role/deployment keys. Vercel holds the proxy credential but not the model or NEAR signing key.

## Asynchronous funds

The contract reserves quantity before standard-token ft_transfer, maintaining paid + pending <= accepted <= ordered. The private callback finalizes an immutable attempt once. A definite failed transfer releases entitlement only when the callback runs successfully. Missing or unexpected outcomes retain the reservation. A browser timeout does not establish transfer failure. The VPS worker persists the signed transaction hash before broadcasting and binds queued work to its network/vault. Unknown submissions are reconciled without blind retries or silently moving them to a different deployment.

A successful transfer with a starved callback keeps its reservation. Only the immutable payout recipient can acknowledge a supplier payment as received; only the original buyer can acknowledge a refund. The contract records ReceiptAcknowledged separately from a successful callback. Acknowledgment sends no tokens, consumes the reserved obligation as paid, and makes late callbacks harmless. It is a voluntary recipient attestation, not cryptographic proof of a receipt. A dishonest acknowledgment can strand that recipient's entitlement; it cannot free the same money for reuse. No account can declare an uncertain transfer failed or release its reservation on a timeout. If funds were not received and no definitive callback exists, that reservation remains blocked.

No administrator can redirect payments, reset reservations, or sweep the settlement token. Request IDs stay consumed after transfer failure. Mainnet recovery and upgrade control still require independent review.

Funding accepts only the pinned token, original buyer, accepted unexpired order, and exact amount. Standard token resolution returns unused deposits. Plain token transfers do not grant order credit. Token account registration must precede transfers. Cross-order ledgers must remain isolated.

Creation retains 1 native NEAR separately from the token budget; token refunds do not return this storage/call deposit. Each order allows at most 64 payment attempts. The request requires at least 80 Tgas and allocates 25/20 Tgas for transfer/callback. Sandbox receipts measured successful callbacks around 2.39 Tgas. These measurements do not replace storage, gas-price, and failure-path review for mainnet.

## Documents and models

Invoice text is untrusted, bounded to 32 KiB, and sent only to the fixed NEAR AI Cloud endpoint. The model has no tools or signing keys. Strict schema checks and order matching happen outside the model. React renders document text as text. Provider credentials remain server-side; never put them in VITE\_ variables.

P0 document hashes are audit references. They do not authenticate invoices or maintain invoice-specific paid/pending accounting. A fresh request can use later accepted order entitlement even with an older invoice. P1 supplier invoice commitments, private uploads, and OCR remain unimplemented. A real provider response to a synthetic verification invoice is recorded with provenance in fixtures/near-ai-extraction.json. Live extraction has no synthetic fallback. Requests are bounded to 512 output tokens; invoice JSON is independently validated and matched to fixed terms.

## Deployment control

The existing testnet deployment retains generated development full-access keys in ignored .data. Code can therefore be replaced by that authority. The operator process reads only its limited key; deployment and role full-access keys must not be passed to it. Review upgrade control and recovery before a mainnet deployment. No mainnet transaction has been signed or sent.

The fault-injection Cargo feature deliberately starves callbacks for disposable sandbox tests only. Never deploy that artifact. The build script restores the normal output and testnet deployment verifies its hash against the passed sandbox artifact.

Mutual closure requires buyer and supplier approval of the same canonical snapshot, including network, vault, complete order state, proposer and expiry. A proposal lasts 24 hours. Changed delivery/payment state invalidates it. All accepted units must be paid and unresolved payments must be zero. The refund is reserved before its token transfer and the order remains frozen through definitive refund failures. Only the buyer may retry a definitive failure; ambiguous results cannot be retried. Refund IDs increase monotonically and only the latest eight records are retained, bounding storage without an eight-retry cutoff. Callbacks bind the exact refund ID and are private/idempotent. Closure becomes final only after successful refund, recipient acknowledgment, or a zero-refund close.

Recovery state uses a separate fixed-prefix LookupMap, preserving the existing root/order/attempt encoding. The new attempt status is appended. Both a funded upgrade in the real NEAR sandbox and the existing testnet upgrade preserved orders, attempts and token balances. See fixtures/recovery-sandbox-evidence.json and fixtures/recovery-testnet-evidence.json. NEAR's [independent cross-contract execution](https://docs.near.org/smart-contracts/anatomy/crosscontract) and [private callback requirement](https://docs.near.org/smart-contracts/security/cross-contract-calls/callbacks) remain part of this boundary.

The receiver is trusted to report physical delivery honestly. Disputes, returns, changed prices/receivers/payouts, and token issuer behavior remain outside automatic resolution. Expiry alone never permits withdrawing accepted, unpaid delivery funds.

## Dependencies

Application packages and Rust dependencies are pinned. The latest main application audit reports no known vulnerabilities. The isolated near-workspaces sandbox uses legacy dependencies with separate findings; it must not be bundled into the web server or used with customer keys. tar is overridden to 7.5.22. No external specialist audit has been completed. Executed checks are tracked in FOUNDATION.md.
