# Storage, deposits and recovery: measured audit

This audit measures the existing tested artifact on a disposable NEAR node. It does not change order deposits, deploy mainnet, implement production shutdown or establish the full cost of operating a business. The spending ceiling remains 2 NEAR.

## Measured results

| Item | Bytes | NEAR held for storage |
| --- | ---: | ---: |
| Contract code, observed deployment delta | 232,955 | 2.32955 |
| Ordinary automatic order: two invoices, two payments, unused-token refund and closure | 2,887 | 0.02887 |
| Maximum-field exercise: 32 invoices, 64 payments, eight retained refund records | 73,781 | 0.73781 |

The comparison margin for the large exercise is 25% (0.1844525 NEAR), yielding **0.9222625 NEAR**. That percentage is an explicit analysis assumption, not a newly approved price, a proof covering every future change, or authorization to lower the deposit. Native outgoing-call deposits and account/code initialization are separate. The maximum field widths and bounded record counts are exercised in the test; failed/unknown records must not be deleted to make storage appear cheaper.

The existing 1 NEAR requirement reserves capacity for future records, not just initial creation. The ordinary case uses much less, while the maximum-sized case demonstrates why charging only for creation or switching to 0.1 NEAR without changing the storage policy would subsidize later growth. A new deposit policy needs measured bounds or explicitly funded capacity, not an arbitrary lower number.

## Ordinary order measurements

These are finalized account-storage snapshots around completed transactions. Account initialization and code deployment precede this order. Generated short account names affect exact ordinary-case sizes; the maximum-field exercise uses 64-byte account IDs.

| Stage | Before bytes | After bytes | Change bytes | Change in storage backing (NEAR) |
| --- | ---: | ---: | ---: | ---: |
| create order | 233,290 | 233,894 | 604 | 0.00604 |
| supplier acceptance | 233,894 | 233,894 | 0 | 0 |
| funding | 233,894 | 233,894 | 0 | 0 |
| first delivery | 233,894 | 233,894 | 0 | 0 |
| first invoice | 233,894 | 234,498 | 604 | 0.00604 |
| first payment | 234,498 | 235,001 | 503 | 0.00503 |
| second delivery | 235,001 | 235,001 | 0 | 0 |
| second invoice | 235,001 | 235,520 | 519 | 0.00519 |
| second payment | 235,520 | 236,023 | 503 | 0.00503 |
| mutual close | 236,023 | 236,177 | 154 | 0.00154 |

The 11 recorded transactions from creation through closure sum to **0.0048809116376794 NEAR** in outcome `tokens_burnt`. This is a measured sandbox charge using Accord's test token, not a quote for Circle USDC on mainnet. Deposits, registration collateral, account creation, server hosting, AI/OCR and accounting for contract gas rewards are not included in that ordinary transaction total. Mainnet settlement fees and the full operating cost remain unmeasured.

## What the current code actually returns

- `create_order_inner` requires at least 1 NEAR and records no native deposit balance or payer credit. The observed 1.25 NEAR creation payment kept the extra 0.25 NEAR as well. Gas rewards can slightly increase the vault balance; they are not a depositor refund.
- Closing the ordinary order returned **4 settlement tokens** to the buyer. It refunded **zero native order-deposit NEAR** and retained the order, invoices, attempts and recovery record. The contract currently has no customer order-cleanup, native-credit claim or excess-deposit refund method.
- Storage backing remains part of the vault account's balance. Releasing storage makes balance available to that account; it does not assign it to the buyer. A full-access account controller can transfer available native balance at the protocol level. Accord's restricted worker key cannot do that, and customers currently have no native-deposit withdrawal API.
- No order-removal method exists, so closure currently releases no order storage for an automatic buyer refund. Future ownership and allocation must be defined and enforced in code.

## Disposable retirement result

All balances in this retirement test are simulated NEAR supplied by the isolated test node. Its transactions were not sent to testnet or mainnet.

The test helper refused retirement for an open order and for a real payment whose callback failed while the reservation remained. For the separate ordinary vault, both orders were Closed, accepted goods were paid, pending payments/refunds were zero, funding reconciled and the vault's settlement-token balance was zero.

Using only that disposable account's full-access test key, the harness removed the code, confirmed the code bytes were empty, verified new customer calls failed and deleted the account into an explicit test beneficiary. Code removal released **2.32955 NEAR** of storage backing. Available balance increased from 99.878866796542373800000006 to 102.208094688767373800000006 NEAR after the code-removal charge. The beneficiary received **102.247777128142373800000006 NEAR** from the remaining native account balance.

That transfer includes the disposable deployment funding, collected order deposits and rewards less charges; it is not a refund allocated to original depositors. The test had only two settled orders and 3,970 residual storage bytes. It does not prove large-vault cleanup, an atomic production pause, protected upgrade governance or customer deposit accounting. Registration deposits held in the separate token contract are also not automatically returned by deleting a NEAR account.

**Production shutdown is still not implemented.** The current offchain precheck would not protect a live deployment against concurrent new activity or an abusive full-access upgrade/delete key. Safe retirement needs onchain lifecycle controls and custody rules. Keeping a retired account accessible for late assets may be preferable to deleting it.

## Order cleanup is separate work

Before offering native-deposit recovery to customers:

1. Track native credits per order and their owner. Separate customer liabilities, required storage/call reserves and service-owned funds. Define the treatment of historical deposits whose amount was never stored.
2. Return genuine excess to the recorded owner through a callback-safe claim: reserve before sending, mark success only from a definitive result, and preserve failed/unknown claims without duplicate refunds. Do not return reserve still needed for future allowed records.
3. Permit bounded cleanup only after final closure, accepted goods paid, payment/refund pending zero, and all token/native claims reconciled. Keep compact permanent identifiers or equivalent guards so cleanup cannot enable order-ID reuse, invoice reuse, replayed payments or late-callback corruption. Preserve verifiable archived history.
4. Re-measure remaining tombstones, indexes, shared-state overhead and cleanup/refund gas. Specify which portion remains held and which is returned to the original credit owner while the service continues running. Re-run failure, restart, replay and upgrade checks against any new artifact.
5. For service retirement, block new activity onchain before checking final obligations, retain the necessary recovery paths while settling, stop/reconcile the worker and only then execute a reviewed native-balance recovery procedure. Never delete an account while known supplier funding or unresolved obligations remain.

## Public mainnet check

At 2026-11-10T22:05:07.053Z, two RPC providers agreed on **3 NEAR**, 182 account-storage bytes and no deployed code for `mainnett12.near`. The indexer reported 2 related receipts; all indexed rows were read and their transactions cross-checked as FINAL via RPC. They are account creation and an incoming 3 NEAR transfer. There were **0 transactions signed by this account** and **0 action receipts sent from it** in those records.

Public links: [account](https://nearblocks.io/address/mainnett12.near), [funding transaction](https://nearblocks.io/txns/GLHyCAgUZkqHyHe5iXp11G6uECis6DdCkTGtdnN8HfsH), [creation transaction](https://nearblocks.io/txns/APvhcdN7fDPnQV2zFncPkHuF8q2XemLK2u3Xpywx3xyo). Creation/funding incurred fees for their actual senders, separately from any Accord deployment. This is public evidence at the recorded blocks, dependent on indexer coverage; it does not prove who controlled another account or global absence of spending elsewhere.

## Reproduction and evidence

In Linux/WSL, install the pinned dependencies and build the existing artifacts, then run `npm run test:storage` inside `sandbox`. It writes ignored `.data/storage-cost-evidence.json`. On the host, `npm run verify:mainnet:activity -- mainnett12.near` performs read-only public checks and writes ignored evidence. There is no signer or transaction-broadcast path in that command.

Public snapshots: [storage evidence](fixtures/storage-cost-evidence.json) and [mainnet activity evidence](fixtures/mainnet-activity-evidence.json). Artifact SHA-256: `2eb011ff5989660c2ce6939ad8bd616e77ca9d7df3fd10d87e0aa9980ac74f04`. All six new audit checks passed. The vault source/WASM, hosted app and VPS were not changed.

Protocol references: [storage staking](https://docs.near.org/protocol/storage/storage-staking), [account actions and deletion](https://near.github.io/nearcore/RuntimeSpec/Actions.html). The fixed code-storage calculation also matches the observed deployment and removal byte deltas, not just file-size arithmetic.
