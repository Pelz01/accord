# Customer storage deposits

This page records the 2.4.0 testnet release and its measurements. The newer controlled mainnet release uses an incremental 0.1 NEAR starting allowance; see [mainnet status](MAINNET_RELEASE.md). Existing testnet behavior is preserved.

Release **2.4.0-native-deposits** adds native NEAR accounting and customer refunds for newly created orders. Supplier-payment tokens remain separate. The existing full-capacity creation allowance remains **1 NEAR**; it was not replaced with the measured small-order amount.

## Customer behavior

- New orders record the original buyer as deposit owner, the amount prepaid, explicit top-ups, native transfer-call deposits used, successful refunds and any refund awaiting a definitive result.
- While an order is open, the contract retains its capacity allowance. The buyer can claim any genuine excess above that reserve. Maximums remain 32 supplier invoices and 64 payment attempts; eight token-refund records are retained. A native claim uses a fixed-size record and increasing sequence rather than unbounded history.
- Each new invoice, payment attempt and recovery-record change is metered against that order's credit. The required backing includes a 25% buffer. Growth without enough credit reverts; only the owner can explicitly top up. Platform storage and other tracked customer credits are protected before new spending.
- After closure, the future-capacity reserve is released. The buyer can claim the remaining allowance above actual retained-record backing and the 25% buffer. The records themselves stay stored, including payment IDs, invoice commitments and duplicate-payment protection.
- An unfunded order with no deliveries can be cancelled by its buyer, without buying supplier-payment tokens. Later acceptance and funding are blocked. Its eligible native allowance can then be claimed while record backing stays held.
- The workspace shows deposited, returned, held and claimable NEAR. Exact amounts and the recipient appear in a review before wallet approval. Supplier viewers see that the deposit belongs to the buyer and cannot claim it.

## Refund rules

Native claims and acknowledgments require the recorded owner and exactly one yoctoNEAR. There is no redirectable recipient. The amount is reserved before a transfer is scheduled. A successful callback records it as refunded; a definitive failure restores the credit. A missing or failed callback leaves it pending and blocks another claim. Only the recipient can voluntarily acknowledge that it arrived; acknowledgment consumes the reservation and cannot make it spendable again. Sequence/status checks reject late or repeated results.

Claims are also paused while supplier payments or token refunds are unresolved. Fixed-size financial receipt finalization does not require fresh platform funding; new storage growth and new spending still enforce backing checks. Transaction gas and one-yocto approval deposits are separate from the prepaid storage credit. Native deposits forwarded with outgoing token calls are deducted from the order's credit as used.

The one-yocto outgoing call amounts are deducted on dispatch. This release does not individually reconcile protocol refunds of those symbolic call deposits after failed token calls; the 73-call stress figure below is a dispatch-allocation figure, not a claim that 73 yoctoNEAR were permanently burned. Storage allowance refunds and transaction fees remain distinct.

The stored native pool protects tracked customer credits from other orders, including legacy record growth. A retained full-access deployment key can still override contract code or directly move account funds. Production key custody and independent review remain requirements before meaningful customer value.

## Older orders

Root, Terms, Order and Attempt Borsh layouts are unchanged. Native ledgers use distinct fixed-prefix sidecars. Orders that predate this release are reported as **untracked**; their original native payment was never stored, so the contract does not invent a refundable balance. This release does not retroactively refund their retained deposits.

## Measured verification

The final normal WASM is **254,662 bytes**, SHA-256 `4dec1dc5acb8b3c2c75df77de705fb4ff8d6a27146c366b19d04e4b2c03dec94`. Its code-storage backing alone is **2.54662 NEAR**, before account/state, gas and an order's separate allowance. This remains outside the owner's 2 NEAR mainnet ceiling; no mainnet deployment or funding was performed.

58 Rust checks, 61 application checks, 26 isolated browser checks, 42 existing real sandbox checks and eight new native-deposit sandbox checks passed. The new cases cover historical upgrade compatibility, ownership, excess refunds, cancellation, top-ups, settlement-token separation, real failed native transfers, successful transfers with deliberately starved callbacks, repeated/late callbacks and protection of another buyer's credit. Browser checks are isolated wallet fixtures; they do not claim a real Intear approval for these new methods.

The maximum-field scenario used 64-byte account/order/line/request IDs, a 160-byte description, a 32-byte unit, 80-byte invoice references, 32 invoices, 64 payments and nine token-refund attempts with eight records retained. A 33rd invoice and 65th payment were rejected. The customer ledger attributed **74,063 bytes** to that order; a further **87 bytes** belonged to fixed platform-pool metadata. Its backing was **0.74063 NEAR**, and its required retained amount with the buffer was **0.9257875 NEAR**. The remaining **0.074212499999999999999927 NEAR** was returned, accounting for 73 one-yocto token-call deposits. This demonstrates the enforced current capacity, not an exhaustive proof of every possible state or future code change.

## Live testnet proof

The atomic upgrade on `vault.accord-v2-8e0a631d.testnet` preserved existing orders, invoices, payment policy, recoveries and settlement-token balance. [Upgrade transaction](https://testnet.nearblocks.io/txns/5hJKKGnLYAHqXiAyN762QE9Nom9b4guZADgy3UpFQFLa).

On **PO-NATIVE-8887B8CB**, a fresh faucet-funded buyer prepaid **1.25 testnet NEAR**. It reclaimed **0.25 NEAR** while open, cancelled the unfunded order and reclaimed **0.9868 NEAR** afterward. Total native refunds were **1.2368 NEAR**, with **0.0132 NEAR** held for 1,056 bytes of retained records and the buffer. Both claims settled; pending and remaining claimable amounts were zero. [First claim](https://testnet.nearblocks.io/txns/7BfDstn6NN6bgUjz95dAKEJ1bxi7dsPbPNEGbMr7oxpo), [second claim](https://testnet.nearblocks.io/txns/2QS1wCnySoGxpN6yBWFbBABeqtSbbfBmD1zNLYBuu7uq).

The hosted API and frontend use the same deployment hash and expose the final ledger. Three existing orders visible to testing33.testnet correctly remain untracked. The restricted worker is ready, the document service remains healthy, and the unrelated VPS health endpoint still returns 200. The API database was backed up before activation. No GitHub Actions workflow was run.

The real **Intear / ChatGPT in-app browser** check on **PO-E13E0551** used testing33.testnet to create an unfunded order with 1 testnet NEAR, add 0.25 NEAR, reclaim that 0.25 NEAR while open, cancel the order and reclaim **0.988025 NEAR** after closure. All five transactions finalized successfully. Total returned is **1.238025 NEAR**; **0.011975 NEAR** remains held for 958 bytes of retained records and the buffer. Pending and claimable balances are zero, and the browser disables another claim. [Final refund](https://testnet.nearblocks.io/txns/6fPiZ2QiarJ6KVoPiE4rKuJq8MVPyUPkFagUB7qhuJUS), [browser evidence](fixtures/native-deposit-browser-evidence.json). This verifies native refunds on an unfunded order; it is not a funded two-customer-wallet supplier-payment journey.

This browser check found intermittent hosted refresh failures after successful submissions. The frontend now closes the submitted review, preserves its receipt and pauses further actions until fresh order state arrives, rather than presenting a transaction retry. Supplementary job-list failures do not invalidate a successful order-state read. Two additional isolated regressions cover these failures; all 28 browser checks pass.

Public evidence: [native sandbox checks](fixtures/native-deposit-sandbox-evidence.json), [five regression suites](fixtures/native-deposit-regression-evidence.json), [live upgrade and refunds](fixtures/native-deposit-testnet-evidence.json), and [hosted checks](fixtures/native-deposit-hosted-evidence.json).

A fresh [public mainnet activity check](fixtures/native-deposit-mainnet-activity.json) still found 3 NEAR, no deployed code and no outgoing activity for mainnett12.near in the indexed records. All signing in this release was on testnet or an isolated sandbox.

## Reproduction

Build in Linux/WSL with `bash scripts/build-native-contracts.sh`, then run `npm run test:deposits` inside `sandbox` and the existing `npm test` sandbox suites. The failed-transfer and starved-callback artifacts are test-only and must never deploy. The normal target output is restored after their builds.

`npm run verify:deposits:testnet` defaults to read-only status. Explicit `upgrade` and `verify` modes require the pinned normal artifact and all six matching sandbox proofs. The testnet-only guard rejects other networks/accounts. Generated faucet credentials stay in ignored local files and are not in public evidence. Signing is never retried to resolve an uncertain refund.

## Still separate

Order cleanup that frees retained storage, historical-deposit migration, and safe production shutdown are **not implemented**. Neither closure nor this allowance refund removes order records or releases the shared code backing. Independent review, production custody, a complete funded two-customer-wallet browser journey and the remaining mainnet/Intents work are still required.
