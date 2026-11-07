import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../server/document-worker.mjs', import.meta.url));
const windows = process.platform === 'win32';
if (windows && !/^[A-Za-z]:\\/.test(file))
  throw Error('A local drive path is required for the document worker.');
const linuxPath = windows
  ? '/mnt/' + file[0].toLowerCase() + file.slice(2).replaceAll('\\', '/')
  : file;
const distro = process.env.ACCORD_DOCUMENT_WSL || 'Ubuntu';
const linuxNode = windows
  ? execFileSync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', 'node -p process.execPath'], {
      encoding: 'utf8',
    }).trim()
  : '';
if (windows && !linuxNode.startsWith('/'))
  throw Error('Node.js is unavailable in the document runtime.');
const child = windows
  ? spawn('wsl.exe', ['-d', distro, '--', 'env', 'PORT=3003', linuxNode, linuxPath], {
      stdio: 'inherit',
    })
  : spawn(process.execPath, [file], { stdio: 'inherit', env: { ...process.env, PORT: '3003' } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
child.on('error', () => {
  console.error(
    'Document tools are unavailable. Install Poppler and Tesseract in the development runtime.',
  );
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
