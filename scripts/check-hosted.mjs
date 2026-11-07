import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../dist/server/index.js';

const context = {
  waitUntil() {
    throw new Error('No background work expected.');
  },
};
const request = (path, options) =>
  worker.fetch(new Request(`https://accord.example${path}`, options), {}, context);
const home = await request('/');
assert.equal(home.status, 200);
assert.match(home.headers.get('Content-Type'), /text\/html/);
assert.match(await home.text(), /Accord/);
assert.equal((await request('/workspace')).status, 200);
assert.equal((await request('/dev/simulator')).status, 404);
assert.equal((await request('/missing.png')).status, 404);
const image = await request('/images/accord-commerce.jpg');
assert.equal(image.status, 200);
assert.equal(image.headers.get('Content-Type'), 'image/jpeg');
assert.equal(
  (await image.arrayBuffer()).byteLength,
  readFileSync('public/images/accord-commerce.jpg').length,
);
assert.equal((await request('/api/health')).status, 200);
assert.equal((await request('/api/chain/state')).status, 503);
assert.equal(
  (
    await request('/api/chain/submit', {
      method: 'POST',
      headers: { Origin: 'https://other.example' },
    })
  ).status,
  403,
);
console.log(
  'Hosted bundle smoke passed: assets, workspace routing, simulator exclusion, health, configuration and origin gates.',
);
