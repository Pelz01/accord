import { spawnSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { resolve } from 'node:path';

// Rust emits post-MVP target features; lower them before testing on NEAR.
for (const name of process.argv.length > 2
  ? process.argv.slice(2)
  : ['vault', 'token', 'vault-starved']) {
  const input = resolve(`.data/wasm/${name}.wasm`),
    output = resolve(`.data/wasm/${name}.optimized.wasm`);
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/binaryen/bin/wasm-opt'),
      input,
      '-o',
      output,
      '-Oz',
      '--enable-bulk-memory',
      '--signext-lowering',
      '--llvm-memory-copy-fill-lowering',
      '--llvm-nontrapping-fptoint-lowering',
      '--strip-debug',
      '--strip-target-features',
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  renameSync(output, input);
}
