// Shared helpers for the Maestro Pro marketplace (see marketplace.js). Secrets come from Vercel environment variables:
//   MOLLIE_API_KEY         the platform's own Mollie key (test_... or live_...), used for listings the site owner adds.
//   MOLLIE_CLIENT_ID, MOLLIE_CLIENT_SECRET   the Mollie Connect app, used to onboard sellers and charge on their behalf.
//   MOLLIE_LIVE            "1" to go live for seller payments (OAuth payments run in test mode otherwise).
//   MARKETPLACE_ADMIN_KEY  the password for maestro-pro.app/marketplace/add.
//   MARKETPLACE_SECRET     signs the onboarding "state". BLOB_READ_WRITE_TOKEN: the Blob store (already connected).
import crypto from "node:crypto";

export const SITE = "https://maestro-pro.app";
export const API = "https://fider-feedback-api.vercel.app";
export const CUT = 0.3;   // the marketplace's share of every seller's sale
const ORIGINS = [SITE, "https://www.maestro-pro.app", "http://localhost:8000"];

export function cors(req, res) {
  const o = req.headers.origin;
  if (ORIGINS.includes(o)) { res.setHeader("Access-Control-Allow-Origin", o); res.setHeader("Vary", "Origin"); }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-MP-Key");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

export const rand = (n = 16) => crypto.randomBytes(n).toString("hex");
export const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const isAdmin = (key) => Boolean(process.env.MARKETPLACE_ADMIN_KEY) && Boolean(key) && same(String(key), process.env.MARKETPLACE_ADMIN_KEY);

const hmac = (s) => crypto.createHmac("sha256", process.env.MARKETPLACE_SECRET || "").update(s).digest("base64url");
export const sign = (obj) => { const p = Buffer.from(JSON.stringify(obj)).toString("base64url"); return `${p}.${hmac(p)}`; };
export function unsign(s) {
  const [p, mac] = String(s).split(".");
  if (!p || !mac || !process.env.MARKETPLACE_SECRET || !same(mac, hmac(p))) return null;
  try { return JSON.parse(Buffer.from(p, "base64url").toString()); } catch { return null; }
}

// ---- Prices: sellers set whole US dollars; buyers are charged in their own currency (Mollie's list, rates from the ECB via frankfurter).
const ZONES = {
  EUR: "AT BE BG CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK AD MC SM VA ME",
  GBP: "GB GG JE IM", CHF: "CH LI", AUD: "AU", BRL: "BR", CAD: "CA", CZK: "CZ", DKK: "DK", HKD: "HK", HUF: "HU", ILS: "IL", ISK: "IS",
  JPY: "JP", MXN: "MX", MYR: "MY", NOK: "NO", NZD: "NZ", PHP: "PH", PLN: "PL", RON: "RO", SEK: "SE", SGD: "SG", THB: "TH", ZAR: "ZA",
};
const CURRENCY = {};
for (const [c, list] of Object.entries(ZONES)) for (const k of list.split(" ")) CURRENCY[k] = c;
export const currencyFor = (country) => CURRENCY[String(country || "").toUpperCase()] || "USD";
export const decimals = (cur) => (cur === "JPY" || cur === "ISK" ? 0 : 2);

let rates = { at: 0, v: {} };
/** USD -> `cur`, or null when the rate can't be had (the caller then charges in dollars). */
export async function rate(cur) {
  if (cur === "USD") return 1;
  if (Date.now() - rates.at > 6 * 3600e3) {
    try {
      const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD", { signal: AbortSignal.timeout(5000) });
      if (r.ok) rates = { at: Date.now(), v: (await r.json()).rates || {} };
    } catch { /* keep any older rates */ }
  }
  return rates.v[cur] || null;
}
/** Whole dollars -> the charge in minor units of `cur`, rounded up. */
export const minor = (usd, cur, r) => Math.ceil(usd * r * 10 ** decimals(cur) - 1e-6);
export const fmt = (m, cur) => (m / 10 ** decimals(cur)).toFixed(decimals(cur));

/** A whole number of dollars from 1 to 999, or null. Anything with a fraction is refused, never rounded. */
export function wholePrice(v) {
  const s = String(v ?? "").trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 999 ? n : null;
}

// ---- Mollie
export const live = () => process.env.MOLLIE_LIVE === "1";
export async function mollie(method, path, token, body) {
  const r = await fetch("https://api.mollie.com/v2" + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
export async function oauth(form) {
  const r = await fetch("https://api.mollie.com/oauth2/tokens", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${process.env.MOLLIE_CLIENT_ID}:${process.env.MOLLIE_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
