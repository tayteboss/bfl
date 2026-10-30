// The HMAC still identifies the immutable job. The V3 envelope is only an
// actual-quantity consistency check; it is neither authority nor idempotency.
const HEX = /^[a-f0-9]{64}$/;
export function quantitySignature(signature, quantity) {
  if (!HEX.test(signature) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000)
    throw Error('INVALID_QUANTITY_SIGNATURE');
  return `v3:${signature}:${quantity}`;
}
export function immutableSignature(value, quantity) {
  if (typeof value !== 'string') return null;
  if (HEX.test(value)) return value;
  const match = /^v3:([a-f0-9]{64}):([1-9][0-9]*)$/.exec(value);
  return match && Number.isSafeInteger(quantity) && quantity > 0 && quantity <= 10000 &&
    match[2] === String(quantity) ? match[1] : null;
}
