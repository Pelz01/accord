import { z } from 'zod';
import { accountSchema, integerString } from './schema';
import { MAINNET_USDC_ASSET, nativeAmount } from './mainnet-readiness';

export const WRAPPED_NEAR = 'wrap.near';
export const WRAPPED_NEAR_ASSET = 'nep141:wrap.near';
export const MAX_CONTROLLED_SWAP = nativeAmount('0.01');
const rawQuoteSchema = z.object({
  quoteRequest: z.object({
    dry: z.boolean(),
    swapType: z.literal('EXACT_INPUT'),
    originAsset: z.literal(WRAPPED_NEAR_ASSET),
    destinationAsset: z.literal(MAINNET_USDC_ASSET),
    depositType: z.literal('ORIGIN_CHAIN'),
    recipientType: z.literal('DESTINATION_CHAIN'),
    refundType: z.literal('ORIGIN_CHAIN'),
    recipient: accountSchema,
    refundTo: accountSchema,
    amount: integerString,
    slippageTolerance: z.number().int().min(1).max(100),
    deadline: z.string(),
  }),
  quote: z.object({
    amountIn: integerString,
    amountOut: integerString,
    minAmountOut: integerString,
    depositAddress: accountSchema.optional(),
    timeEstimate: z.number().nonnegative().optional(),
  }),
});
export type FundingQuote = {
  account: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  depositAddress: string;
  deadline: string;
  slippageBps: number;
};
export type FundingStage =
  | 'quoted'
  | 'awaiting-wallet'
  | 'submitted'
  | 'settled'
  | 'needs-review'
  | 'cancelled';
export type FundingRecord = {
  id: string;
  account: string;
  network: 'mainnet';
  vault: string;
  createdAt: number;
  stage: FundingStage;
  request: ReturnType<typeof fundingRequest>;
  quote: FundingQuote;
  registrations: { account: string; deposit: string }[];
  sourceHash: string | null;
  sourceVerified: boolean;
  destinationHash: string | null;
  providerStatus: string | null;
  error: string | null;
};
export function fundingRequest(account: string, amount: string, deadline: string, dry = false) {
  accountSchema.parse(account);
  const units = nativeAmount(amount);
  if (units <= 0n || units > MAX_CONTROLLED_SWAP)
    throw new Error('Use at most 0.01 NEAR for this controlled funding check.');
  return {
    dry,
    swapType: 'EXACT_INPUT' as const,
    slippageTolerance: 100,
    originAsset: WRAPPED_NEAR_ASSET,
    depositType: 'ORIGIN_CHAIN' as const,
    destinationAsset: MAINNET_USDC_ASSET,
    amount: units.toString(),
    recipient: account,
    recipientType: 'DESTINATION_CHAIN' as const,
    refundTo: account,
    refundType: 'ORIGIN_CHAIN' as const,
    deadline,
  };
}
export function validateFundingQuote(
  raw: unknown,
  expected: ReturnType<typeof fundingRequest>,
  now = Date.now(),
): FundingQuote {
  const parsed = rawQuoteSchema.parse(raw),
    request = parsed.quoteRequest,
    quote = parsed.quote;
  if (
    request.dry !== expected.dry ||
    request.amount !== expected.amount ||
    request.recipient !== expected.recipient ||
    request.refundTo !== expected.refundTo ||
    request.deadline !== expected.deadline ||
    request.slippageTolerance !== expected.slippageTolerance ||
    quote.amountIn !== expected.amount ||
    BigInt(quote.amountOut) <= 0n ||
    BigInt(quote.minAmountOut) <= 0n ||
    BigInt(quote.minAmountOut) > BigInt(quote.amountOut) ||
    BigInt(quote.minAmountOut) <
      (BigInt(quote.amountOut) * BigInt(10000 - request.slippageTolerance)) / 10000n
  )
    throw new Error('The funding quote changed its approved amounts, recipient or refund terms.');
  const deadline = Date.parse(request.deadline);
  if (!Number.isFinite(deadline) || deadline <= now + 30000 || deadline > now + 10 * 60000)
    throw new Error('The funding quote is expired or has an invalid lifetime.');
  if (
    !expected.dry &&
    (!quote.depositAddress ||
      [expected.recipient, WRAPPED_NEAR, 'intents.near'].includes(quote.depositAddress))
  )
    throw new Error('The quote has no valid independent NEAR deposit address.');
  return {
    account: request.recipient,
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    minAmountOut: quote.minAmountOut,
    depositAddress: quote.depositAddress ?? '',
    deadline: request.deadline,
    slippageBps: request.slippageTolerance,
  };
}

export type FundingAction = {
  type: 'FunctionCall';
  params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
};
export function fundingActions(
  quote: FundingQuote,
  registrations: { account: string; deposit: string }[] = [],
): FundingAction[] {
  accountSchema.parse(quote.account);
  accountSchema.parse(quote.depositAddress);
  if (
    BigInt(quote.amountIn) <= 0n ||
    BigInt(quote.amountIn) > MAX_CONTROLLED_SWAP ||
    quote.account === quote.depositAddress
  )
    throw new Error('Invalid funding instructions.');
  if (
    registrations.length > 2 ||
    registrations.some(
      (r) =>
        ![quote.account, quote.depositAddress].includes(r.account) ||
        BigInt(r.deposit) <= 0n ||
        BigInt(r.deposit) > nativeAmount('0.002'),
    )
  )
    throw new Error('Invalid wrapped-NEAR registration instructions.');
  return [
    ...registrations.map((r) => ({
      type: 'FunctionCall' as const,
      params: {
        methodName: 'storage_deposit',
        args: { account_id: r.account, registration_only: true },
        gas: '10000000000000',
        deposit: r.deposit,
      },
    })),
    {
      type: 'FunctionCall',
      params: {
        methodName: 'near_deposit',
        args: {},
        gas: '30000000000000',
        deposit: quote.amountIn,
      },
    },
    {
      type: 'FunctionCall',
      params: {
        methodName: 'ft_transfer',
        args: { receiver_id: quote.depositAddress, amount: quote.amountIn },
        gas: '50000000000000',
        deposit: '1',
      },
    },
  ];
}
