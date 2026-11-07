import { access, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { x } from 'tar';

export async function prepareRuntime() {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('Run sandbox verification in Linux x64 (Ubuntu/WSL on Windows).');
  const dir = fileURLToPath(new URL('../.data/sandbox-2.14.0/Linux-x86_64/', import.meta.url));
  const binary = `${dir}near-sandbox`;
  try {
    await access(binary);
  } catch {
    const parent = fileURLToPath(new URL('../.data/sandbox-2.14.0/', import.meta.url));
    await mkdir(parent, { recursive: true });
    const archive = `${parent}node.tar.gz`;
    console.log('Downloading pinned NEAR sandbox 2.14.0 from the official distribution.');
    const response = await fetch(
      'https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.14.0/near-sandbox.tar.gz',
      { signal: AbortSignal.timeout(120000) },
    );
    if (!response.ok || !response.body)
      throw new Error(`Sandbox download failed: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    await x({ file: archive, cwd: parent, strict: true });
  }
  // near-workspaces' bundled downloader otherwise selects obsolete protocol 77.
  process.env.NEAR_SANDBOX_BIN_PATH = binary;
  process.env.NEAR_SANDBOX_BINARY_PATH = dir;
  return binary;
}
