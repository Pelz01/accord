# Controlled mainnet release

Mainnet is required for the submission. Direct USDC settlement comes before Intents funding. This is a controlled demonstration with the owner's funds, not an approval to accept customer funds. The hosted default now uses mainnet; the existing testnet service remains separate.

## Read-only preflight

Run from the repository root after building the vault artifact:

```powershell
npm run verify:mainnet:preflight -- mainnett12.near 3 0.1
```

The arguments are a public funding account and an explicit total NEAR ceiling. The check reads finalized mainnet RPC state, the Intents token list and `.data/wasm/vault.wasm`. It writes `.data/mainnet-preflight.json`. It never loads a key, creates a quote or sends a transaction. Exit code 2 means the measured lower bound exceeds the supplied ceiling; exit code 0 does **not** authorize deployment or spending.

The owner authorized **3 NEAR total**, including deployment, account setup, gas and acquiring a tiny amount of USDC. The controlled plan allocates 2.65 NEAR to the vault, 0.02 each to supplier and payment-service gas, 0.1 to the NEAR/USDC swap, 0.1 as the initial order allowance and 0.11 as buyer setup/gas headroom. No additional funding is authorized.

### Settlement asset verified

- Circle lists native NEAR USDC at `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` in its [issuer contract directory](https://developers.circle.com/stablecoins/usdc-contract-addresses).
- Finalized token metadata reports **6 decimals**. Storage registration reports **0.00125 NEAR** per unregistered account. Recheck before use.
- Observed token code hash: `DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q`. The preflight fails if this changes; review an issuer upgrade instead of silently updating the pin.
- The live [1Click token list](https://1click.chaindefuser.com/v0/tokens) contains the exact NEAR contract, six decimals and asset ID `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`. Listing does not prove route liquidity, minimum size or an executable quote.

### Historical budget gate

Measured against the existing tested vault, **232,955 bytes**, SHA-256 `2eb011ff5989660c2ce6939ad8bd616e77ca9d7df3fd10d87e0aa9980ac74f04`:

| Requirement | NEAR |
| --- | ---: |
| Code storage at the live protocol rate of 10^19 yoctoNEAR/byte | 2.32955 |
| Existing retained deposit for one order | 1 |
| Lower bound | **3.32955** |

This exceeds the authorized ceiling. It excludes account/key state, gas, token registration, operational balances and USDC acquisition/Intents fees. Storage collateral is locked balance, not burned gas; the order's native deposit is retained separately from any unused-token refund. See [NEAR storage staking](https://docs.near.org/protocol/storage/storage-staking).

The existing artifact is testnet-only. Any mainnet-compatible rebuild or optimization needs a new size measurement, hash, security review and regression checks. Do not strip recovery or authorization features, replace the allocator with an unmaintained dependency, or treat a larger wallet balance as a larger spending authorization.

### Historical investigation under the earlier two-NEAR ceiling

The owner confirmed that the total ceiling remains **2 NEAR**. Five alternatives were measured in ignored, isolated files; the original tested artifact and deployed release were preserved. Measurements and hashes are in [the cost-study evidence](fixtures/mainnet-cost-study.json).

| Build | Bytes | NEAR for code storage alone |
| --- | ---: | ---: |
| Current tested artifact | 232,955 | 2.32955 |
| Repeated Binaryen size optimization | 232,448 | 2.32448 |
| Repeated optimization plus similar-function merging | 232,448 | 2.32448 |
| Rust size profile `s`, then Binaryen | 251,278 | 2.51278 |
| Rust optimization profile `3`, then Binaryen | 279,861 | 2.79861 |
| Typed event/transfer JSON and invoice serialization experiment | 222,073 | 2.22073 |

Every candidate parses as WASM and retains the public exports. That is a structural check, **not** behavioral or security validation. The serialization experiment has not passed regression or sandbox verification and is not a release candidate. None was adopted because each already exceeds the ceiling before any order deposit or operating costs.

The retained order deposit covers future persistent invoice, payment and recovery records. Lowering it alone neither fixes the code-storage shortfall nor proves sufficient lifetime storage. Payment limits, invoice limits, refund rules and deposits remain unchanged. A substantially smaller implementation would require further design and review; there is no validated mainnet deployment plan within the current budget.

[Global contracts](https://docs.near.org/smart-contracts/global-contracts) do not solve the first-publication cost: publishing new global code burns ten times the normal per-byte storage rate. Reusing an unrelated global contract is not equivalent to deploying Accord's verified payment rules.

## Implementation and verification still required

1. Resolve the budget gate. Review a concrete allocation for deployment, one order, registrations, gas and token acquisition within the chosen ceiling. Confirm the USDC amount and controlled supplier account.
2. Add explicit mainnet configuration to the vault, API, finalized chain client, login challenges, wallet connector, explorer links, invoice validation and token displays. Use six-decimal USDC arithmetic. Preserve testnet compatibility.
3. Run a separate mainnet API/worker with separate SQLite, sessions, challenges, configuration and keys. Do not repurpose the testnet database or signer. Bind every financial record to its network, vault and pinned asset.
4. Choose deployment-key custody and give the background worker only a vault-scoped `request_payment` key with finite allowance. Verify the actual deployed code hash, roles and token registration before funding.
5. Prove create → supplier acceptance → direct buyer funding → delivery confirmation → partial payment → finalized receipt with the approved amount. Exercise the hosted two-wallet journey and verify remaining paid, pending and unused amounts.
6. Add Intents as a separate funding step. Validate the exact assets, amount, quote expiry, minimum received, fees, slippage, refund destination and status. Settle the swap into the **buyer's wallet**, then let that buyer fund the order through a separate `ft_transfer_call`. A solver transfer must not bypass the vault's original-buyer funding check.
7. Repeat through the hosted interface and record the submission demonstration. Do not claim completion from token discovery alone.

## Funds-availability limits

The 2.5.0 mainnet candidate is **256,674 bytes**, SHA-256 `beb76c43bd50db4cc763b2595835da7611124fbb60c70c6d0330185eeaa43d83`. Code backing is **2.56674 NEAR** at the verified protocol rate. Mainnet orders start with **0.1 NEAR**, then enforce explicit top-ups as their actual retained records grow. The 25% reserve, 32-invoice/64-attempt limits, fixed-recipient rules, payment reservations and refund protection remain enforced. Testnet orders retain their existing 1 NEAR capacity policy. Neither allowance is a gas fee.

On the disposable sandbox, the identical normal candidate was initialized with the mainnet domain and pinned token address. A synthetic NEP-141 fixture at that address tested 0.01-token partial settlement, replay rejection, unused-token refunds, native excess refunds, and storage exhaustion followed by an owner top-up. This does not represent execution of Circle's production code. Mainnet token metadata and code are separately pinned and checked before deployment.

The owner approved the Intear/Rhea acquisition of **0.364520 native USDC** using 0.1 NEAR plus wallet gas/storage, then funded the three controlled setup accounts with **2.69 NEAR** in total. The mainnet service is isolated at **/home/ubuntu/accord/mainnet**, on its own database, configuration, proxy credential, document service and operator key. Only a vault-scoped request_payment key with finite allowance may run on the server. Master keys stay in ignored local storage; they never enter Vercel or the public repository.

The tested contract is now deployed: [deployment receipt](https://nearblocks.io/txns/AhwibHUiHGQuQecLsZQZc9nS68SbyfUPhwET3zyS4TwQ). Its original worker key had a 0.015 NEAR allowance; that key was later revoked during the gas recovery described below. The hosted default is mainnet; /workspace?network=testnet selects the separate existing testnet service. The first mainnet order completed settlement and refunds; see [mainnet settlement evidence](fixtures/mainnet-settlement-evidence.json). USDC acquisition used Intear's Rhea route; it is **not** evidence of a live Accord NEAR Intents swap. Order cleanup and safe production shutdown also remain separate from unused allowance refunds.

The existing [internal security review](SECURITY_REVIEW.md) remains applicable. Unused token withdrawal requires mutual closure after accepted goods are paid and pending transfers are zero. Either party can block closure. Unknown transfers retain their reservations; a timeout does not authorize replacement spending. The native order deposit is not part of the token refund. Use controlled amounts that may remain locked. Independent review and production operations remain outstanding before meaningful customer value.

The first browser creation request was rejected by Intear before broadcast because its default 150 TGas reservation exceeded the buyer's remaining balance. Mainnet wallet calls now use method-specific allowances verified by the mainnet-domain sandbox: 50 TGas creation, 30 registration, 70 token funding, 25 simple approvals, 80 closure and 40 native claims. No contract minimum was lowered. While the vault had no orders or token obligations, 0.064 NEAR of unused setup capital was reallocated to the controlled supplier for its prepaid wallet gas. Code/state backing and a further 0.005 NEAR platform margin were protected. No extra funding was added.

The buyer created **PO-7886D7BD** through Intear on mainnet: 2 cartons at 0.01 USDC each, with a 0.1 NEAR native storage allowance. The [finalized creation receipt](https://nearblocks.io/txns/3piSPs3xhd5F9A9oxLMoE26HyXko5ejcDeBYx716zGB4) and [public evidence](fixtures/mainnet-order-created-evidence.json) establish creation only. Supplier acceptance, funding with 0.02 USDC and buyer confirmation of one carton are now finalized through Intear. Supplier invoice confirmation, a 0.01 USDC partial payment, the remaining 0.01 USDC token refund and a 0.0689625 NEAR storage refund are now confirmed. The order is Closed with paid quantity 1, pending 0 and no USDC left in the vault. See [browser progress evidence](fixtures/mainnet-browser-progress-evidence.json). Intear returned an incomplete receipt to the app after successful creation; the client now accepts supported outcome envelopes and recovers creation by its unique order ID from finalized records. An unresolved creation is held across reloads rather than generating another wallet request.

## Intents funding implementation

The repository includes a feature-gated NEAR Intents 1Click funding flow. The controlled-buyer feature is now enabled after direct settlement and refunds passed. The first live Intents transfer is being verified. The existing Rhea acquisition remains separate evidence. The API and frontend are deployed, and `intents-funding-v1` is enabled for the configured controlled buyer. The API image is `accord-mainnet-api:2.5.2`; its database backup passed an integrity check before replacement. The existing order, scoped worker and separate testnet service remain intact.

The initial integration accepts at most 0.01 NEAR per request from the configured controlled buyer. Quotes pin wrapped NEAR as input and native NEAR USDC as output, with the same buyer as recipient and refund destination, exact amounts, expiry and a 1% slippage limit. Wallet review precedes an atomic wrapped-NEAR registration/wrap/transfer batch. Receiving USDC in the buyer's wallet and funding an Accord order remain separate transactions. Other source chains are not implemented.

The API stores an unresolved request before asking the wallet to sign. Unknown submissions remain held; status checks never trigger another wallet request. Settlement requires a verified source transaction and a successful native-USDC transfer receipt, rather than only a provider status. Failed, refunded or incomplete swaps remain available for review; provider-reported refunds are not independently established as returned funds. Isolated tests cover expiry, changed recipients/assets, duplicate submission, racing status reads, read outages and forged settlement evidence. These tests do not establish a live swap.

The current application checks pass 73 unit/service tests and 33 isolated browser journeys, including recovery from incomplete wallet receipts. The same 73 application tests passed inside the Linux API image build. These are separate from the existing same-WASM contract sandbox proofs. A read-only 1Click dry quote confirms that 0.01 NEAR is currently quoteable into native USDC; the separately authorized live deposit is now being verified.

## Mainnet worker gas recovery

The initial worker retained a 150 TGas testnet setting. Mainnet RPC rejected its original transaction before inclusion because the required prepaid balance exceeded the service account balance. The worker was paused, and its old signing key was revoked while the balance was still below that transaction cost. The original nonce had not been consumed; after finalized revocation, the old authorization could no longer execute. A replacement key remains limited to request_payment on the same vault with finite 0.09 NEAR allowance. Only then was the retained job requeued with the same request ID and an 80 TGas authorization. Four same-WASM mainnet-domain sandbox checks passed at that gas, including partial payment and replay rejection.

A temporary 0.064 NEAR float from the controlled supplier’s setup balance covered prepaid gas; the entire float was returned after settlement. A further 0.005 NEAR of setup capital was reallocated to the buyer for closure gas. No external funding was added. See [recovery evidence](fixtures/mainnet-worker-recovery-evidence.json). Actual execution consumed much less than the prepaid reserve. The transaction [settled 0.01 USDC](https://nearblocks.io/txns/F8tY6iegPD3VNi3sE5e2Dv4uA9dySPkv3ZwjjwCR9YAL), then [closure returned 0.01 USDC](https://nearblocks.io/txns/FDvVLCf7XpKgrTXAQg8zk4H7VhEXna2BQpaC3CFZWtnW) and [the buyer claimed unused native allowance](https://nearblocks.io/txns/DVCc6ahTnTdvB11mHuUqn4bsYLHcNdDgsPYpWJsdXewP). The remaining 0.0310375 NEAR backs retained records and their storage buffer.
