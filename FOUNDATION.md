# Accord foundation evidence

Target: ready by end of 9 November 2026, Lagos time. Status: in progress. This records executed checks and remaining release gates.

| Check                              | Result          | Evidence                                                                                                                                                               |
| ---------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application tests                  | PASS            | 17 tests: validation, extraction boundaries, settlement reservations/callbacks, replay, authority, durable restart, cross-order isolation, and wallet order filtering  |
| TypeScript and production frontend | PASS            | npm run check; simulator excluded from the production frontend                                                                                                         |
| Browser journeys                   | PASS            | Four Playwright tests: landing interaction/responsive layout, disconnected wallet gate, and two isolated harness workflows                                             |
| Rust contract units                | PASS            | 12 tests using near-sdk 5.29.1 mocked environment                                                                                                                      |
| Real NEAR sandbox                  | PASS            | Nine checks on nearcore 2.14.0, actual FT calls/callbacks and failure receipts; fixtures/sandbox-evidence.json                                                         |
| Testnet deployment                 | PASS            | Same artifact hashes as sandbox; fixtures/testnet-evidence.json                                                                                                        |
| Restricted operator key            | PASS            | request_payment only on the vault; negative confirm_delivery call rejected                                                                                             |
| Authenticated durable worker       | PASS            | 400 aUSD payment settled for 40 cartons; fixtures/worker-evidence.json                                                                                                 |
| Browser wallet integration         | IMPLEMENTED     | Direct creation/acceptance/funding/delivery and signed operator authorization; automated browser test covers the disconnected boundary, not a wallet signing extension |
| Hosted Worker                      | PREPARED        | Build and route/configuration smoke; live deployment and D1 runtime verification pending                                                                               |
| Live NEAR AI request               | BLOCKED         | Server credentials have not been configured; user asked to continue other integrations                                                                                 |
| Real recorded AI fixture           | NOT RUN         | Depends on successful real provider request                                                                                                                            |
| Mainnet                            | NOT DEPLOYED    | Network wiring, release/recovery/storage/upgrade review and transaction validation pending                                                                             |
| P1 invoice commitment / P2 refunds | NOT IMPLEMENTED | Separate contract work after core payment correctness                                                                                                                  |

## Receipts and artifacts

PO-TESTNET-001 settled 400 then 300 aUSD after accepted quantity increased from 40 to 70. Final paid quantity 70, pending 0. PO-WORKER-001 separately settled 400 aUSD through the authenticated durable worker. These are testnet transfers, independent of the browser's marketing interaction or development harness.

- Vault: vault.accord-v2-8e0a631d.testnet
- Token: token.accord-v2-8e0a631d.testnet
- Vault WASM SHA-256: def2bdad8270f66707caf87d464b5d4c453619a5ffd7a1d56a9f708a118399b2
- Token WASM SHA-256: e6c7c764a85117b25d65bee5f4ca0bcd3459795cb8b00a538f8f8090869bfa4b

The public fixtures contain deployment identifiers, hashes, receipts, and results only. Signing keys remain ignored. No mainnet transfer or hackathon submission has been made.

## Runtime and reproduction

Node 24.12.0; Rust 1.99.1; near-sdk and near-contract-standards 5.29.1; isolated near-workspaces 5.0.0; official sandbox nearcore 2.14.0. The WASM build enables the NEAR host configuration and lowers unsupported post-MVP features using Binaryen. Negative callback builds remain test-only.

Run npm run check and npm run test:ui for application verification. Run cargo test --locked -p accord-vault, bash sandbox/build.sh, then npm ci and npm test inside sandbox for contract verification. Detailed chain reproduction is in JUDGE.md. Browser screenshots are generated under ignored test-results.

## Design assets

The landing uses warm neutrals, forest green, Manrope/Public Sans and Bodoni Moda. Layout research referenced Mercury, Ramp, and Brex; original generated photographs are integrated with real HTML product panels. The rest of the landing copy remains intact apart from the specific labels the user asked to remove.

Asset generation used the built-in image generation tool. public/images/accord-commerce.jpg and public/images/accord-delivery.jpg are optimized JPEG exports; the originals remain in the local generated-image library.

<details>
<summary>Saved image prompts</summary>

Hero: Use case: ads-marketing. Asset type: photographic hero background for Accord, a premium supplier payments product. Create a photorealistic high-end architectural editorial photograph, horizontal 3:2 landscape. A beautifully composed modern logistics warehouse loading bay, warm sand-colored concrete, tall vertical warehouse windows and a huge open loading doorway, late afternoon sunlight casting strong diagonal shadows. Right half contains a few neatly stacked unbranded corrugated cardboard cartons on a low timber pallet, with a subtle deep forest green metal loading door behind them. Left half is mostly uncluttered warm cream concrete floor and wall, intended to receive a separate real HTML product interface overlay. Precise architectural geometry, quiet material detail, subtle film grain, natural believable warm daylight, sophisticated enterprise fintech campaign art direction, restrained confident composition. Camera slightly elevated, no fisheye, no illustration, no 3D toy rendering. No people, no text of any kind, no logos, no badges, no labels, no watermark, no screens or UI baked into photograph. The photograph should feel like a considered commercial campaign about physical commerce, not a generic stock image.

Workflow: Use case: ads-marketing. Asset type: editorial photograph inside the 'A familiar workflow. A firmer foundation.' section of Accord, a premium supplier payments website. Horizontal landscape photograph with a considered square-friendly center composition. Close-up of a real goods receipt in a refined modern warehouse: the hands and forearms of a Black warehouse receiving professional, wearing a clean muted olive overshirt, holding a thin kraft clipboard near neatly stacked unbranded corrugated cardboard cartons on a wooden pallet. No face needed; the focus is physical goods, checking delivery, honest tactile material. Light neutral paper on clipboard, no readable text or graphics. Warm afternoon side light, subdued forest green loading-bay door in background, rich natural shadow, warm sand and cream palette, light analog grain, authentic architectural commercial photography, extremely photographic not illustration or 3D. Frame human hands and clipboard mostly in upper right quadrant, cartons and olive warehouse context through rest, center-left remains visually quieter for a separate real HTML agreement card overlay. Elegant and believable enterprise fintech art direction. No logos, labels, text, badges, watermarks, computers, fake interface, extra fingers or plastic skin.

</details>
