// Sales tax, VAT and GST on Marketplace sales. The buyer's country decides the rate. Where a country expects consumer prices to include the tax, the Marketplace
// shows the price with the tax built in and the checkout breaks it down; elsewhere the checkout adds it. The merchant's share is worked out on the price before tax.
// Maestro Pro collects the tax (it is added to the marketplace fee on the payment) and every sale is written to a ledger for the owner's tax returns.
// DRAFT RATES: standard rates for digital goods as last known. Have an accountant check them, and check each country's registration threshold, before relying on them.
import { modify } from "./_blob.js";
import { decimals, minor, currencyFor, rate } from "./_mp.js";

export const LEDGER = "marketplace/tax-ledger.json";

// country: [tax name, rate, prices include it]. Not listed (including the United States, where tax depends on the state): no tax is collected.
export const TAX = {
  // European Union (VAT)
  AT: ["VAT", .20, 1], BE: ["VAT", .21, 1], BG: ["VAT", .20, 1], HR: ["VAT", .25, 1], CY: ["VAT", .19, 1], CZ: ["VAT", .21, 1], DK: ["VAT", .25, 1], EE: ["VAT", .24, 1],
  FI: ["VAT", .255, 1], FR: ["VAT", .20, 1], DE: ["VAT", .19, 1], GR: ["VAT", .24, 1], HU: ["VAT", .27, 1], IE: ["VAT", .23, 1], IT: ["VAT", .22, 1], LV: ["VAT", .21, 1],
  LT: ["VAT", .21, 1], LU: ["VAT", .17, 1], MT: ["VAT", .18, 1], NL: ["VAT", .21, 1], PL: ["VAT", .23, 1], PT: ["VAT", .23, 1], RO: ["VAT", .21, 1], SK: ["VAT", .23, 1],
  SI: ["VAT", .22, 1], ES: ["VAT", .21, 1], SE: ["VAT", .25, 1],
  // Europe, other
  GB: ["VAT", .20, 1], NO: ["VAT", .25, 1], CH: ["VAT", .081, 1], IS: ["VAT", .24, 1], TR: ["VAT", .20, 1],
  // Asia Pacific
  AU: ["GST", .10, 1], NZ: ["GST", .15, 1], JP: ["Consumption tax", .10, 1], SG: ["GST", .09, 1], IN: ["GST", .18, 1], KR: ["VAT", .10, 1], MY: ["Service tax", .08, 1], TH: ["VAT", .07, 1], ID: ["VAT", .11, 1], VN: ["VAT", .10, 1],
  // Americas, Africa and the Middle East
  CA: ["GST", .05, 0], MX: ["VAT", .16, 1], CL: ["VAT", .19, 1], CO: ["VAT", .19, 1], ZA: ["VAT", .15, 1], AE: ["VAT", .05, 1], SA: ["VAT", .15, 1],
};
/** Tax is off while sales are under the registration threshold: set to true to collect it again (the rates, ledger and checkout breakdown all stay as they are). */
export const TAX_ON = false;
export const taxFor = (cc) => { const t = TAX_ON ? TAX[String(cc || "").toUpperCase()] : null; return t ? { name: t[0], rate: t[1], inclusive: Boolean(t[2]) } : { name: "", rate: 0, inclusive: false }; };

/** What a buyer pays, in minor units of their currency, and how it breaks down. The price with its tax is rounded up to the next quarter; the tip is the exact amount, not rounded up. */
export function quote(priceUSD, tipUSD, cur, fx, rate, fee) {
  const base = minor(priceUSD * (1 + rate), cur, fx), tip = Math.round(tipUSD * fx * 10 ** decimals(cur));   // the tip is on the price before tax and never changes the tax
  const tax = rate ? Math.round((base * rate) / (1 + rate)) : 0;
  // Mollie's card fee is built into the price: it is grossed up so that after Mollie takes its fee (pct of the payment + a fixed amount) the price is left whole,
  // then rounded to the nearest quarter (up or down). `fee` in the result is that built-in amount (it can be negative); it is not shown, and the marketplace share is not taken on it.
  const step = decimals(cur) ? 25 : 1, price = fee ? Math.round((base + fee.fixed) / (1 - fee.pct) / step) * step : base, card = price - base;
  return { total: price + tip, tip, tax, net: price - tax, fee: card };
}

/** A ledger row with its amounts in the currency of the country the tax is owed to (converted from US dollars when the buyer paid in another currency). */
export async function inLocal(row) {
  if (row.lcur) return row;
  const lcur = row.cc && TAX[row.cc] ? currencyFor(row.cc) : row.currency;
  if (lcur === row.currency) return { ...row, lcur, lnet: row.net, ltax: row.tax };
  const r = (await rate(lcur)) || 0, d = 10 ** decimals(lcur), c = (u) => Math.round(u * r * d) / d;
  return r ? { ...row, lcur, lnet: c(row.netUSD), ltax: c(row.taxUSD) } : { ...row, lcur: "USD", lnet: row.netUSD, ltax: row.taxUSD };
}

/** Writes a paid sale to the ledger (once). */
export async function recordTax(order, seller) {
  const t = order.tax;
  if (!t) return;
  const k = 10 ** decimals(order.currency), usd = (m) => Math.round((m / k / t.fx) * 100) / 100;
  const row = { id: order.id, t: order.paidAt || Date.now(), cc: t.cc || "", name: t.name, rate: t.rate, currency: order.currency, net: t.net / k, tax: t.tax / k, tip: t.tip / k, total: t.total / k, taxUSD: usd(t.tax), netUSD: usd(t.net), item: order.title, seller, status: "collected" };
  const local = await inLocal(row);
  await modify(LEDGER, (a) => ((a || []).some((x) => x.id === row.id) ? undefined : [...(a || []), local]));
}
/** A refund returns the tax too. */
export const refundTax = (id) => modify(LEDGER, (a) => ((a || []).some((x) => x.id === id) ? a.map((x) => (x.id === id ? { ...x, status: "refunded", refundedAt: Date.now() } : x)) : undefined));
