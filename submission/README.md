# Accord submission pack

The mainnet purchase and refund demonstration has passed. The application has not been submitted, and no social post has been published.

## Ready to use

- `materials.json`: project description, proposed tracks, post draft, proof links and a two-minute demo script.
- `accord-poster.png`: orange-and-black Accord cover image.
- `mainnet-order-proof.png`: the live closed mainnet order, payment, token refund and returned storage allowance.
- `mainnet-remittance-proof.png`: the live settled remittance advice.
- `mainnet-remittance.csv`: the actual CSV downloaded from that advice.
- `../fixtures/mainnet-settlement-evidence.json`: amounts, final states and mainnet transaction hashes.
- `../fixtures/mainnet-ai-invoice-evidence.json`: live NEAR AI invoice extraction metadata.

The controlled order funded 0.02 native USDC, paid 0.01 USDC for one accepted carton, returned 0.01 USDC to the buyer and returned 0.0689625 NEAR of unused allowance. It is Closed with no pending payment. Retained records and their buffer remain backed by 0.0310375 NEAR. The demonstration stayed within the original 3 NEAR funding; internal setup balances were reallocated without additional external funds.

## Intents status

The 0.01 NEAR Intents deposit and bridge receipt are verified on mainnet. The provider still reports PROCESSING, without a verified USDC payout. Do not describe that swap as settled. `../fixtures/mainnet-intents-evidence.json` records this limitation. The app retains the original request and does not offer another deposit while it is unresolved.

## Human steps before sending the application

1. Publish the prepared demo post on X with the poster and live screenshots, or a recording following the script. Include that it was built at NEAR HACKATHON, `@NEARProtocol` and `#NEARHackathon`. Save the public post URL.
2. Supply the team lead name, contact email, team size, selected tracks and mainnet prize-payout account. If submitting another independent project, provide its name/link for the required related-project disclosure. These personal submission details stay outside the public repository.
3. Agree to the contact notice: “I agree that the organizers may use these details to review our submission and contact us about this hackathon.” Review the exact final JSON payload before submission. Submit this repository once; subsequent corrections use the request-changes process.

No personal values or consent have been invented. Video recording, publication and application submission remain human steps. Rules source: https://nearhackathon.com/HACKATHON.md
