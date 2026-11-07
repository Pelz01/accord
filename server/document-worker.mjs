import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const MAX_FILE = 2 * 1024 * 1024;
export function documentType(bytes) {
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    if (bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16_000_000)
      throw Error('Image dimensions exceed the limit.');
    return 'image/png';
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    for (let i = 2; i + 9 < bytes.length; ) {
      if (bytes[i] !== 255) break;
      const marker = bytes[i + 1];
      if (marker === 217 || marker === 218) break;
      if (marker === 255) {
        i++;
        continue;
      }
      const size = bytes.readUInt16BE(i + 2);
      if (size < 2) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (bytes.readUInt16BE(i + 5) * bytes.readUInt16BE(i + 7) > 16_000_000)
          throw Error('Image dimensions exceed the limit.');
        return 'image/jpeg';
      }
      i += size + 2;
    }
    throw Error('The JPEG header is invalid.');
  }
  throw Error('Upload a PDF, PNG or JPEG document.');
}

export async function parseDocument(bytes) {
  if (!bytes.length || bytes.length > MAX_FILE)
    throw Error('Documents must be no larger than 2 MB.');
  const mediaType = documentType(bytes);
  const directory = await mkdtemp(join(tmpdir(), 'accord-document-'));
  const deadline = Date.now() + 25000;
  async function tool(binary, args) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error('Document processing timed out.');
    return execute(binary, args, {
      timeout: Math.min(10000, remaining),
      maxBuffer: 256 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        TMPDIR: directory,
        OMP_THREAD_LIMIT: '1',
        LC_ALL: 'C.UTF-8',
      },
    });
  }
  async function ocr(filename) {
    const result = await tool('tesseract', [filename, 'stdout', '-l', 'eng', '--psm', '6', 'tsv']);
    const lines = [];
    let lineKey = '';
    let words = [];
    const confidence = [];
    for (const row of result.stdout.split('\n').slice(1)) {
      const fields = row.split('\t');
      if (fields.length < 12 || fields[0] !== '5' || !fields.slice(11).join('\t').trim()) continue;
      const key = fields.slice(1, 5).join(':');
      if (lineKey && key !== lineKey) {
        lines.push(words.join(' '));
        words = [];
      }
      lineKey = key;
      words.push(fields.slice(11).join('\t'));
      confidence.push(Number(fields[10]));
    }
    if (words.length) lines.push(words.join(' '));
    if (!confidence.length || confidence.reduce((a, b) => a + b, 0) / confidence.length < 40)
      throw Error('The scan is unclear. Upload a sharper document.');
    return lines.join('\n');
  }
  try {
    const input = join(
      directory,
      mediaType === 'application/pdf'
        ? 'input.pdf'
        : mediaType === 'image/png'
          ? 'input.png'
          : 'input.jpg',
    );
    await writeFile(input, bytes, { mode: 0o600 });
    let pages = 1;
    let source = 'ocr';
    let text = '';
    let preview = bytes;
    let previewType = mediaType;
    if (mediaType === 'application/pdf') {
      const info = (await tool('pdfinfo', [input])).stdout;
      if (/^Encrypted:\s+yes/im.test(info))
        throw Error('Password-protected PDFs are not supported.');
      pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
      if (!Number.isInteger(pages) || pages < 1 || pages > 5)
        throw Error('Upload a PDF with 1 to 5 pages.');
      const texts = [];
      let scanned = false;
      for (let page = 1; page <= pages; page++) {
        let pageText = (
          await tool('pdftotext', [
            '-f',
            String(page),
            '-l',
            String(page),
            '-layout',
            '-enc',
            'UTF-8',
            input,
            '-',
          ])
        ).stdout.trim();
        if (pageText.replace(/\s/g, '').length < 40) {
          const output = join(directory, 'page-' + page);
          await tool('pdftoppm', [
            '-f',
            String(page),
            '-l',
            String(page),
            '-singlefile',
            '-scale-to',
            '1800',
            '-png',
            input,
            output,
          ]);
          pageText = await ocr(output + '.png');
          scanned = true;
        }
        texts.push(pageText);
      }
      text = texts.join('\n\n');
      source = scanned ? 'ocr' : 'pdf-text';
      const output = join(directory, 'preview');
      await tool('pdftoppm', [
        '-f',
        '1',
        '-l',
        '1',
        '-singlefile',
        '-scale-to',
        '1000',
        '-jpeg',
        input,
        output,
      ]);
      preview = await readFile(output + '.jpg');
      previewType = 'image/jpeg';
    } else text = await ocr(input);
    if (text.trim().length < 20) throw Error('No readable invoice text was found.');
    if (Buffer.byteLength(text) > 32768)
      throw Error('The document contains too much text. Upload a shorter invoice.');
    return {
      text,
      pages,
      source,
      previewBase64: preview.toString('base64'),
      previewType,
      mediaType,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function documentServer() {
  let active = false;
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, body) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/parse') return send(404, { error: 'Not found.' });
    if (active)
      return send(503, { error: 'Document processing is busy. Please try again shortly.' });
    active = true;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_FILE) {
          send(413, { error: 'Documents must be no larger than 2 MB.' });
          return;
        }
        chunks.push(chunk);
      }
      send(200, await parseDocument(Buffer.concat(chunks)));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const known =
        /^(Upload|Documents must|Image dimensions|The JPEG|Document processing timed|The scan|Password-protected|No readable|The document contains)/.test(
          message,
        );
      send(422, {
        error: known
          ? message
          : 'This document could not be read. Try another PDF or a clearer scan.',
      });
    } finally {
      active = false;
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  documentServer().listen(Number(process.env.PORT) || 3002, '0.0.0.0');
