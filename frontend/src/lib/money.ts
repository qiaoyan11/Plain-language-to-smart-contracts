import type { ExchangeRate } from "@/api/types";

/** "1667.36" -> "1,667.36": the recorded rate, grouped for reading. */
const grouped = (value: string) => {
  const [whole = "", part] = value.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (part ? `.${part}` : "");
};

/** The one currency an agreement was written in, if its amounts came from exactly one. */
export function singleRate(rates: ExchangeRate[] | undefined) {
  return rates?.length === 1 ? rates[0] : undefined;
}

/** One line saying how amounts in another currency became test ETH. */
export function rateText(rate: ExchangeRate) {
  const at = `1 test ETH = ${grouped(rate.unitsPerEth)} ${rate.currency}`;
  const time = rate.asOf ? `, ${rate.asOf.slice(11, 16)} UTC` : "";
  if (rate.source === "stated")
    return `Converted from ${rate.currency} at the rate you gave: ${at}.`;
  if (rate.source === "reference")
    return `Converted from ${rate.currency} at a reference rate because no live rate was available: ${at}.`;
  const label = rate.source === "cached" ? "the last available rate" : "the live rate";
  return `Converted from ${rate.currency} at ${label}: ${at}${rate.provider ? ` (${rate.provider}${time})` : ""}.`;
}

/**
 * An amount in wei, in the agreement's own currency. Test ETH amounts are rounded to 6 decimals,
 * so a value within that rounding of a whole unit is shown whole: "20,000", not "19,999.99".
 */
export function inCurrency(wei: string, rate: ExchangeRate) {
  const units = Number(rate.unitsPerEth);
  const value = (Number(BigInt(wei) / 1_000_000n) / 1e12) * units;
  const whole = Math.round(value);
  const shown = Math.abs(value - whole) <= units * 3e-6 ? whole : value;
  return shown.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** " (≈ 500 USD)" after an amount in wei, at the agreement's recorded rate; "" without one. */
export function approximately(wei: string, rate: ExchangeRate | undefined) {
  return rate ? ` (≈ ${inCurrency(wei, rate)} ${rate.currency})` : "";
}
