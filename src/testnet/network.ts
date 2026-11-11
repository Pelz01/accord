import { networkExplorer, type Network } from '../../shared/network';

const requested = new URLSearchParams(window.location.search).get('network');
const configured = import.meta.env.VITE_ACCORD_NETWORK ?? 'testnet';
if (
  (requested && !['mainnet', 'testnet'].includes(requested)) ||
  !['mainnet', 'testnet'].includes(configured)
)
  throw new Error('Unsupported Accord network.');
export const selectedNetwork = (requested || configured) as Network;
export const settlementSymbol = selectedNetwork === 'mainnet' ? 'USDC' : 'aUSD';
export const explorerBase = networkExplorer(selectedNetwork);
export function chainFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('x-accord-network', selectedNetwork);
  return fetch(input, { ...init, headers });
}
