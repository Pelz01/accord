export const MAINNET_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const MAINNET_USDC_ASSET = `nep141:${MAINNET_USDC}`;
export const VERIFIED_USDC_CODE_HASH = 'DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q';
const YOCTO = 10n ** 24n;

export function nativeAmount(value: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,24})?$/.test(value))
    throw new Error('Use an exact non-negative NEAR amount.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * YOCTO + BigInt(fraction.padEnd(24, '0'));
}

export function nativeDisplay(value: bigint): string {
  if (value < 0n) throw new Error('Negative native amount.');
  const fraction = (value % YOCTO).toString().padStart(24, '0').replace(/0+$/, '');
  return (value / YOCTO).toString() + (fraction ? '.' + fraction : '');
}

export function deploymentBudget(
  wasmBytes: number,
  storagePerByte: bigint,
  cap: bigint,
  orderDeposit = YOCTO,
) {
  if (!Number.isSafeInteger(wasmBytes) || wasmBytes <= 0 || storagePerByte <= 0n || cap < 0n)
    throw new Error('Invalid deployment-budget inputs.');
  const codeStorage = BigInt(wasmBytes) * storagePerByte;
  // Existing contract policy; this deposit stays in the vault rather than becoming a gas fee.
  if (orderDeposit <= 0n) throw new Error('A positive measured order allowance is required.');
  const minimumRequired = codeStorage + orderDeposit;
  return { codeStorage, orderDeposit, minimumRequired, exceedsCap: minimumRequired > cap };
}

export function verifySettlementAsset(
  metadata: { symbol: string; decimals: number },
  codeHash: string,
  assets: { assetId: string; contractAddress?: string; blockchain: string; decimals: number }[],
) {
  if (metadata.symbol !== 'USDC' || metadata.decimals !== 6 || codeHash !== VERIFIED_USDC_CODE_HASH)
    throw new Error('Native USDC metadata or code changed; review before using it.');
  const asset = assets.find(
    (a) =>
      a.assetId === MAINNET_USDC_ASSET &&
      a.blockchain === 'near' &&
      a.contractAddress === MAINNET_USDC &&
      a.decimals === 6,
  );
  if (!asset) throw new Error('Exact native NEAR USDC is absent from the Intents asset list.');
  return asset.assetId;
}
