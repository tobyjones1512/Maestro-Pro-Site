// Shared helpers for the licence endpoints. Secrets come from Vercel environment variables:
// GOCARDLESS_ACCESS_TOKEN, LICENCE_SECRET, and GOCARDLESS_ENV ("live" to go live; anything else is sandbox).
import crypto from "node:crypto";

const BASE = process.env.GOCARDLESS_ENV === "live" ? "https://api.gocardless.com" : "https://api-sandbox.gocardless.com";
export const ORIGINS = ["https://whiskerswordquest.app", "https://www.whiskerswordquest.app"];
export const PRICES = { month: { amount: 3500, unit: "monthly" }, year: { amount: 35000, unit: "yearly" } };

export async function gc(method, path, body, idempotencyKey) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GOCARDLESS_ACCESS_TOKEN}`,
      "GoCardless-Version": "2015-07-06",
      Accept: "application/json",
      ...(body && { "Content-Type": "application/json" }),
      ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
    },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

export const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

const tag = (id) => crypto.createHmac("sha256", process.env.LICENCE_SECRET).update(id).digest("hex").slice(0, 10).toUpperCase();
export const makeKey = (subscriptionId) => `WWQ-${subscriptionId}-${tag(subscriptionId)}`;
/** Returns the GoCardless subscription id inside a genuine key, or null. */
export function parseKey(key) {
  const m = /^WWQ-(SB[A-Z0-9]+)-([A-F0-9]{10})$/.exec(String(key ?? "").trim().toUpperCase());
  return m && crypto.timingSafeEqual(Buffer.from(tag(m[1])), Buffer.from(m[2])) ? m[1] : null;
}

/** Sets CORS headers; returns true when the request has been fully answered. */
export function cors(req, res, methods) {
  const origin = req.headers.origin;
  if (ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", `${methods}, OPTIONS`);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  if (req.method !== methods) { res.status(405).json({ error: `${methods} only.` }); return true; }
  return false;
}

// ---- Maestro Pro student licences: MPS-<GoCardless customer id>-<signature>, like the Whiskers' Word Quest keys.
const stuTag = (id) => crypto.createHmac("sha256", process.env.LICENCE_SECRET).update("maestro-students:" + id).digest("hex").slice(0, 10).toUpperCase();
export const studentKey = (customerId) => `MPS-${customerId}-${stuTag(customerId)}`;
/** The GoCardless customer id inside a genuine key, or null. */
export function parseStudentKey(key) {
  const m = /^MPS-(CU[A-Z0-9]+)-([A-F0-9]{10})$/.exec(String(key ?? "").trim().toUpperCase());
  return m && crypto.timingSafeEqual(Buffer.from(stuTag(m[1])), Buffer.from(m[2])) ? m[1] : null;
}
export const validEmail = (e) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(e) && e.length <= 200;

/** Every GoCardless customer id with this email. */
export async function customersByEmail(email) {
  const want = norm(email);
  // ponytail: scans every customer (500 a page); fine for hundreds of students, store ids if it grows.
  let after = "", ids = [];
  for (let page = 0; page < 20; page++) {
    const r = (await gc("GET", `/customers?limit=500${after && `&after=${after}`}`)).data;
    ids.push(...(r.customers || []).filter((c) => norm(c.email) === want).map((c) => c.id));
    after = r.meta?.cursors?.after;
    if (!after) break;
  }
  return ids;
}

export const isMaestro = (x) => /maestro pro/i.test(x ?? "");

/** True when this customer's latest bill is paid or on its way, for a plan with "Maestro Pro" in its title, at any price
 *  (students pay £48 a year or £6 a month, schools more): a one-off payment from the last year, or an active
 *  subscription or instalment schedule. */
export async function studentHasPaid(customerId) {
  // A cancellation records when access ends on the customer (see student-cancel.js); after that date the key stops working.
  const until = (await gc("GET", `/customers/${customerId}`)).data.customers?.metadata?.maestro_access_until;
  if (until && Date.now() > Date.parse(until)) return false;
  // Bacs takes days, so a payment still on its way counts; one that failed, was cancelled or was charged back does not.
  const bad = ["failed", "cancelled", "customer_approval_denied", "charged_back"];
  const pays = ((await gc("GET", `/payments?customer=${customerId}`)).data.payments || []).sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at));
  const latest = pays[0];
  if (!latest || bad.includes(latest.status)) return false;
  if (isMaestro(latest.description) && Date.parse(latest.created_at) > Date.now() - 366 * 864e5) return true;
  const subs = (await gc("GET", `/subscriptions?customer=${customerId}&status=active`)).data.subscriptions || [];
  if (subs.some((x) => isMaestro(x.name))) return true;
  const inst = (await gc("GET", `/instalment_schedules?customer=${customerId}`)).data.instalment_schedules || [];
  return inst.some((x) => ["pending", "active"].includes(x.status) && isMaestro(x.name));
}

/** The titles of what this customer is paying for: active Maestro Pro subscriptions and instalment schedules, or, for a
 *  one-off payment, its description. Used to tell several keys apart in the key email. */
export async function studentPlans(customerId) {
  const subs = (await gc("GET", `/subscriptions?customer=${customerId}&status=active`)).data.subscriptions || [];
  const inst = (await gc("GET", `/instalment_schedules?customer=${customerId}`)).data.instalment_schedules || [];
  const names = [...subs, ...inst.filter((x) => ["pending", "active"].includes(x.status))].map((x) => x.name).filter(isMaestro);
  if (!names.length) {
    const pays = ((await gc("GET", `/payments?customer=${customerId}`)).data.payments || []).filter((p) => isMaestro(p.description) && !p.metadata?.cancellation_fee);
    pays.sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at));
    if (pays[0]) names.push(pays[0].description);
  }
  return [...new Set(names)];
}
