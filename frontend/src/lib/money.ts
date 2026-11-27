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
 * An amount in wei, in the agreement's own currency, rounded to cents with exact integer
 * arithmetic (the backend's replies use the same steps, so both show the same figure). Test ETH
 * amounts are rounded to 6 decimals, so a value within that rounding of a whole unit is shown
 * whole: "20,000", not "19,999.99".
 */
export function inCurrency(wei: string, rate: ExchangeRate) {
  const [whole = "0", fraction = ""] = rate.unitsPerEth.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const units = BigInt(whole + fraction);
  const denominator = 10n ** 18n * scale;
  let cents = (BigInt(wei) * units * 100n + denominator / 2n) / denominator;
  const slack = (units * 300n) / (1_000_000n * scale);
  const nearest = ((cents + 50n) / 100n) * 100n;
  if (cents - nearest <= slack && nearest - cents <= slack) cents = nearest;
  const part = cents % 100n;
  const decimals = part ? `.${part.toString().padStart(2, "0").replace(/0$/, "")}` : "";
  return (cents / 100n).toLocaleString("en-US") + decimals;
}

/** " (≈ 500 USD)" after an amount in wei, at the agreement's recorded rate; "" without one. */
export function approximately(wei: string, rate: ExchangeRate | undefined) {
  return rate ? ` (≈ ${inCurrency(wei, rate)} ${rate.currency})` : "";
}
