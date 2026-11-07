# Accord foundation evidence

Target: ready by end of 9 November 2026, Lagos time. Status: in progress. This records executed checks and remaining release gates.

| Check                              | Result       | Evidence                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application tests                  | PASS         | 30 tests: validation, extraction boundaries, settlement reservations/callbacks, replay, authority, durable restart, cross-order isolation, wallet order filtering, authoritative payment-history merging, and recorded live-AI replay/failure handling           |
| TypeScript and production frontend | PASS         | npm run check; simulator excluded from the production frontend                                                                                                                                                                                                   |
| Browser journeys                   | PASS         | Eight Playwright tests: landing interaction/responsive layout, disconnected wallet gate, connected payment-history filtering/receipts/disconnection, wallet-authenticated invoice processing, two closure/recovery workflows, and two isolated harness workflows |
| Rust contract units                | PASS         | 30 tests using near-sdk 5.29.1 mocked environment                                                                                                                                                                                                                |
| Real NEAR sandbox                  | PASS         | 20 checks on nearcore 2.14.0: nine settlement and eleven recovery/upgrade checks; fixtures/sandbox-evidence.json and fixtures/recovery-sandbox-evidence.json                                                                                                     |
| Testnet deployment                 | PASS         | Recovery artifact matches both sandbox suites; fixtures/recovery-testnet-evidence.json; initial deployment in fixtures/testnet-evidence.json                                                                                                                     |
| Restricted operator key            | PASS         | request_payment only on the vault; negative confirm_delivery call rejected                                                                                                                                                                                       |
| Authenticated durable worker       | PASS         | 400 aUSD payment settled for 40 cartons; fixtures/worker-evidence.json                                                                                                                                                                                           |
| Browser wallet integration         | IMPLEMENTED  | Direct creation/acceptance/funding/delivery and signed operator authorization; automated browser test covers the disconnected boundary, not a wallet signing extension                                                                                           |
| Hosted deployment                  | PASS         | Vercel frontend + VPS API at https://accord-payments.vercel.app; live wallet/AI/payment checks, restart persistence and backups verified; fixtures/hosted-evidence.json                                                                                          |
| Live NEAR AI request               | PASS         | Real GLM-5.3 Flash extraction: 100 cartons / 1,000 aUSD; app HTTP endpoint verified; incomplete invoice rejected; testnet order unchanged                                                                                                                        |
| Real recorded AI fixture           | PASS         | fixtures/near-ai-extraction.json: synthetic input, SHA-256, real provider request IDs, extracted fields, timing, HTTP result, and rejection check                                                                                                                |
| Mainnet                            | NOT DEPLOYED | Network wiring, release/recovery/storage/upgrade review and transaction validation pending                                                                                                                                                                       |
| Closure / token refunds            | PASS         | Mutual approvals, 300 aUSD testnet refund, failed-refund retry and callback recovery in real sandbox                                                                                                                                                             |

## Receipts and artifacts

PO-TESTNET-001 settled 400 then 300 aUSD after accepted quantity increased from 40 to 70. Final paid quantity 70, pending 0. PO-WORKER-001 first settled 400 aUSD through the authenticated worker, then another 300 aUSD through the hosted Vercel/VPS flow after acceptance increased to 70. Its latest paid quantity is 70, pending 0. These are testnet transfers, independent of the browser's marketing interaction or development harness.

- Vault: vault.accord-v2-8e0a631d.testnet
- Token: token.accord-v2-8e0a631d.testnet
- Vault WASM SHA-256: d278c88f43b47ae249a2443b779defc5090fc6362a7c1070b0915807f1d2af66
- Token WASM SHA-256: e6c7c764a85117b25d65bee5f4ca0bcd3459795cb8b00a538f8f8090869bfa4b

The public fixtures contain deployment identifiers, hashes, receipts, and results only. Signing keys remain ignored. No mainnet transfer or hackathon submission has been made.

## Runtime and reproduction

Development Node 24.12.0; VPS container Node 24.22.2; Rust 1.99.1; near-sdk and near-contract-standards 5.29.1; isolated near-workspaces 5.0.0; official sandbox nearcore 2.14.0. The WASM build enables the NEAR host configuration and lowers unsupported post-MVP features using Binaryen. Negative callback builds remain test-only.

Run npm run check and npm run test:ui for application verification. Run cargo test --locked -p accord-vault, bash sandbox/build.sh, then npm ci and npm test inside sandbox for contract verification. Detailed chain reproduction is in JUDGE.md. Browser screenshots are generated under ignored test-results.

## Hosted release

https://accord-payments.vercel.app is the public frontend. The VPS directory is /home/ubuntu/accord and the container is accord-api. The initial hosted release used source 763e771 and Vercel deployment dpl_8MnDxGJBTVf7ace79Lc9djUGh8JK. The hosted worker settled 300 aUSD in transaction AYYhh1rsLzPndbSfB2ecwmqDGSra4F8dBNiXUkKXpBkm. The database retained both completed worker jobs after a container restart, passed integrity checks, and was backed up successfully.

Browser UI inspection confirmed the deployed landing page and wallet gate. A real browser-wallet transaction journey remains a separate release check; the hosted signature/payment smoke uses the NEAR SDK and generated testnet accounts.

## Recovery release

The testnet contract is version 2.1.0-recovery. The atomic upgrade preserved all existing orders, tracked payment attempts and the vault token balance. PO-TESTNET-001 then refunded its remaining 300 aUSD in transaction 5RzNhuARA7TWu7wpXwSArDG2ohmXxZemKXUfPQS9LVdZ. Its final recovery state is Closed, refunded 300000000, refund_pending 0. The separate worker order remains Open with paid 70 and pending 0.

Recipient acknowledgment recovers successful transfers with failed callbacks without sending funds again. It does not release unknown failed transfers. Both success-with-starved-callback paths and definitive refund failure/retry were exercised in real NEAR sandbox. Native storage/call deposits remain retained. P1 invoice commitments, PDF/OCR and final submission materials remain incomplete.

## Design assets

The landing uses warm neutrals, forest green, Manrope/Public Sans and Bodoni Moda. Layout research referenced Mercury, Ramp, and Brex; original generated photographs are integrated with real HTML product panels. The rest of the landing copy remains intact apart from the specific labels the user asked to remove.

Asset generation used the built-in image generation tool. public/images/accord-commerce.jpg and public/images/accord-delivery.jpg are optimized JPEG exports; the originals remain in the local generated-image library.

<details>
<summary>Saved image prompts</summary>

Hero: Use case: ads-marketing. Asset type: photographic hero background for Accord, a premium supplier payments product. Create a photorealistic high-end architectural editorial photograph, horizontal 3:2 landscape. A beautifully composed modern logistics warehouse loading bay, warm sand-colored concrete, tall vertical warehouse windows and a huge open loading doorway, late afternoon sunlight casting strong diagonal shadows. Right half contains a few neatly stacked unbranded corrugated cardboard cartons on a low timber pallet, with a subtle deep forest green metal loading door behind them. Left half is mostly uncluttered warm cream concrete floor and wall, intended to receive a separate real HTML product interface overlay. Precise architectural geometry, quiet material detail, subtle film grain, natural believable warm daylight, sophisticated enterprise fintech campaign art direction, restrained confident composition. Camera slightly elevated, no fisheye, no illustration, no 3D toy rendering. No people, no text of any kind, no logos, no badges, no labels, no watermark, no screens or UI baked into photograph. The photograph should feel like a considered commercial campaign about physical commerce, not a generic stock image.

Workflow: Use case: ads-marketing. Asset type: editorial photograph inside the 'A familiar workflow. A firmer foundation.' section of Accord, a premium supplier payments website. Horizontal landscape photograph with a considered square-friendly center composition. Close-up of a real goods receipt in a refined modern warehouse: the hands and forearms of a Black warehouse receiving professional, wearing a clean muted olive overshirt, holding a thin kraft clipboard near neatly stacked unbranded corrugated cardboard cartons on a wooden pallet. No face needed; the focus is physical goods, checking delivery, honest tactile material. Light neutral paper on clipboard, no readable text or graphics. Warm afternoon side light, subdued forest green loading-bay door in background, rich natural shadow, warm sand and cream palette, light analog grain, authentic architectural commercial photography, extremely photographic not illustration or 3D. Frame human hands and clipboard mostly in upper right quadrant, cartons and olive warehouse context through rest, center-left remains visually quieter for a separate real HTML agreement card overlay. Elegant and believable enterprise fintech art direction. No logos, labels, text, badges, watermarks, computers, fake interface, extra fingers or plastic skin.

</details>
