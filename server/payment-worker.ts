import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { KeyType, SignedTransaction, baseEncode, encodeTransaction } from 'near-api-js';
import type { ChainAttempt, ChainJob, Deployment } from '../shared/chain.ts';
import { paymentGas } from '../shared/network.ts';

export type StoredPaymentJob = ChainJob & {
  preparedTransaction?: string;
  preparedCodeHash?: string;
};

export class HoldPaymentError extends Error {}

export function paymentArguments(job: ChainJob) {
  return {
    order_id: job.orderId,
    request_id: job.id,
    quantity: job.quantity,
    audit_hash: job.auditHash,
    invoice: job.invoice ?? null,
  };
}

// Signed authorizations stay in the protected database, never in a public API.
export function publicPaymentJob(job: StoredPaymentJob): ChainJob {
  const {
    network,
    vault,
    id,
    orderId,
    quantity,
    auditHash,
    status,
    transactionHash,
    error,
    createdAt,
    invoice,
    authorization,
  } = job;
  return {
    network,
    vault,
    id,
    orderId,
    quantity,
    auditHash,
    status,
    transactionHash,
    error,
    createdAt,
    invoice,
    authorization,
  };
}

export function preparedPayment(job: StoredPaymentJob, deployment: Deployment): SignedTransaction {
  if (
    !/^[a-f0-9]{64}$/.test(deployment.wasmSha256.vault ?? '') ||
    !job.preparedTransaction ||
    job.preparedTransaction.length > 24000 ||
    job.preparedCodeHash !== deployment.wasmSha256.vault ||
    job.network !== deployment.network ||
    job.vault !== deployment.vault
  )
    throw new HoldPaymentError('Stored payment authorization needs review.');
  try {
    const bytes = Buffer.from(job.preparedTransaction, 'base64');
    if (bytes.toString('base64') !== job.preparedTransaction) throw new Error('Invalid encoding');
    const signed = SignedTransaction.decode(bytes);
    const tx = signed.transaction;
    // The SDK decoder returns a plain Borsh signature enum, without Signature.data's getter.
    // The service uses Ed25519 keys; reject other variants rather than inferring their type.
    const signature = signed.signature.ed25519Signature?.data;
    const hash = createHash('sha256').update(encodeTransaction(tx)).digest();
    const call = tx.actions.length === 1 ? tx.actions[0].functionCall : undefined;
    if (
      baseEncode(hash) !== job.transactionHash ||
      tx.signerId !== deployment.operator ||
      tx.receiverId !== deployment.vault ||
      !call ||
      call.methodName !== 'request_payment' ||
      call.deposit !== 0n ||
      (call.gas !== paymentGas(deployment.network) &&
        !(deployment.network === 'mainnet' && call.gas === 150_000_000_000_000n)) ||
      !Buffer.from(signed.encode()).equals(bytes) ||
      !isDeepStrictEqual(JSON.parse(Buffer.from(call.args).toString()), paymentArguments(job)) ||
      tx.publicKey.keyType !== KeyType.ED25519 ||
      !signature ||
      !tx.publicKey.verify(hash, Uint8Array.from(signature))
    )
      throw new Error('Stored authorization mismatch');
    return signed;
  } catch {
    throw new HoldPaymentError('Stored payment authorization needs review.');
  }
}

function reconcile(job: StoredPaymentJob, attempt: ChainAttempt) {
  job.status =
    attempt.status === 'Settled' || attempt.status === 'ReceiptAcknowledged'
      ? 'settled'
      : attempt.status === 'TransferFailed'
        ? 'failed'
        : 'unresolved';
  if (job.status === 'settled' || job.status === 'failed') {
    job.error = null;
    delete job.preparedTransaction;
    delete job.preparedCodeHash;
  }
}

export async function runPaymentJob(
  deployment: Deployment,
  job: StoredPaymentJob,
  io: {
    attempt: () => Promise<ChainAttempt | null>;
    transactionStatus: () => Promise<{ status: unknown }>;
    prepare: () => Promise<SignedTransaction>;
    broadcast: (transaction: SignedTransaction) => Promise<unknown>;
    save: (job: StoredPaymentJob) => void;
  },
) {
  const hold = (message: string) => {
    job.status = 'unresolved';
    job.error = message;
    io.save(job);
  };
  if (job.vault !== deployment.vault || job.network !== deployment.network) {
    hold('This request requires authorization for the current deployment.');
    return;
  }
  const existing = await io.attempt();
  if (existing) {
    reconcile(job, existing);
    io.save(job);
    return;
  }
  if (job.status !== 'queued') {
    try {
      const status = await io.transactionStatus();
      if (status.status && typeof status.status === 'object' && 'Failure' in status.status) {
        job.status = 'failed';
        job.error = 'The contract rejected this request.';
        delete job.preparedTransaction;
        delete job.preparedCodeHash;
        io.save(job);
        return;
      }
      if (status.status && typeof status.status === 'object' && 'SuccessValue' in status.status) {
        hold('The transaction completed. Its payment record needs reconciliation.');
        return;
      }
    } catch {
      /* An unknown receipt can safely rebroadcast only the exact signed bytes. */
    }
    if (!job.preparedTransaction) {
      hold('Submission outcome requires receipt reconciliation. No new transaction was signed.');
      return;
    }
  }
  if (!job.preparedTransaction) {
    try {
      const signed = await io.prepare();
      job.transactionHash = baseEncode(
        createHash('sha256').update(encodeTransaction(signed.transaction)).digest(),
      );
      job.preparedTransaction = Buffer.from(signed.encode()).toString('base64');
      job.preparedCodeHash = deployment.wasmSha256.vault;
      preparedPayment(job, deployment);
    } catch (error) {
      if (error instanceof HoldPaymentError) hold(error.message);
      else {
        job.error = 'Payment service is unavailable. Submission has not started.';
        io.save(job);
      }
      return;
    }
  }
  let transaction: SignedTransaction;
  try {
    transaction = preparedPayment(job, deployment);
  } catch {
    hold('Stored payment authorization needs review.');
    return;
  }
  job.status = 'submitting';
  io.save(job); // Durable authorization precedes every broadcast, including restarts.
  try {
    await io.broadcast(transaction);
    const attempt = await io.attempt();
    if (attempt) reconcile(job, attempt);
    else {
      job.status = 'unresolved';
      job.error = 'Checking the submitted payment receipt.';
    }
  } catch {
    job.status = 'unresolved';
    job.error = 'Checking the submitted payment receipt. Its signed authorization is retained.';
  }
  io.save(job);
}
