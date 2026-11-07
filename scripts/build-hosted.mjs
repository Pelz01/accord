import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join, extname } from 'node:path';
import { build } from 'esbuild';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};
const assets = {};
function collect(dir, base = '') {
  for (const name of readdirSync(dir)) {
    if (!base && ['server', '.openai'].includes(name)) continue;
    const path = join(dir, name),
      key = `${base}/${name}`;
    if (statSync(path).isDirectory()) collect(path, key);
    else
      assets[key] = {
        mime: types[extname(name)] || 'application/octet-stream',
        body: readFileSync(path).toString('base64'),
      };
  }
}
collect('dist');
mkdirSync('dist/server', { recursive: true });
mkdirSync('dist/.openai', { recursive: true });
await build({
  entryPoints: ['cloud/worker.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  plugins: [
    {
      name: 'accord-static-assets',
      setup(b) {
        b.onResolve({ filter: /^accord:assets$/ }, () => ({
          path: 'assets',
          namespace: 'accord-assets',
        }));
        b.onResolve({ filter: /^is-my-json-valid$/ }, () => ({
          path: new URL('../cloud/abi-unavailable.ts', import.meta.url).pathname.replace(
            /^\/(.:\/)/,
            '$1',
          ),
        }));
        b.onLoad({ filter: /.*/, namespace: 'accord-assets' }, () => ({
          contents: `export const assets=${JSON.stringify(assets)}`,
          loader: 'js',
        }));
      },
    },
  ],
});
cpSync('.openai/hosting.json', 'dist/.openai/hosting.json');
console.log(`Hosted Worker built with ${Object.keys(assets).length} embedded static assets.`);
