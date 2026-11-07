// near-api-js's optional ABI wrapper generates functions at runtime, which edge
// isolates prohibit. Accord uses explicit Account/Provider calls instead. Fail
// closed if a future change accidentally tries to use that unsupported wrapper.
export default function unsupportedAbiValidator(): never {
  throw new Error(
    'ABI wrappers are unavailable in the hosted runtime. Use explicit validated calls.',
  );
}
