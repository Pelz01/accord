import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseDocument } from '../server/document-worker.mjs';

const proof = {
  at: new Date().toISOString(),
  environment: 'native-document-tools',
  poppler: spawnSync('pdfinfo', ['-v'], { encoding: 'utf8' }).stderr.split('\n')[0],
  tesseract: execFileSync('tesseract', ['--version'], { encoding: 'utf8' }).split('\n')[0],
  checks: [],
};
for (const [file, source] of [
  ['invoice-text.pdf', 'pdf-text'],
  ['invoice-scanned.pdf', 'ocr'],
  ['invoice-scan.png', 'ocr'],
]) {
  const bytes = await readFile('fixtures/documents/' + file);
  const before = Date.now();
  const result = await parseDocument(bytes);
  assert.equal(result.source, source);
  assert.equal(result.pages, 1);
  assert.match(result.text, /PO-WORKER-001/);
  assert.match(result.text, /INV-PDF-001/);
  assert.match(result.text, /1000000000/);
  proof.checks.push({
    name: file,
    status: 'PASS',
    source,
    pages: result.pages,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    milliseconds: Date.now() - before,
    text: result.text,
  });
}
const tooMany = await readFile('fixtures/documents/invoice-too-many-pages.pdf');
await assert.rejects(() => parseDocument(tooMany), /1 to 5 pages/);
proof.checks.push({ name: 'six-page PDF rejected', status: 'PASS' });
await assert.rejects(
  () => parseDocument(Buffer.from('<html>not an invoice image</html>')),
  /Upload a PDF/,
);
proof.checks.push({ name: 'unsupported file content rejected', status: 'PASS' });
await assert.rejects(() => parseDocument(Buffer.from('%PDF-1.7\ninvalid PDF body')));
proof.checks.push({ name: 'corrupt PDF rejected', status: 'PASS' });
await assert.rejects(() => parseDocument(Buffer.alloc(2 * 1024 * 1024 + 1)), /no larger than 2 MB/);
proof.checks.push({ name: 'oversized document rejected', status: 'PASS' });
if (!process.env.ACCORD_SMOKE_NO_FILE) {
  await mkdir('.data', { recursive: true });
  await writeFile('.data/document-native-evidence.json', JSON.stringify(proof, null, 2) + '\n');
}
console.log(
  JSON.stringify({
    status: 'PASS',
    checks: proof.checks.length,
    poppler: proof.poppler,
    tesseract: proof.tesseract,
  }),
);
