import { NearConnector } from '@hot-labs/near-connect';
import type { ConnectorAction } from '@hot-labs/near-connect';
import { selectedNetwork } from './network';
import { walletGas } from '../../shared/network';

let connector: NearConnector | undefined;
export function walletConnector() {
  return (connector ??= new NearConnector({
    network: selectedNetwork,
    features: { ...(selectedNetwork === 'testnet' ? { testnet: true } : {}), signMessage: true },
    autoConnect: false,
    footerBranding: null,
  }));
}
export async function accountId() {
  try {
    return (await walletConnector().getConnectedWallet()).accounts[0]?.accountId ?? null;
  } catch {
    return null;
  }
}
export async function sendCall(
  contract: string,
  methodName: string,
  args: Record<string, unknown>,
  deposit = '0',
  gas = walletGas(selectedNetwork, methodName),
) {
  const wallet = await walletConnector().wallet();
  const signer = (await wallet.getAccounts({ network: selectedNetwork }))[0]?.accountId;
  if (!signer) throw new Error(`Connect a ${selectedNetwork} wallet first.`);
  const action: ConnectorAction = {
    type: 'FunctionCall',
    params: { methodName, args, gas, deposit },
  };
  const result = await wallet.signAndSendTransaction({
    network: selectedNetwork,
    signerId: signer,
    receiverId: contract,
    actions: [action],
  });
  if (typeof result.status === 'object' && 'Failure' in result.status)
    throw new Error(
      'The contract rejected this transaction. Inspect the transaction receipt and refresh.',
    );
  return result.transaction.hash;
}
