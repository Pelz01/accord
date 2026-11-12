import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const proof = JSON.parse(await readFile('fixtures/mainnet-settlement-evidence.json', 'utf8'));
assert.equal(proof.network, 'mainnet');
assert.equal(proof.phase, 'Closed');
assert.equal(proof.pending, '0');
assert.equal(proof.supplierReceivedUsdcBaseUnits, '10000');
assert.equal(proof.buyerRefundUsdcBaseUnits, '10000');
let intents = null;
try {
  intents = JSON.parse(await readFile('fixtures/mainnet-intents-evidence.json', 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
const intentsVerified =
  intents?.stage === 'settled' && intents?.sourceVerified === true && !!intents?.destinationHash;
const description =
  'Accord brings purchase orders, deliveries, invoices and supplier payments together. A buyer creates and funds an order; the supplier accepts its price and payment account. The buyer confirms deliveries with the same wallet, or appoints a receiver. NEAR AI Cloud extracts invoice fields from text, PDFs or scans. The supplier reviews and confirms the exact invoice and document hash. Accord’s background worker then requests eligible payment. A Rust contract on NEAR fixes the recipient and price, accounts for paid and pending quantities, and limits payment to confirmed deliveries and supplier-approved invoices. Customers use two wallets; no operator wallet is required. The product includes buyer payables, a supplier view, remittance advice, CSV export, mutual closure and storage-deposit refunds. The hosted mainnet check funded 0.02 native USDC, paid 0.01 USDC for one carton, refunded the unused 0.01 USDC and returned 0.0689625 NEAR of unused storage allowance. PDF/OCR and failure recovery have separate testnet and sandbox evidence. ' +
  (intentsVerified
    ? 'NEAR Intents funding is verified on mainnet: swap NEAR into native USDC in the buyer’s wallet, then fund an order separately. '
    : 'Intents funding is implemented; its live transfer check is still pending. ') +
  'This is a controlled release, without an external audit or a claim of readiness for customer funds.';
assert(description.length >= 20 && description.length <= 2000);
const post =
  'Pay suppliers as deliveries arrive. Accord connects agreed orders, confirmed goods and supplier-approved invoices to payments on NEAR. Built at NEAR HACKATHON.\nhttps://accord-payments.vercel.app\nhttps://github.com/Pelz01/accord\n@NEARProtocol #NEARHackathon';
assert(post.length <= 280);
const tx = (hash) => 'https://nearblocks.io/txns/' + hash;
const material = {
  draft: true,
  projectName: 'Accord',
  description,
  publicRepository: 'https://github.com/Pelz01/accord',
  liveProduct: 'https://accord-payments.vercel.app',
  proposedTracks: [
    {
      id: 'security',
      reason:
        'Contract limits, confirmed invoices, reservations and restricted service keys constrain execution.',
    },
    {
      id: 'realworld',
      reason: 'Buyer and supplier purchasing, native USDC settlement, remittance and refunds.',
    },
  ],
  demoPostDraft: post,
  proofLinks: {
    contract:
      'https://nearblocks.io/address/10f816f5fbf84d7c6cb0c5bd5e79e02be90260e3d58f85ed8317c215439280bf',
    invoiceConfirmation: tx('Gk3RrKAiMm8Fv65yr8PQ2zB2Jae2Jm5yoR4c67XfEb6M'),
    payment: tx(proof.transactions.payment),
    refund: tx(proof.transactions.closure),
    nativeDepositRefund: tx(proof.transactions.nativeRefund),
    ...(intentsVerified
      ? { intentsFunding: tx(intents.sourceHash), intentsUSDCReceipt: tx(intents.destinationHash) }
      : {}),
  },
  demo: [
    {
      time: '0:00-0:20',
      show: 'Landing page, then completed mainnet order PO-7886D7BD.',
      say: 'Accord brings buying teams and suppliers together around one order. Each uses their own wallet.',
    },
    {
      time: '0:20-0:45',
      show: 'Two cartons ordered, one accepted, and supplier-confirmed invoice ACC-MAINNET-7886D7BD-1.',
      say: 'The buyer confirms what arrived. NEAR AI extracts invoice fields; the supplier confirms them. Extraction alone cannot authorize payment.',
    },
    {
      time: '0:45-1:15',
      show: 'Settled 0.01 USDC payment, remittance advice and mainnet receipt.',
      say: 'The worker pays in the background. NEAR fixes the recipient and price, reserves pending amounts and prevents payment beyond accepted quantities.',
    },
    {
      time: '1:15-1:40',
      show: 'Closed order, 0.01 USDC refunded and 0.0689625 NEAR returned.',
      say: 'Both parties approved closure. Unused payment funds returned to the buyer, separately from unused storage allowance. Retained records remain backed.',
    },
    {
      time: '1:40-2:00',
      show: intentsVerified
        ? 'Intents source and destination receipts, then the repository.'
        : 'Public repository and mainnet transaction evidence.',
      say: intentsVerified
        ? 'NEAR Intents adds USDC to the buyer’s wallet. Funding an order is a separate approval.'
        : 'The repository contains reproducible checks and the mainnet receipts behind this demonstration.',
    },
  ],
  recordingState: {
    scriptPrepared: true,
    videoRecorded: false,
    publicPostPublished: false,
    applicationSubmitted: false,
  },
  humanDetailsDeferred: true,
  submissionRulesSource: 'https://nearhackathon.com/HACKATHON.md',
  readiness: {
    mainnetDeployed: true,
    mainnetSettlementVerified: true,
    mainnetTokenRefundVerified: true,
    mainnetNativeRefundVerified: true,
    invoiceConfirmationVerified: true,
    pdfOcrVerifiedOnTestnet: true,
    realWalletBuyerJourneyVerified: true,
    supplierAcceptanceAndInvoiceVerifiedThroughWallet: true,
    supplierClosureProposalUsedControlledSdk: true,
    intentsMainnetVerified: !!intentsVerified,
    externalAudit: false,
  },
};
await mkdir('submission', { recursive: true });
await writeFile('submission/materials.json', JSON.stringify(material, null, 2) + '\n');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Accord - NEAR Hackathon</title><style>
@font-face{font-family:Manrope;src:url('../node_modules/@fontsource/manrope/files/manrope-latin-500-normal.woff2')}@font-face{font-family:Public;src:url('../node_modules/@fontsource/public-sans/files/public-sans-latin-400-normal.woff2')}*{box-sizing:border-box}body{margin:0;background:#f4f1e8;color:#171717;font-family:Public,sans-serif}.poster{position:relative;width:1280px;height:720px;overflow:hidden}.photo{position:absolute;right:0;top:0;width:47%;height:100%;object-fit:cover;object-position:66% center}.shade{position:absolute;inset:0;background:linear-gradient(90deg,#f4f1e8 0%,#f4f1e8 48%,rgba(244,241,232,.12) 70%,transparent 100%)}.brand{position:absolute;left:64px;top:49px;display:flex;gap:12px;align-items:center;font:500 35px Manrope;letter-spacing:-2px}.poster-mark{display:block;width:34px;height:34px}.tag{position:absolute;top:66px;right:58px;font:11px Manrope;letter-spacing:2px;color:white;text-shadow:0 1px 6px #171717}h1{position:absolute;left:64px;top:177px;width:650px;margin:0;font:500 76px/1.09 Manrope;letter-spacing:-4px}.sub{position:absolute;left:69px;top:393px;width:440px;font:20px/1.6 Public;color:#514d4a}.path{position:absolute;left:69px;top:514px;display:flex;gap:17px;align-items:center;font:13px Manrope;color:#e53600}.path span{color:#ff3d00}.footer{position:absolute;left:69px;bottom:48px;font:14px Public;letter-spacing:.2px}.footer small{display:block;font-size:11px;opacity:.65;margin-top:9px}
</style></head><body><main class="poster"><img class="photo" src="../public/images/accord-commerce.jpg" alt="Warehouse loading bay"><div class="shade"></div><div class="brand"><img class="poster-mark" src="../public/brand/accord-mark.svg" alt="">accord.</div><div class="tag">NEAR HACKATHON</div><h1>Keep business<br>moving.</h1><p class="sub">Orders, deliveries and payments,<br>brought together.</p><div class="path">Agree<span>·</span>Receive<span>·</span>Pay</div><div class="footer">accord-payments.vercel.app<small>github.com/Pelz01/accord</small></div></main></body></html>`;
await writeFile('submission/accord-poster.html', html);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(resolve('submission/accord-poster.html')).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'submission/accord-poster.png' });
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({
    descriptionCharacters: description.length,
    postCharacters: post.length,
    materials: 'submission/materials.json',
    poster: 'submission/accord-poster.png',
    personalDetailsIncluded: false,
    submitted: false,
  }),
);
