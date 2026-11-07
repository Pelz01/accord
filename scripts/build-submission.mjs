import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const proof = JSON.parse(await readFile('fixtures/invoice-release-evidence.json', 'utf8'));
assert.equal(proof.network, 'testnet');
assert.ok(proof.paymentTransaction && proof.commitment && proof.checks.length >= 7);
const description =
  'Accord helps buyers pay suppliers for accepted deliveries while keeping AI inside an agreed purchase-order budget. Buyers create and fund fixed terms; suppliers accept the price and payout account; an authorized receiver confirms cumulative deliveries. PDF invoices and scans are processed into text, and NEAR AI Cloud extracts structured fields. The supplier reviews and confirms a canonical commitment covering those fields, the document hash, order terms, network and vault. An operator can then authorize a partial payment. A Rust contract on NEAR independently checks the supplier confirmation and enforces paid + pending <= accepted <= ordered, reserving entitlement before the token transfer. The operator cannot change prices, recipients or delivery records. The product includes wallet-gated orders, private file review, durable payment jobs, receipts, mutual closure and buyer refunds. The hosted application runs on Vercel and an isolated VPS backend. Real testnet transfers, supplier confirmation, PDF/OCR, failed callbacks and recovery have been verified. This release uses testnet aUSD. Mainnet and a complete real-wallet browser journey remain separate release gates; no external audit or invoice-specific payment ledger is claimed.';
assert.ok(description.length >= 20 && description.length <= 2000);
const post =
  'Built Accord at NEAR HACKATHON: AI reads supplier invoices; NEAR contracts enforce agreed terms and delivery-based payment limits. Try it: https://accord-payments.vercel.app Repo: https://github.com/Pelz01/accord @NEARProtocol #NEARHackathon';
assert.ok(post.length <= 280);
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
        'The agent cannot expand its spending authority; contract checks and limited keys constrain settlement.',
    },
    {
      id: 'realworld',
      reason:
        'Purchase orders, supplier invoices, delivery receipts and partial supplier payments.',
    },
  ],
  demoPostDraft: post,
  proofLinks: {
    invoiceConfirmation:
      'https://testnet.nearblocks.io/txns/' +
      proof.transactions.find((t) => t.label === 'confirm_invoice').hash,
    payment: 'https://testnet.nearblocks.io/txns/' + proof.paymentTransaction,
    refund: 'https://testnet.nearblocks.io/txns/5RzNhuARA7TWu7wpXwSArDG2ohmXxZemKXUfPQS9LVdZ',
  },
  demo: [
    {
      time: '0:00-0:15',
      show: 'Landing page, then open the wallet gate.',
      say: 'A supplier can invoice the full order before all the goods arrive. Accord pays only the quantity already accepted.',
    },
    {
      time: '0:15-0:35',
      show: 'A funded purchase order, fixed payout, price, accepted, paid and pending quantities.',
      say: 'The buyer funds agreed terms. A separate supplier accepts them, and the receiver confirms delivery. Those records define the payment limit.',
    },
    {
      time: '0:35-1:00',
      show: 'Upload the synthetic scanned PDF, inspect its preview and OCR text, then extract fields.',
      say: 'OCR reads the scan. NEAR AI extracts fields, and the application checks them against the order. Extraction alone grants no authority.',
    },
    {
      time: '1:00-1:20',
      show: 'Supplier review, the public-field notice, wallet confirmation, then the confirmed commitment.',
      say: 'The supplier confirms these exact fields and this document hash. A changed invoice needs a new confirmation.',
    },
    {
      time: '1:20-1:45',
      show: 'Operator bounded request and the real completed testnet receipt linked in this file.',
      say: 'The operator signs a bounded request. The worker has a limited key. NEAR checks the confirmed invoice and reserves delivery entitlement before sending tokens.',
    },
    {
      time: '1:45-2:00',
      show: 'The verified buyer refund receipt and the public repository.',
      say: 'Both parties can close a settled order and return unused tokens to the buyer. Unknown outcomes stay reserved. The current release is on testnet.',
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
    invoiceConfirmationVerified: true,
    pdfOcrVerified: true,
    mainnetDeployed: false,
    realWalletBrowserJourneyVerified: false,
  },
};
await mkdir('submission', { recursive: true });
await writeFile('submission/materials.json', JSON.stringify(material, null, 2) + '\n');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Accord - NEAR Hackathon</title><style>
@font-face{font-family:Manrope;src:url('../node_modules/@fontsource/manrope/files/manrope-latin-500-normal.woff2')}@font-face{font-family:Public;src:url('../node_modules/@fontsource/public-sans/files/public-sans-latin-400-normal.woff2')}*{box-sizing:border-box}body{margin:0;background:#f4f1e8;color:#183b2a;font-family:Public,sans-serif}.poster{position:relative;width:1280px;height:720px;overflow:hidden}.photo{position:absolute;right:0;top:0;width:47%;height:100%;object-fit:cover;object-position:66% center}.shade{position:absolute;inset:0;background:linear-gradient(90deg,#f4f1e8 0%,#f4f1e8 48%,rgba(244,241,232,.12) 70%,transparent 100%)}.brand{position:absolute;left:64px;top:49px;display:flex;gap:12px;align-items:center;font:500 35px Manrope;letter-spacing:-2px}.symbol{display:flex;gap:4px;transform:skew(-15deg)}.symbol i{display:block;width:12px;height:29px;background:#2b6648}.symbol i+ i{height:24px;margin-top:5px;background:#7a9e83}.tag{position:absolute;top:66px;right:58px;font:11px Manrope;letter-spacing:2px;color:white;text-shadow:0 1px 6px #24382a}h1{position:absolute;left:64px;top:177px;width:650px;margin:0;font:500 76px/1.09 Manrope;letter-spacing:-4px}.sub{position:absolute;left:69px;top:393px;width:440px;font:20px/1.6 Public;color:#5b6f5f}.path{position:absolute;left:69px;top:514px;display:flex;gap:17px;align-items:center;font:13px Manrope;color:#28573c}.path span{color:#879f87}.footer{position:absolute;left:69px;bottom:48px;font:14px Public;letter-spacing:.2px}.footer small{display:block;font-size:11px;opacity:.65;margin-top:9px}
</style></head><body><main class="poster"><img class="photo" src="../public/images/accord-commerce.jpg" alt="Warehouse loading bay"><div class="shade"></div><div class="brand"><span class="symbol"><i></i><i></i></span>accord.</div><div class="tag">NEAR HACKATHON</div><h1>Pay for<br>what arrived.</h1><p class="sub">AI prepares the invoice.<br>Your agreement controls payment.</p><div class="path">Review<span>→</span>Supplier approval<span>→</span>Settlement</div><div class="footer">accord-payments.vercel.app<small>github.com/Pelz01/accord</small></div></main></body></html>`;
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
