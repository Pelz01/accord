import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Tests get a fresh database and separate ports. Never reuse or reset the user's workspace.
const env = {
  ...process.env,
  PORT: '3002',
  ACCORD_API_PORT: '3002',
  ACCORD_DATA_PATH: `.data/browser-${randomUUID()}.sqlite`,
};
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env, stdio: 'inherit' }),
  spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5174'],
    { env, stdio: 'inherit' },
  ),
];
function stop() {
  for (const child of children) child.kill();
}
for (const child of children)
  child.on('exit', (code) => {
    stop();
    process.exit(code ?? 0);
  });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
