import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

// The Accord monogram supplies every icon. No external image service is used.
const original = await readFile('public/brand/accord-mark.svg', 'utf8');
const mark = original.match(/<g\b[\s\S]*<\/g>/)?.[0];
assert.ok(mark, 'The Accord vector mark must be present.');
const file = (path) => pathToFileURL(resolve(path)).href;
const paper = '#fafaf8';
const orange = '#ff3d00';
function icon({ rounded = false, maskable = false } = {}) {
  const size = maskable ? 38 : 48;
  const offset = (64 - size) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="${rounded ? 14 : 0}" fill="${orange}"/><svg x="${offset}" y="${offset}" width="${size}" height="${size}" viewBox="0 0 36 36">${mark.replace('#ff3d00', paper)}</svg></svg>`;
}
await mkdir('.data/brand', { recursive: true });
await writeFile('public/favicon.svg', icon({ rounded: true }) + '\n');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [path, size, options] of [
    ['favicon-16x16.png', 16, { rounded: true }],
    ['favicon-32x32.png', 32, { rounded: true }],
    ['favicon-48x48.png', 48, { rounded: true }],
    ['apple-touch-icon.png', 180, {}],
    ['icon-192.png', 192, {}],
    ['icon-512.png', 512, {}],
    ['icon-maskable-512.png', 512, { maskable: true }],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><head><style>html,body{margin:0;width:100%;height:100%;background:transparent}body>svg{display:block;width:100%;height:100%}</style></head><body>${icon(options)}</body></html>`,
    );
    await page.screenshot({ path: 'public/' + path, omitBackground: true });
  }

  // PNG-backed ICO entries preserve alpha and cover legacy 16/32/48 px tabs.
  const sizes = [16, 32, 48];
  const images = await Promise.all(
    sizes.map((size) => readFile(`public/favicon-${size}x${size}.png`)),
  );
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    header[entry] = size;
    header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  }
  await writeFile('public/favicon.ico', Buffer.concat([header, ...images]));

  const social = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Accord — Keep business moving.</title><style>
@font-face{font-family:Manrope;src:url('${file('node_modules/@fontsource/manrope/files/manrope-latin-500-normal.woff2')}');font-weight:500}
@font-face{font-family:Public;src:url('${file('node_modules/@fontsource/public-sans/files/public-sans-latin-400-normal.woff2')}')}
@font-face{font-family:Bodoni;src:url('${file('node_modules/@fontsource/bodoni-moda/files/bodoni-moda-latin-400-italic.woff2')}');font-style:italic}
*{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px;background:${paper};color:#252321}
main{position:relative;width:1200px;height:630px;overflow:hidden}
.photo{position:absolute;right:0;inset-block:0;width:46%;height:100%;object-fit:cover;object-position:67% center}
.veil{position:absolute;inset:0;background:linear-gradient(90deg,${paper} 0%,${paper} 49%,rgba(250,250,248,.84) 56%,rgba(250,250,248,0) 75%)}
.brand{position:absolute;left:58px;top:46px;display:flex;align-items:center;gap:10px;font:500 34px/1 Manrope;letter-spacing:-2px}
.brand svg{width:32px;height:32px}.brand .period{color:#ff3d00}
h1{position:absolute;left:64px;top:183px;margin:0;font:500 74px/1.08 Manrope;letter-spacing:-4px}
h1 em{display:block;margin-top:7px;font:italic 104px/.95 Bodoni;letter-spacing:-3px;color:#ff3d00}
p{position:absolute;left:66px;top:392px;width:430px;margin:0;font:19px/1.65 Public;color:#706c66}
.url{position:absolute;left:66px;bottom:43px;font:14px Public;color:#706c66}
</style></head><body><main><img class="photo" src="${file('public/images/accord-commerce.jpg')}" alt="Warehouse loading bay"><div class="veil"></div><div class="brand">${original}accord<span class="period">.</span></div><h1>Keep business<em>moving.</em></h1><p>Orders, deliveries and payments,<br>brought together.</p><div class="url">accord-payments.vercel.app</div></main></body></html>`;
  await writeFile('.data/brand/accord-social.html', social);
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.goto(file('.data/brand/accord-social.html'));
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('.photo').evaluate((image) => image.naturalWidth > 0), true);
  await page.screenshot({ path: 'public/images/accord-social.jpg', type: 'jpeg', quality: 92 });

  await writeFile(
    '.data/brand/identity-preview.html',
    `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:40px;background:${paper};color:${orange};font:15px sans-serif}.icons{display:flex;align-items:center;gap:28px;margin-bottom:32px}.tile{display:grid;gap:12px;justify-items:center}.large{width:100px;height:100px;border-radius:22px}.dark{padding:22px;background:#252321;border-radius:12px;display:flex;align-items:center;gap:20px}.social{width:900px;display:block}</style></head><body><div class="icons"><div class="tile"><img src="${file('public/favicon-16x16.png')}" width="16" height="16">16 px</div><div class="tile"><img src="${file('public/favicon-32x32.png')}" width="32" height="32">32 px</div><div class="tile"><img src="${file('public/favicon-48x48.png')}" width="48" height="48">48 px</div><div class="dark"><img src="${file('public/favicon-16x16.png')}" width="16" height="16"><img src="${file('public/favicon-32x32.png')}" width="32" height="32"></div><div class="tile"><img class="large" src="${file('public/apple-touch-icon.png')}">Saved app</div></div><img class="social" src="${file('public/images/accord-social.jpg')}"></body></html>`,
  );
  await page.setViewportSize({ width: 980, height: 730 });
  await page.goto(file('.data/brand/identity-preview.html'));
  await page.screenshot({ path: '.data/brand/identity-preview.png', fullPage: true });
} finally {
  await browser.close();
}
console.log('Built Accord SVG/ICO/PNG favicons, app icons and 1200 × 630 social image.');
