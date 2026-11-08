import { createHash } from 'node:crypto';
import type {
  ChainJob,
  ChainOrder,
  ChainPaymentPolicy,
  ChainRecovery,
  Deployment,
} from '../shared/chain.ts';
import {
  confirmationsForOrder,
  invoiceCommitment,
  type InvoiceConfirmation,
} from '../shared/invoices.ts';

// Discovery is permissionless. Only a new on-chain automatic order can produce
// a job; the restricted worker and contract still validate it before settlement.
export async function automaticPaymentJob(
  deployment: Deployment,
  order: ChainOrder,
  policy: ChainPaymentPolicy,
  recovery: ChainRecovery,
  confirmations: InvoiceConfirmation[],
  jobs: ChainJob[],
): Promise<ChainJob | null> {
  if (
    !deployment.features?.includes('automatic-v1') ||
    policy.mode !== 'automatic' ||
    order.token !== deployment.token ||
    order.terms.operator !== deployment.operator ||
    !order.accepted_terms ||
    recovery.phase !== 'Open' ||
    BigInt(order.funded) !== BigInt(order.terms.ordered) * BigInt(order.terms.unit_price) ||
    order.attempts >= 64
  )
    return null;
  // Unknown, queued and failed outcomes require resolution, not another payment.
  if (
    jobs.some(
      (job) =>
        job.orderId === order.id &&
        job.vault === deployment.vault &&
        job.network === deployment.network &&
        job.status !== 'settled',
    )
  )
    return null;
  const available = BigInt(order.accepted) - BigInt(order.paid) - BigInt(order.pending);
  if (available <= 0n || BigInt(order.pending) !== 0n) return null;
  for (const confirmation of confirmationsForOrder(order, confirmations)) {
    const commitment = await invoiceCommitment(
      deployment.network,
      deployment.vault,
      confirmation.invoice,
    );
    if (commitment !== confirmation.commitment) continue;
    const recorded = BigInt(
      policy.invoices.find((i) => i.commitment === commitment)?.available ?? '0',
    );
    const invoiceQuantity = BigInt(confirmation.invoice.quantity);
    const remaining = recorded < invoiceQuantity ? recorded : invoiceQuantity;
    const quantity = available < remaining ? available : remaining;
    if (quantity <= 0n) continue;
    const key = JSON.stringify([
      deployment.network,
      deployment.vault,
      order.id,
      commitment,
      order.accepted,
      order.paid,
      order.pending,
      quantity.toString(),
    ]);
    return {
      id: 'auto-' + createHash('sha256').update(key).digest('hex').slice(0, 40),
      network: deployment.network,
      vault: deployment.vault,
      orderId: order.id,
      quantity: quantity.toString(),
      auditHash: confirmation.invoice.document_hash,
      invoice: confirmation.invoice,
      authorization: 'automatic',
      status: 'queued',
      transactionHash: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
  }
  return null;
}
