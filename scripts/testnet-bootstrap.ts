import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPair, nearToYocto, type KeyPairString } from 'near-api-js';

const provider = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const path = '.data/testnet-credentials.json';
type Credential = { accountId: string; secretKey: KeyPairString; publicKey: string };
type State = { root: Credential; accounts: Record<string, Credential> };
await mkdir('.data', { recursive: true });
let state: State;
try {
  state = JSON.parse(await readFile(path, 'utf8'));
} catch {
  const key = KeyPair.fromRandom('ed25519');
  state = {
    root: {
      accountId: `accord-v2-${randomBytes(4).toString('hex')}.testnet`,
      secretKey: key.toString(),
      publicKey: key.getPublicKey().toString(),
    },
    accounts: {},
  };
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
}
const root = new Account(state.root.accountId, provider, state.root.secretKey);
try {
  await root.getState();
} catch {
  console.log(`Requesting a free testnet development account: ${state.root.accountId}`);
  const response = await fetch('https://helper.testnet.near.org/account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      newAccountId: state.root.accountId,
      newAccountPublicKey: state.root.publicKey,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok)
    throw new Error(
      `Testnet faucet returned ${response.status}. Account credentials were retained locally for a safe retry.`,
    );
  await root.getState();
}
console.log(
  `Testnet root ready: ${state.root.accountId}; native balance ${await root.getBalance()} yoctoNEAR`,
);
for (const [name, amount] of [
  ['vault', '3'],
  ['token', '2'],
  ['buyer', '3'],
  ['supplier', '0.5'],
  ['receiver', '0.5'],
  ['operator', '0.5'],
] as const) {
  if (!state.accounts[name]) {
    const key = KeyPair.fromRandom('ed25519');
    state.accounts[name] = {
      accountId: `${name}.${state.root.accountId}`,
      secretKey: key.toString(),
      publicKey: key.getPublicKey().toString(),
    };
    await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
  const c = state.accounts[name];
  try {
    await new Account(c.accountId, provider).getState();
  } catch {
    await root.createSubAccount({
      accountOrPrefix: name,
      publicKey: c.publicKey,
      nearToTransfer: nearToYocto(amount),
    });
  }
  console.log(`Ready: ${c.accountId}`);
}
