import type { ExchangeRate } from "@/api/types";
import { formatWei } from "@/api/client";

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
  const time = rate.asOf ? ` ${rate.asOf.slice(11, 16)} UTC` : "";
  if (rate.source === "stated") return `Rate: ${at}, as you stated.`;
  if (rate.source === "reference")
    return `Rate: ${at}, a reference rate (no live rate was available).`;
  const label = rate.source === "cached" ? "last available rate" : "live rate";
  return `Rate: ${at} (${label}${rate.provider ? `, ${rate.provider}${time}` : ""}).`;
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

/**
 * An amount for people: in the agreed currency first when the agreement has one, with the exact
 * test ETH the contract holds after it ("800 USD (0.482742 test ETH)").
 */
export function amountText(wei: string, rate: ExchangeRate | undefined) {
  const eth = `${formatWei(wei)} test ETH`;
  return rate ? `${inCurrency(wei, rate)} ${rate.currency} (${eth})` : eth;
}

/** " (≈ 500 USD)" after an amount in wei, at the agreement's recorded rate; "" without one. */
export function approximately(wei: string, rate: ExchangeRate | undefined) {
  return rate ? ` (≈ ${inCurrency(wei, rate)} ${rate.currency})` : "";
}
