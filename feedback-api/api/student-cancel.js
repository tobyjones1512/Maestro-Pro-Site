// Maestro Pro licence cancellation, from the support site. Two calls with the same body shape:
//   { key, action: "check" }                       -> what would happen, and what it would cost or refund. Changes nothing.
//   { key, action: "confirm", refund?, fee? }      -> does it (only if refund/fee still match what check said).
// Rules, counted in days from the charge date of the first payment (day 0):
//   day 0-7   refund not possible yet (the payment has not cleared): tell them the date to come back.
//   day 8-14  refund every cleared payment, then cancel subscriptions, instalments and mandates.
//   day 15+   no refund. Annual: cancel the subscription and the mandate; access runs to the end of the year paid for.
//             Monthly: charge 1 month + 50% of the rest of the 12-month term through the mandate (amounts taken from the
//             bills on GoCardless), then cancel subscriptions and instalments but KEEP the mandate.
// Retention offers, never published on the site, only sent in the cancellation response and email:
//  - Professional at £5/month, rolling, offered with every cancellation (but not on the page when a yearly plan has
//    more than 1.5 months left, only in the email);
//  - Professional at £2.50/month, rolling, the final offer, shown to someone cancelling the £5 plan.
// A rolling plan is a monthly subscription of one of those amounts with no count or end date; cancelling it is free and instant.
// Offered after a refund. It has no refund window, no 14-day wait and no fee: cancelling stops it straight away.
// Needs GOCARDLESS_ACCESS_TOKEN, LICENCE_SECRET, RESEND_API_KEY. GoCardless refunds must be enabled on the account.
import { gc, parseStudentKey } from "./_gc.js";
import { logActivity, TEST_EMAIL } from "./_activity.js";

const ORIGINS = ["https://maestro-pro.app", "https://www.maestro-pro.app", "https://thecaffeinemediacompany.com", "https://www.thecaffeinemediacompany.com"];
const TERM_MONTHS = 12;
const RETENTION_PENCE = 500;
const RETENTION_URL = "https://pay.gocardless.com/BRT01M6STVRK3EGKX9FKBBSXD912J";
const FINAL_PENCE = 250;
const FINAL_URL = "https://pay.gocardless.com/BRT01M6SXT2JKHB119DCQS72QZ0TG";
export const OFFER_P = { title: "Before you go: Professional for £5 a month.", text: "Keep every Professional feature, including the score editor and version history, for half the usual monthly price. It rolls month to month, and you can cancel any time with no fee and no waiting period.", cta: "Keep Professional for £5 a month", url: RETENTION_URL };
export const OFFER_FINAL = { title: "Before you go: Professional for £2.50 a month.", text: "Keep every Professional feature, including the score editor and version history, for a quarter of the usual monthly price. It rolls month to month, and you can cancel any time with no fee and no waiting period.", cta: "Keep Professional for £2.50 a month", url: FINAL_URL };
/** The offer for this cancellation: none for someone leaving the £2.50 plan (the last offer), £2.50 for someone leaving the £5 plan, otherwise £5. */
const offerFor = (a) => (a.activeSubs.some((x) => x.amount === FINAL_PENCE && x.interval_unit === "monthly") ? null : a.activeSubs.some((x) => x.amount === RETENTION_PENCE && x.interval_unit === "monthly" && !x.count && !x.end_date) ? OFFER_FINAL : OFFER_P);
/** On the page, not for a yearly plan with more than 1.5 months still to run (the email always has it). */
const offerOnPage = (a, now = Date.now()) => (a.outcome === "cancel" && !a.monthly && a.valid.length && a.accessUntil - now > 45 * DAY ? null : offerFor(a));
const DAY = 864e5;
const OWNER = "hello@thecaffeinemediacompany.com";
const MIN_WORDS = 20;
const wordCount = (t) => String(t ?? "").trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const BAD = ["failed", "cancelled", "customer_approval_denied", "charged_back"];
const NOT_COLLECTED = ["pending_customer_approval", "pending_submission"]; // can still be cancelled
const IN_FLIGHT = ["submitted", "confirmed", "paid_out"]; // collected or on its way
const CLEARED = ["confirmed", "paid_out"]; // refundable
const isMaestro = (x) => /maestro pro/i.test(x ?? "");
const gbp = (p) => "£" + (p / 100).toFixed(2);
const dateStr = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const midnight = (ms) => Math.floor(ms / DAY) * DAY;
const addMonths = (ms, n) => { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + n); return d.getTime(); };
const fail = (status, error) => Object.assign(new Error(error), { status });

async function all(path, key) {
  const out = [];
  let after = "";
  for (let page = 0; page < 10; page++) {
    const r = (await gc("GET", `${path}${path.includes("?") ? "&" : "?"}limit=500${after && `&after=${after}`}`)).data;
    out.push(...(r[key] || []));
    after = r.meta?.cursors?.after;
    if (!after) break;
  }
  return out;
}

// ---- Test keys. Only when the MAESTRO_TEST_KEYS environment variable is "1" on Vercel: keys like MPS-TEST-REFUND
// run each route against made-up payments, touch nothing at GoCardless and send no email. Leave it unset in normal use.
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);
const tSub = (unit, amount, name = "Maestro Pro Professional") => ({ id: "SBTEST", name, status: "active", interval_unit: unit, interval: 1, amount, links: { mandate: "MDTEST" } });
const tPay = (daysAgo, status, amount, id = "PMTEST" + daysAgo) => ({ id, status, amount, amount_refunded: 0, charge_date: iso(daysAgo), description: "Maestro Pro Professional", links: { subscription: "SBTEST", mandate: "MDTEST" } });
const TEST_WORLDS = {
  "MPS-TEST-EARLY": { subs: [tSub("yearly", 8900)], pays: [tPay(3, "submitted", 8900)] }, // day 3: too early
  "MPS-TEST-CLEARING": { subs: [tSub("yearly", 8900)], pays: [tPay(9, "submitted", 8900)] }, // day 9 but not cleared
  "MPS-TEST-REFUND": { subs: [tSub("yearly", 8900)], pays: [tPay(10, "paid_out", 8900)] }, // day 10, annual: refund
  "MPS-TEST-REFUND-MONTHLY": { subs: [tSub("monthly", 1000)], pays: [tPay(10, "paid_out", 1000), tPay(-20, "pending_submission", 1000, "PMNEXT")] }, // day 10, monthly: refund
  "MPS-TEST-ANNUAL-LATE": { subs: [tSub("yearly", 8900)], pays: [tPay(40, "paid_out", 8900)] }, // day 40, annual: cancel, no refund
  "MPS-TEST-MONTHLY-FEE": { subs: [tSub("monthly", 1000)], pays: [tPay(70, "paid_out", 1000), tPay(40, "paid_out", 1000), tPay(10, "paid_out", 1000), tPay(-20, "pending_submission", 1000, "PMNEXT")] }, // 3 paid: fee 50.00
  "MPS-TEST-MONTHLY-LATE": { subs: [tSub("monthly", 1000)], pays: [tPay(20, "paid_out", 1000), tPay(-10, "pending_submission", 1000, "PMNEXT")] }, // 1 paid: fee 60.00
  "MPS-TEST-ROLLING": { subs: [tSub("monthly", RETENTION_PENCE)], pays: [tPay(3, "submitted", RETENTION_PENCE)] }, // retention plan: free, instant
  "MPS-TEST-ROLLING-FINAL": { subs: [tSub("monthly", FINAL_PENCE)], pays: [tPay(3, "submitted", FINAL_PENCE)] }, // the £2.50 plan: free, instant, no offer
  "MPS-TEST-CANCELLED": { mandate: "cancelled", subs: [{ ...tSub("yearly", 8900), status: "cancelled" }], pays: [tPay(40, "paid_out", 8900)] }, // already cancelled
};
const testKey = (key) => (process.env.MAESTRO_TEST_KEYS === "1" && TEST_WORLDS[String(key ?? "").trim().toUpperCase()] ? String(key).trim().toUpperCase() : null);

/** Everything about this customer's Maestro Pro licence, and the outcome the rules give today. */
async function assess(customerId, now = Date.now()) {
  let customer, subsAll, schedsAll, pays, mandates;
  if (TEST_WORLDS[customerId]) {
    const w = TEST_WORLDS[customerId];
    customer = { id: "CUTEST", email: "test@example.com", metadata: {} };
    ({ subs: subsAll, pays } = w); schedsAll = []; mandates = [{ id: "MDTEST", status: w.mandate || "active" }];
  } else {
    customer = (await gc("GET", `/customers/${customerId}`)).data.customers;
    if (!customer) throw fail(404, "We can't find that licence.");
    [subsAll, schedsAll, pays, mandates] = await Promise.all([
      all(`/subscriptions?customer=${customerId}`, "subscriptions"),
      all(`/instalment_schedules?customer=${customerId}`, "instalment_schedules"),
      all(`/payments?customer=${customerId}`, "payments"),
      all(`/mandates?customer=${customerId}`, "mandates"),
    ]);
  }
  const subs = subsAll.filter((s) => isMaestro(s.name));
  const scheds = schedsAll.filter((s) => isMaestro(s.name));
  const subIds = new Set(subs.map((s) => s.id)), schedIds = new Set(scheds.map((s) => s.id));
  const plan = pays
    .filter((p) => !p.metadata?.cancellation_fee && (subIds.has(p.links?.subscription) || schedIds.has(p.links?.instalment_schedule) || isMaestro(p.description)))
    .sort((a, b) => Date.parse(a.charge_date) - Date.parse(b.charge_date));
  const valid = plan.filter((p) => !BAD.includes(p.status));

  const activeSubs = subs.filter((s) => ["active", "pending_customer_approval"].includes(s.status));
  const activeScheds = scheds.filter((s) => ["pending", "active"].includes(s.status));
  const pending = valid.filter((p) => NOT_COLLECTED.includes(p.status));
  const mandateIds = new Set([...subs, ...scheds].map((x) => x.links?.mandate).concat(plan.map((p) => p.links?.mandate)).filter(Boolean));
  const activeMandates = mandates.filter((m) => mandateIds.has(m.id) && ["pending_customer_approval", "pending_submission", "submitted", "active"].includes(m.status));

  const base = { customer, activeSubs, activeScheds, pending, activeMandates, valid };
  if (!valid.length && !activeSubs.length && !activeScheds.length && !activeMandates.length) throw fail(404, "We can't find a Maestro Pro payment or plan for that licence key.");
  if (!activeSubs.length && !activeScheds.length && !pending.length && !activeMandates.length) return { ...base, outcome: "already_cancelled" };

  // The rolling £5 plan cancels at once, free, whatever day it is.
  if (activeSubs.length && activeSubs.every((s) => s.interval_unit === "monthly" && [RETENTION_PENCE, FINAL_PENCE].includes(s.amount) && !s.count && !s.end_date)) {
    const last = valid.filter((p) => IN_FLIGHT.includes(p.status)).pop();
    const paidTo = last ? addMonths(Date.parse(last.charge_date), 1) : 0;
    return { ...base, monthly: true, outcome: "cancel_rolling", fee: 0, refund: 0, accessUntil: Math.max(midnight(now), midnight(paidTo)) };
  }

  const monthly =
    activeSubs.some((s) => s.interval_unit === "monthly" && (s.interval ?? 1) === 1) ||
    scheds.some((s) => {
      const ps = valid.filter((p) => p.links?.instalment_schedule === s.id);
      return ps.length > 1 && Date.parse(ps[1].charge_date) - Date.parse(ps[0].charge_date) < 60 * DAY;
    });
  base.monthly = monthly;

  if (!valid.length) return { ...base, outcome: "cancel", fee: 0, refund: 0, accessUntil: midnight(now), note: "No payment has been taken." };

  const start = Date.parse(valid[0].charge_date);
  const day = Math.floor((midnight(now) - start) / DAY);
  base.start = start; base.day = day;

  if (day <= 7) return { ...base, outcome: "too_early", retryOn: start + 8 * DAY };

  if (day <= 14) {
    const refundable = valid.filter((p) => CLEARED.includes(p.status) && p.amount - (p.amount_refunded || 0) > 0);
    if (!refundable.length && valid.some((p) => p.status === "submitted")) return { ...base, outcome: "not_cleared", retryOn: midnight(now) + DAY };
    const refund = refundable.reduce((t, p) => t + p.amount - (p.amount_refunded || 0), 0);
    return { ...base, outcome: "refund", refundable, refund, fee: 0, accessUntil: midnight(now) };
  }

  if (!monthly) {
    const last = valid.filter((p) => IN_FLIGHT.includes(p.status)).pop() || valid[0];
    return { ...base, outcome: "cancel", fee: 0, refund: 0, accessUntil: Math.max(midnight(now), addMonths(Date.parse(last.charge_date), 12)) };
  }

  // Monthly after day 14: 1 month + 50% of what is left of the 12-month term.
  const done = valid.filter((p) => IN_FLIGHT.includes(p.status));
  const left = Math.max(0, TERM_MONTHS - done.length);
  const unit = activeSubs.find((s) => s.interval_unit === "monthly")?.amount ?? (done[done.length - 1] || pending[0] || valid[valid.length - 1]).amount;
  const bills = pending.slice().sort((a, b) => Date.parse(a.charge_date) - Date.parse(b.charge_date)).map((p) => p.amount).slice(0, left);
  while (bills.length < left) bills.push(unit);
  const fee = left ? bills[0] + Math.round(bills.slice(1).reduce((t, x) => t + x, 0) / 2) : 0;
  return { ...base, outcome: fee ? "fee" : "cancel", fee, refund: 0, monthsLeft: left, accessUntil: midnight(addMonths(now, fee ? 1 : 0)) };
}

const describe = (a) => {
  switch (a.outcome) {
    case "already_cancelled": return "This licence has already been cancelled. There is nothing left to cancel.";
    case "too_early": return `Your first payment was taken on ${dateStr(a.start)}. Refunds can only be issued once a payment has cleared, which takes up to a week. Please try again on ${dateStr(a.retryOn)}, the 8th day after your payment, and we will refund it then.`;
    case "not_cleared": return "Your payment is still on its way through the banks, so it can't be refunded yet. Please try again tomorrow.";
    case "refund": return `You are within the 14-day guarantee. We will refund ${gbp(a.refund)} to your bank account and cancel your licence and any future payments. Your key will stop working today.`;
    case "cancel_rolling": return `This is the rolling £5 a month plan, so there is no cancellation fee and no waiting period. We will cancel it now. Your licence key will keep working until ${dateStr(a.accessUntil)}, the end of the month you have paid for.`;
    case "cancel": return a.monthly || !a.valid.length ? "We will cancel your licence." : `The 14-day refund period has ended (it ran for 14 days from ${dateStr(a.start)}), so we can't refund this payment. We can stop it renewing: we will cancel your subscription so nothing more is taken, and your licence key will keep working until ${dateStr(a.accessUntil)}, the end of the year you paid for.`;
    case "fee": return `The 14-day refund period has ended, so we can't refund your payments. We can cancel your subscription going forward. Because you pay monthly on a ${TERM_MONTHS}-month contract, ending it early costs one month plus half of the remaining term: ${gbp(a.fee)}. We will collect it from your bank account using the payment details you already gave us, then cancel your remaining payments. Your key will keep working until ${dateStr(a.accessUntil)}.`;
  }
};

const post = (path, body, idem) => gc("POST", path, body ?? {}, idem);
const conflict = (r) => r.data.error?.errors?.some((e) => e.reason === "idempotent_creation_conflict");

async function execute(a, customerId, now = Date.now()) {
  const idemBase = `maestro-cancel-${customerId}`;
  // 1. Money first, so a failure leaves the licence untouched.
  if (a.outcome === "refund") {
    for (const p of a.refundable) {
      const amount = p.amount - (p.amount_refunded || 0);
      const r = await post("/refunds", { refunds: { amount, total_amount_confirmation: p.amount, links: { payment: p.id }, metadata: { reason: "maestro_14_day_guarantee" } } }, `maestro-refund-${p.id}`);
      if (r.status >= 300 && !conflict(r)) throw fail(502, "We couldn't process the refund automatically. Nothing has been cancelled. Please email hello@thecaffeinemediacompany.com and it will be sorted by hand.");
    }
  } else if (a.outcome === "fee") {
    const mandate = [...a.activeSubs, ...a.activeScheds].map((x) => x.links?.mandate).find((m) => a.activeMandates.some((am) => am.id === m)) || a.activeMandates[0]?.id;
    if (!mandate) throw fail(409, "We couldn't find your payment details to collect the cancellation fee, so nothing has been cancelled. Please email hello@thecaffeinemediacompany.com.");
    const r = await post("/payments", { payments: { amount: a.fee, currency: "GBP", description: "Maestro Pro early cancellation fee", links: { mandate }, metadata: { cancellation_fee: "true" } } },
      `${idemBase}-fee-${[...a.activeSubs, ...a.activeScheds].map((x) => x.id).join("-")}`);
    if (r.status >= 300 && !conflict(r)) throw fail(502, "We couldn't collect the cancellation fee, so nothing has been cancelled. Please email hello@thecaffeinemediacompany.com.");
  }
  // 2. Stop future payments.
  const steps = [
    ...a.activeSubs.map((s) => post(`/subscriptions/${s.id}/actions/cancel`)),
    ...a.activeScheds.map((s) => post(`/instalment_schedules/${s.id}/actions/cancel`)),
  ];
  const results = await Promise.all(steps);
  if (results.some((r) => r.status >= 300 && r.data.error?.errors?.[0]?.reason !== "cancellation_failed")) throw fail(502, "Your payment was handled but we couldn't cancel everything. Please email hello@thecaffeinemediacompany.com and quote your licence key.");
  await Promise.all(a.pending.map((p) => post(`/payments/${p.id}/actions/cancel`))); // may already be cancelled with its plan
  // 3. Mandates: cancelled unless a monthly customer is paying the early-cancellation fee, who keeps theirs.
  if (a.outcome !== "fee") await Promise.all(a.activeMandates.map((m) => post(`/mandates/${m.id}/actions/cancel`)));
  // 4. The key stops working at accessUntil (studentHasPaid reads this).
  await gc("PUT", `/customers/${customerId}`, { customers: { metadata: { ...(a.customer.metadata || {}), maestro_access_until: new Date(a.accessUntil).toISOString() } } });
}

/** Ends a customer's licence today (stops payments, cancels mandates, key stops working). Used by the desk's forced refund; skips the fee and refund rules. */
export async function endLicence(customerId) {
  const a = await assess(customerId);
  if (a.outcome === "already_cancelled") return;
  await execute({ ...a, outcome: "cancel", fee: 0, refund: 0, accessUntil: midnight(Date.now()) }, customerId);
}

const planTitles = (a) => {
  const named = [...a.activeSubs, ...a.activeScheds].map((x) => x.name);
  return [...new Set((named.length ? named : a.valid.map((p) => p.description)).filter(Boolean))].join(", ") || "Maestro Pro";
};

/** Tells the owner why someone cancelled, which plan they were on and what was done. Never fails the cancellation. */
async function tellOwner(a, key, reason, result) {
  if (!process.env.RESEND_API_KEY) return;
  const plans = planTitles(a);
  const email = a.customer?.email || "unknown";
  const lines = [`Plan: ${plans}`, `Customer email: ${email}`, `Licence key: ${key}`, `Outcome: ${result}`, "", "Their reason:", String(reason).trim()];
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.CONTACT_FROM || "Maestro Pro <noreply@thecaffeinemediacompany.com>",
      to: [OWNER],
      ...(a.customer?.email && { reply_to: a.customer.email }),
      subject: `Maestro Pro cancellation: ${plans}`.replace(/[\r\n]/g, " ").slice(0, 200),
      text: lines.join("\n"),
      html: lines.map((l) => (l ? `<p>${esc(l).replace(/\n/g, "<br>")}</p>` : "")).join(""),
    }),
  }).catch(() => {});
}

/** The customer's confirmation: that the licence is cancelled, any refund or fee, and the last day the key works.
 *  Test keys send it to the owner instead, marked as a test. */
async function sendConfirmation(a, test) {
  const customerEmail = a.customer?.email;
  const to = test ? OWNER : customerEmail;
  if (!to || !process.env.RESEND_API_KEY) return;
  const plan = planTitles(a);
  const refunded = a.outcome === "refund";
  const lines = [
    `Your Maestro Pro licence (${plan}) has been cancelled.`,
    refunded ? `Refund: ${gbp(a.refund)}. It should reach your bank account in a few working days.` : "Refund: none.",
    a.fee ? `Cancellation fee charged: ${gbp(a.fee)}.` : "Cancellation fee charged: none. No fees were taken for this cancellation.",
    refunded ? `Last day you can use your licence: ${dateStr(a.accessUntil)}. Your licence key stopped working today.` : `Last day you can use your licence: ${dateStr(a.accessUntil)}.`,
    "No further payments will be taken.",
  ];
  // The retention offer (always in the email, even when the page leaves it out for a yearly plan with a long way to run).
  const o = offerFor(a);
  const offer = o ? `${o.title} ${o.text}` : "";
  const note = "If you didn't ask for this, email hello@thecaffeinemediacompany.com. This inbox is not monitored, so please do not reply to this email.";
  const testNote = test ? `This is a test: no real customer was cancelled. It was sent to you instead of ${customerEmail || "the customer"}.` : "";
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.CONTACT_FROM || "Maestro Pro <noreply@thecaffeinemediacompany.com>",
      to: [to],
      subject: `${test ? "[TEST] " : ""}Your Maestro Pro licence has been cancelled`,
      text: [testNote, ...lines, ...(o ? ["", offer, o.url] : []), "", note].filter((l, i) => l || i).join("\n"),
      html: [testNote && `<p><i>${esc(testNote)}</i></p>`, ...lines.map((l) => `<p>${esc(l)}</p>`), o && `<p>${esc(offer)}</p><p><a href="${o.url}">${esc(o.cta)}</a></p>`, `<p>${esc(note)}</p>`].filter(Boolean).join(""),
    }),
  }).catch(() => {});
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only." });
  if (!ORIGINS.includes(origin)) return res.status(403).json({ error: "Not allowed." });

  const { key, action, refund, fee, reason, skipReason } = req.body || {};
  const customerId = testKey(key) || parseStudentKey(key);
  if (!customerId) return res.status(400).json({ error: "That licence key isn't valid. Check it and try again." });
  if (action !== "check" && action !== "confirm") return res.status(400).json({ error: "Unknown action." });

  try {
    const a = await assess(customerId);
    const test = !!TEST_WORLDS[customerId];
    // Only people in the UK (Vercel's country header) may skip the reason. Test keys may, so the button can be tried anywhere.
    const uk = test || req.headers["x-vercel-ip-country"] === "GB";
    const view = { outcome: a.outcome, message: describe(a), refund: a.refund || 0, fee: a.fee || 0, retryOn: a.retryOn ? dateStr(a.retryOn) : undefined };
    const email = test ? TEST_EMAIL : a.customer?.email, ukey = String(key).trim().toUpperCase();
    const REFUND_ISH = ["refund", "too_early", "not_cleared"];
    if (action === "check") {
      // Logged for the escalations desk, including refund enquiries that cannot go ahead yet.
      if (REFUND_ISH.includes(a.outcome)) await logActivity(email, { type: "refund_request", status: a.outcome === "refund" ? "checked" : "not completed", summary: a.outcome === "refund" ? `Checked a refund: ${gbp(a.refund)} would be refunded (day ${a.day})` : a.outcome === "too_early" ? `Asked about a refund, but the first payment was only taken ${a.day} day${a.day === 1 ? "" : "s"} ago` : "Asked about a refund, but the payment has not cleared yet", detail: view.message, key: ukey, amount: a.refund || 0 });
      return res.status(200).json({ ok: true, ...view, canConfirm: ["refund", "cancel", "cancel_rolling", "fee"].includes(a.outcome), canSkipReason: uk });
    }

    if (!["refund", "cancel", "cancel_rolling", "fee"].includes(a.outcome)) {
      if (REFUND_ISH.includes(a.outcome)) await logActivity(email, { type: "refund_request", status: "not completed", summary: a.outcome === "too_early" ? `Asked for a refund, but the first payment was only taken ${a.day} day${a.day === 1 ? "" : "s"} ago` : "Asked for a refund, but the payment has not cleared yet", detail: view.message, key: ukey, amount: 0 });
      return res.status(200).json({ ok: true, done: false, ...view });
    }
    // A reason of at least MIN_WORDS words is required before anything is refunded, charged or cancelled, unless a UK customer chose to skip it.
    const skip = skipReason === true && uk;
    if (!skip && wordCount(reason) < MIN_WORDS || String(reason).length > 3000) return res.status(400).json({ error: `Please tell us why you're cancelling, in at least ${MIN_WORDS} words.` });
    // Refuse if the amounts moved since the customer read them (a day boundary, a new payment).
    if (Number(refund || 0) !== view.refund || Number(fee || 0) !== view.fee) return res.status(409).json({ error: "Your account changed while you were reading this. Please start again." });
    const what = a.outcome === "refund" ? "refund" : "cancellation", money = a.outcome === "refund" ? a.refund : a.fee;
    const why = skip ? "Reason: customer chose not to give one." : `Reason given: ${String(reason).replace(/\s+/g, " ").trim().slice(0, 400)}`;
    try {
      if (!test) await execute(a, customerId); // test keys change nothing
    } catch (err) {
      await logActivity(email, { type: what, status: "failed", summary: `${what === "refund" ? `Refund of ${gbp(a.refund)}` : "Cancellation"} attempted but failed, nothing was completed`, detail: err.message, key: ukey, amount: money });
      throw err;
    }
    const msg = a.outcome === "refund" ? `We have refunded ${gbp(a.refund)}, which should reach your bank in a few working days, and cancelled your licence.`
      : a.outcome === "fee" ? `We have collected the ${gbp(a.fee)} cancellation fee and cancelled your remaining monthly payments. Your licence key will work until ${dateStr(a.accessUntil)}.`
      : a.outcome === "cancel_rolling" ? `Your £5 a month plan is cancelled, with no fee. Your licence key will work until ${dateStr(a.accessUntil)}.`
      : a.monthly ? "Your licence has been cancelled." : `Your subscription is cancelled and nothing more will be taken. Your licence key will work until ${dateStr(a.accessUntil)}.`;
    await logActivity(email, { type: what, status: "completed", summary: a.outcome === "refund" ? `Refunded ${gbp(a.refund)} and cancelled the licence` : a.outcome === "fee" ? `Cancelled the licence and collected a ${gbp(a.fee)} early cancellation fee` : `Cancelled the licence, access until ${dateStr(a.accessUntil)}`, detail: why, key: ukey, amount: money });
    await sendConfirmation(a, test);
    if (!test) await tellOwner(a, String(key).trim().toUpperCase(), skip ? "(The customer chose not to give a reason.)" : reason, msg);
    // The retention offer is only ever sent in this response and the email, never published on the site.
    const offer = offerOnPage(a) || undefined;
    res.status(200).json({ ok: true, done: true, outcome: a.outcome, message: msg, offer });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(502).json({ error: "Couldn't reach the payment service. Try again in a moment." });
  }
}
