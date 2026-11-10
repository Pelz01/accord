# Controlled mainnet release

Mainnet is required for the submission. Direct USDC settlement comes before Intents funding. This is a controlled demonstration with the owner's funds, not an approval to accept customer funds. The existing hosted release remains on testnet.

## Read-only preflight

Run from the repository root after building the vault artifact:

```powershell
npm run verify:mainnet:preflight -- mainnett12.near 2
```

The arguments are a public funding account and an explicit total NEAR ceiling. The check reads finalized mainnet RPC state, the Intents token list and `.data/wasm/vault.wasm`. It writes `.data/mainnet-preflight.json`. It never loads a key, creates a quote or sends a transaction. Exit code 2 means the measured lower bound exceeds the supplied ceiling; exit code 0 does **not** authorize deployment or spending.

The current authorized ceiling is **2 NEAR**, irrespective of the funding account's balance. An explicit USDC funding amount is still required before any order funding or swap.

### Settlement asset verified

- Circle lists native NEAR USDC at `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` in its [issuer contract directory](https://developers.circle.com/stablecoins/usdc-contract-addresses).
- Finalized token metadata reports **6 decimals**. Storage registration reports **0.00125 NEAR** per unregistered account. Recheck before use.
- Observed token code hash: `DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q`. The preflight fails if this changes; review an issuer upgrade instead of silently updating the pin.
- The live [1Click token list](https://1click.chaindefuser.com/v0/tokens) contains the exact NEAR contract, six decimals and asset ID `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`. Listing does not prove route liquidity, minimum size or an executable quote.

### Budget gate

Measured against the existing tested vault, **232,955 bytes**, SHA-256 `2eb011ff5989660c2ce6939ad8bd616e77ca9d7df3fd10d87e0aa9980ac74f04`:

| Requirement | NEAR |
| --- | ---: |
| Code storage at the live protocol rate of 10^19 yoctoNEAR/byte | 2.32955 |
| Existing retained deposit for one order | 1 |
| Lower bound | **3.32955** |

This exceeds the authorized ceiling. It excludes account/key state, gas, token registration, operational balances and USDC acquisition/Intents fees. Storage collateral is locked balance, not burned gas; the order's native deposit is retained separately from any unused-token refund. See [NEAR storage staking](https://docs.near.org/protocol/storage/storage-staking).

The existing artifact is testnet-only. Any mainnet-compatible rebuild or optimization needs a new size measurement, hash, security review and regression checks. Do not strip recovery or authorization features, replace the allocator with an unmaintained dependency, or treat a larger wallet balance as a larger spending authorization.

## Implementation and verification still required

1. Resolve the budget gate. Review a concrete allocation for deployment, one order, registrations, gas and token acquisition within the chosen ceiling. Confirm the USDC amount and controlled supplier account.
2. Add explicit mainnet configuration to the vault, API, finalized chain client, login challenges, wallet connector, explorer links, invoice validation and token displays. Use six-decimal USDC arithmetic. Preserve testnet compatibility.
3. Run a separate mainnet API/worker with separate SQLite, sessions, challenges, configuration and keys. Do not repurpose the testnet database or signer. Bind every financial record to its network, vault and pinned asset.
4. Choose deployment-key custody and give the background worker only a vault-scoped `request_payment` key with finite allowance. Verify the actual deployed code hash, roles and token registration before funding.
5. Prove create → supplier acceptance → direct buyer funding → delivery confirmation → partial payment → finalized receipt with the approved amount. Exercise the hosted two-wallet journey and verify remaining paid, pending and unused amounts.
6. Add Intents as a separate funding step. Validate the exact assets, amount, quote expiry, minimum received, fees, slippage, refund destination and status. Settle the swap into the **buyer's wallet**, then let that buyer fund the order through a separate `ft_transfer_call`. A solver transfer must not bypass the vault's original-buyer funding check.
7. Repeat through the hosted interface and record the submission demonstration. Do not claim completion from token discovery alone.

## Funds-availability limits

The existing [internal security review](SECURITY_REVIEW.md) remains applicable. Unused token withdrawal requires mutual closure after accepted goods are paid and pending transfers are zero. Either party can block closure. Unknown transfers retain their reservations; a timeout does not authorize replacement spending. The native order deposit is not part of the token refund. Use controlled amounts that may remain locked. Independent review and production operations remain outstanding before meaningful customer value.
