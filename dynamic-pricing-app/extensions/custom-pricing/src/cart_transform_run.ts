import type {
  CartTransformRunInput,
  CartTransformRunResult,
  Operation,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};

export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  const operations: Operation[] = [];

  for (const line of input.cart.lines) {
    let customPriceCents = 0;

    if (line.customPrice?.value) {
      customPriceCents = parseInt(line.customPrice.value, 10);
    } 
    if (line.fallbackPrice?.value) {
      if (customPriceCents === 0) customPriceCents = parseInt(line.fallbackPrice.value, 10);
    } 
    if (line.customPriceFallback?.value) {
      // It's a string like "$0.40" or "0.40"
      const parsedFloat = parseFloat(line.customPriceFallback.value.replace(/[^0-9.]/g, ''));
      if (!isNaN(parsedFloat)) {
        if (customPriceCents === 0) customPriceCents = Math.round(parsedFloat * 100);
      }
    }

    if (customPriceCents > 0) {
      // Convert shop currency (e.g., USD) to presentment currency (e.g., AUD)
      const rate = parseFloat(input.presentmentCurrencyRate.toString());
      const convertedPrice = ((customPriceCents / 100) * rate).toFixed(2);

      operations.push({
        lineUpdate: {
          cartLineId: line.id,
          price: {
            adjustment: {
              fixedPricePerUnit: {
                amount: convertedPrice
              }
            }
          }
        }
      });
    }
  }

  if (operations.length === 0) {
    return NO_CHANGES;
  }

  return { operations };
}
