import type { Deployment } from './chain';
import { MAINNET_USDC } from './mainnet-readiness';

export type Network = Deployment['network'];
export const networkRPC = (network: Network) =>
  network === 'mainnet' ? 'https://rpc.fastnear.com' : 'https://test.rpc.fastnear.com';
export const networkExplorer = (network: Network) =>
  network === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';
export const tokenSymbol = (token: string) => (token === MAINNET_USDC ? 'USDC' : 'aUSD');
export const orderAllowance = (network: Network) =>
  network === 'mainnet' ? '100000000000000000000000' : '1000000000000000000000000';
export const tokenRegistration = (network: Network) =>
  network === 'mainnet' ? '1250000000000000000000' : '100000000000000000000000';
export const paymentGas = (network: Network) =>
  network === 'mainnet' ? 80_000_000_000_000n : 150_000_000_000_000n;

// Wallets reserve the entire attached gas allowance before a signature.
// Promise-producing calls retain the contract's enforced minimums.
export function walletGas(network: Network, method: string): string {
  if (network === 'testnet') return '150000000000000';
  const tgas: Record<string, number> = {
    create_order: 50,
    create_automatic_order: 50,
    storage_deposit: 30,
    ft_transfer_call: 70,
    accept_order: 25,
    confirm_delivery: 25,
    confirm_invoice: 25,
    propose_close: 25,
    accept_close: 80,
    retry_refund: 80,
    acknowledge_payment: 40,
    acknowledge_refund: 40,
    claim_native_excess: 40,
    top_up_order_storage: 25,
    acknowledge_native_refund: 40,
    cancel_unfunded_order: 25,
  };
  return (BigInt(tgas[method] ?? 150) * 1_000_000_000_000n).toString();
}

export function assertDeploymentNetwork(d: Deployment, expected: Network) {
  if (d.network !== expected || d.rpcUrl !== networkRPC(expected))
    throw new Error('The workspace deployment does not match its selected network.');
  if (
    expected === 'mainnet' &&
    (d.token !== MAINNET_USDC || [d.vault, d.operator].some((a) => a.endsWith('.testnet')))
  )
    throw new Error('Mainnet deployment requires native USDC and mainnet accounts.');
}
