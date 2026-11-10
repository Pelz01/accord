import type { ChainPaymentPolicy, Deployment } from './chain.ts';

export const customerApprovalMethods = new Set([
  'accept_order',
  'confirm_delivery',
  'confirm_invoice',
  'propose_close',
  'cancel_close',
  'accept_close',
  'retry_refund',
  'acknowledge_payment',
  'acknowledge_refund',
]);

export function customerApprovalDeposit(
  deployment: Deployment,
  method: string,
  policy?: ChainPaymentPolicy,
): '0' | '1' {
  if (
    deployment.features?.includes('native-deposits-v1') &&
    ['claim_native_excess', 'acknowledge_native_refund', 'cancel_unfunded_order'].includes(method)
  )
    return '1';
  if (
    !deployment.features?.includes('customer-approval-v1') ||
    !customerApprovalMethods.has(method)
  )
    return '0';
  if (!policy) throw new Error('Refresh this order before approving the transaction.');
  return policy.mode === 'automatic' ? '1' : '0';
}
