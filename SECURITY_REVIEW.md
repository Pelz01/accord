# Accord internal contract, recovery and security review

8 November 2026. Scope: vault 2.3.1-security, automatic and legacy manual orders, worker restart/receipt handling, wallet/session boundaries, private invoice processing, deployment permissions, dependencies and database recovery. This is an internal engineering review, not an independent audit or permission to accept mainnet customer funds.

The review belongs before mainnet. NEAR's [security checklist](https://docs.near.org/smart-contracts/security/checklist) recommends this sequencing. A production release still needs verification of the actual deployed artifact, token and keys after deployment.

## Findings addressed

| Finding | Result |
| --- | --- |
| A vault-scoped zero-deposit app key could make sensitive customer approvals on an automatic order | Require exactly one yoctoNEAR on nine customer approval methods, together with existing predecessor role checks. The background service remains restricted to zero-deposit request_payment. Legacy manual orders retain compatibility. A full-access signature is still authority, not proof of human presence. |
| Financial views and ownership checks inherited the SDK's optimistic default | Explicit finalized contract views and key queries. Final receipt reads reject non-final results and abort after 15 seconds; timeout remains unknown. |
| Crash after recording a transaction hash but before broadcast could strand a job | Save exact signed transaction bytes durably before send. Validate signature, hash, signer, contract, method, gas, deposit and all job arguments. Only identical bytes may replay; a known onchain attempt stops replay. Private bytes are excluded from public APIs and cleared on a definitive result. Legacy ambiguous jobs without bytes stay held. |
| The service did not actively check code drift or require a finite funded allowance | Recheck finalized vault code hash and narrow key permissions before each preparation/broadcast. Reject broad keys, a different target, extra methods, unlimited/empty allowances and code drift. This cannot prevent an upgrade authority changing code after a check; production upgrade governance remains a gate. |
| Default SDK allocator is unmaintained | Disable wee_alloc and rebuild with Rust's standard WASM allocator. Re-run settlement, refunds, upgrade and callback-failure checks against that artifact. |

The deposit change follows NEAR's [one-yocto guidance](https://docs.near.org/smart-contracts/security/one_yocto). It does not give the worker delivery authority or another customer's wallet. Root, terms, order and attempt storage layouts remain unchanged; no economic term, refund entitlement or existing payment policy is silently rewritten.

## Recovery conclusions

Funds reserve before cross-contract transfers. Successful callbacks settle; definitive transfer failures release the corresponding reservation. A failed or missing callback keeps it reserved. Private callbacks are idempotent and bind the original request/refund identifier. A recipient acknowledgment consumes an uncertain obligation as received and never makes it spendable again. It is a voluntary attestation, not cryptographic proof of receipt. No timeout or administrator can declare an unknown transfer failed.

Mutual closure refunds unused token funding to the original buyer after all accepted goods are paid and pending transfers are zero. Expiry alone does not authorize withdrawal. Either party can refuse to cooperate with closure; the contract has no arbitration or unilateral unused-budget exit. This is a material funds-availability limitation to resolve or explicitly accept in the customer terms before mainnet. The retained native storage deposit is separate and is not included in the token refund.

A prepared transaction that expires, changes key/code context or cannot be reconciled remains held. Failed automatic jobs also require operational review; no operator repair endpoint silently resets them. Recovery does not guarantee eventual withdrawal when counterparties, token contracts or receipt evidence are unavailable.

## Remaining mainnet gates

- Define and independently review unused-fund exit, disputes and receipt-recovery rules; receiver honesty and invoice authenticity are not established by these signatures.
- Wire mainnet separately. Pin the real token's contract/code, decimals, issuer behavior and account-registration rules; do not deploy the test aUSD token as a customer payment asset.
- Choose production upgrade governance and protected key custody. Generated testnet full-access keys are development authority; the production service should receive only its limited key.
- Measure worst-case storage/gas and establish funding/allowance thresholds, permissionless-discovery gas-abuse budgets, alerts, incident ownership, worker pause and recovery procedures. The current bounded tests do not establish a production latency SLA.
- Complete the updated two-customer-wallet flow in real browsers, including mobile, approvals, declined signatures and recovery. Prior four-role wallet evidence and current SDK checks do not substitute for this final journey.
- Decide document/backup retention and customer privacy terms. Protected filesystem backups are not application-encrypted storage, and API expiry does not erase every backup.
- Obtain independent contract/security review before meaningful customer value. Verify deployed bytecode/configuration after the final approved production release.

## Dependency findings retained visibly

The main JavaScript npm audit reports zero known advisories, including development dependencies. Cargo-audit still reports [crypto-bigint RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html), lru RUSTSEC-2026-0253 and unsafe-libyaml RUSTSEC-2024-0449 through near-sdk's native unit-test runtime. None is present in the wasm32 normal dependency tree. The test harness uses disposable keys, known fixtures and no customer credentials. These advisories are recorded, not suppressed, and upstream remediation remains outstanding. The separate near-workspaces harness also retains legacy dependencies and must not ship in the API. The removed allocator is described in [RUSTSEC-2022-0054](https://rustsec.org/advisories/RUSTSEC-2022-0054.html).

## Operational recovery procedure

1. Pause the Accord API/worker before investigating unexplained financial state. This does not cancel transactions already broadcast. Keep other VPS services untouched.
2. Back up SQLite using scripts/backup-api.mjs. Compare deployment, code hash, order, attempt, invoice capacity, final transaction and token receipt records. Do not edit paid/pending counters or delete a job to force another payment.
3. A known Reserved attempt remains reserved. A definitive contract/token failure may follow its explicit recovery path. An unknown outcome stays held; request a recipient acknowledgment only if they independently confirm receipt.
4. Retain any saved transaction privately. Replays must be byte-identical and valid for the current authorized deployment; never sign replacement spending for an ambiguous job.
5. Restore backups into a disposable copy first, verify integrity and records, and test writes before a planned restore. A stale database can omit authorization/jobs; reconcile with finalized onchain state before resuming. Never roll back the vault's financial state to match a backup.
6. Resume only after the incident owner documents the receipts, remaining obligations, compatible release and narrowly scoped signer. This is an engineering runbook; production alerting, incident authority and retry tooling still need operational implementation.

## Executed release checks

58 application tests, 23 isolated browser journeys, 48 Rust unit tests and 42 real NEAR sandbox checks passed. TypeScript and production builds passed. The sandbox explicitly exercises a real scoped function-call key, customer one-yocto approvals, automatic/legacy storage preservation, starved payment/refund callbacks and exact saved-transaction replay after restart. The final tested vault SHA-256 is 2eb011ff5989660c2ce6939ad8bd616e77ca9d7df3fd10d87e0aa9980ac74f04.

The testnet atomic upgrade preserved six existing orders and their financial records. PO-REVIEW-9DBFF04F then settled two automatic payments (40 and 20 aUSD) and returned the unused 40 aUSD through mutual closure. Its two worker jobs remained settled after an API restart; no pending amount remained. Signed authorization fields were absent from the public jobs API. A VPS backup was restored to a disposable copy and passed integrity, record and rolled-back-write checks. Public evidence: fixtures/security-review-evidence.json, fixtures/security-sandbox-evidence.json, fixtures/security-release-evidence.json and fixtures/security-hosted-evidence.json. These SDK and isolated-browser checks do not claim the outstanding real-wallet journey.
