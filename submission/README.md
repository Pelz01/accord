# Accord submission pack

The mainnet purchase and refund demonstration has passed. The application has not been submitted, and no social post has been published.

## Ready to use

- `materials.json`: project description, proposed tracks, post draft, proof links and a two-minute demo script.
- `POST-CAPTIONS.md`: ready-to-review main post, optional replies, image captions and alt text. Video is optional for this hosted demo.
- `accord-poster.png`: orange-and-black Accord cover image.
- `landing-proof.png`: the public product page, captured from the hosted website.
- `mainnet-order-proof.png`: the live closed mainnet order, payment, token refund and returned storage allowance.
- `mainnet-remittance-proof.png`: the live settled remittance advice.
- `mainnet-remittance.csv`: the actual CSV downloaded from that advice.
- `mainnet-intents-proof.png`: the hosted mainnet Intents result showing USDC received.
- `mainnet-refund-proof.png`: a focused crop of the actual returned funds and retained native backing.
- `../fixtures/mainnet-settlement-evidence.json`: amounts, final states and mainnet transaction hashes.
- `../fixtures/mainnet-ai-invoice-evidence.json`: live NEAR AI invoice extraction metadata.

The controlled order funded 0.02 native USDC, paid 0.01 USDC for one accepted carton, returned 0.01 USDC to the buyer and returned 0.0689625 NEAR of unused allowance. It is Closed with no pending payment. Retained records and their buffer remain backed by 0.0310375 NEAR. The demonstration stayed within the original 3 NEAR funding; internal setup balances were reallocated without additional external funds.

## Intents status

The hosted retry successfully converted 0.01 NEAR into 0.033796 native USDC in mainnett12.near, above the quoted minimum of 0.033461 USDC. Finalized token-transfer evidence and the source receipt are in `../fixtures/mainnet-intents-evidence.json`. The wallet balance after receipt was 0.388316 USDC. Swapping credits the buyer wallet; funding an Accord order is a separate approval. This verifies NEAR-to-USDC conversion on NEAR mainnet, not a swap from another chain.

The first attempt expired and returned its 0.01 NEAR principal. Its refund was independently verified and the request closed before retrying. That history is preserved in `../fixtures/mainnet-intents-first-attempt-evidence.json`.

## Human steps before sending the application

1. Publish the prepared demo post on X with the poster and live screenshots, or a recording following the script. Include that it was built at NEAR HACKATHON, `@NEARProtocol` and `#NEARHackathon`. Save the public post URL.
2. Supply the team lead name, contact email, team size, selected tracks and mainnet prize-payout account. If submitting another independent project, provide its name/link for the required related-project disclosure. These personal submission details stay outside the public repository.
3. Agree to the contact notice: “I agree that the organizers may use these details to review our submission and contact us about this hackathon.” Review the exact final JSON payload before submission. Submit this repository once; subsequent corrections use the request-changes process.

No personal values or consent have been invented or added to this public pack. A screenshot-based post is prepared; recording a video is optional. Publication and application submission remain human steps. Rules source: https://nearhackathon.com/HACKATHON.md

## Recommended screenshot post

Attach the completed order, remittance advice, refund close-up and successful Intents result in that order. The landing screenshot and poster are optional cover images, not substitutes for the live transaction evidence. Caption and image-description text is in POST-CAPTIONS.md. Screenshots show recorded results; no recording of every user action is claimed. The Intents image's Expected amount is the original quote; the finalized actual receipt was 0.033796 USDC.

The related independent project is [Last Light](https://github.com/Pelz01/lastlightgame); Accord's README discloses it. The reciprocal disclosure belongs in that project's README too. The prepared local Downloads pack includes that paragraph for the other repository.
