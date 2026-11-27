import { describe, expect, it } from "vitest";
import type { ExchangeRate } from "@/api/types";
import { approximately } from "@/lib/money";

const cny: ExchangeRate = {
  currency: "CNY",
  unitsPerEth: "11125.07",
  source: "live",
  asOf: "2026-11-27T19:05:00Z",
  provider: "CoinGecko",
};

describe("amounts in the agreement's currency", () => {
  it("shows a whole amount instead of the 6-decimal rounding of its test ETH", () => {
    // 20,000 CNY and 109,800 CNY after rounding to 6 ETH decimals.
    expect(approximately("1797741000000000000", cny)).toBe(" (≈ 20,000 CNY)");
    expect(approximately("9869600000000000000", cny)).toBe(" (≈ 109,800 CNY)");
  });
  it("keeps cents that are really there", () => {
    expect(
      approximately("1000000000000000000", { ...cny, unitsPerEth: "1667.36", currency: "USD" }),
    ).toBe(" (≈ 1,667.36 USD)");
    expect(
      approximately("7496000000000000", { ...cny, unitsPerEth: "1667.36", currency: "USD" }),
    ).toBe(" (≈ 12.5 USD)");
  });
});
