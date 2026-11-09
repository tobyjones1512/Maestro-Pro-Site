// Desk-only forced refunds: lists the payments GoCardless holds for a chain's email and refunds the one the owner picks, whatever the
// 14-day rules say (those only apply to the customer's own cancellation page). Optionally ends the licence too. Always logged.
import { gc, customersByEmail } from "./_gc.js";
import { logActivity, TEST_EMAIL, normEmail } from "./_activity.js";
import { endLicence } from "./student-cancel.js";

const CLEARED = ["confirmed", "paid_out"];
const gbp = (p) => "£" + (p / 100).toFixed(2);
const fail = (status, error) => Object.assign(new Error(error), { status });
const row = (p, customer) => ({ id: p.id, customer, date: p.charge_date, description: p.description || "", amount: p.amount, refunded: p.amount_refunded || 0, status: p.status, refundable: CLEARED.includes(p.status) && p.amount - (p.amount_refunded || 0) > 0 });
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
// Test customer: made-up payments, nothing touches GoCardless.
const TEST_PAYS = [
  { id: "PMTEST-A", customer: "CUTEST", charge_date: day(10), description: "Maestro Pro Professional", amount: 8900, amount_refunded: 0, status: "paid_out" },
  { id: "PMTEST-B", customer: "CUTEST", charge_date: day(3), description: "Maestro Pro Professional (monthly)", amount: 1000, amount_refunded: 0, status: "submitted" },
  { id: "PMTEST-C", customer: "CUTEST", charge_date: day(45), description: "Maestro Pro Professional (monthly)", amount: 1000, amount_refunded: 1000, status: "paid_out" },
];

/** Every payment under this email, newest first. */
export async function listPayments(email) {
  if (normEmail(email) === TEST_EMAIL) return TEST_PAYS.map((p) => row(p, p.customer));
  const out = [];
  for (const c of await customersByEmail(email)) for (const p of (await gc("GET", `/payments?customer=${c}&limit=500`)).data.payments || []) out.push(row(p, c));
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/** Refunds `amount` pence (default: everything left) of one of that email's payments. Returns {amount, ended}. */
export async function forceRefund({ email, paymentId, amount, endLicence: end, note }) {
  const p = (await listPayments(email)).find((x) => x.id === paymentId);
  if (!p) throw fail(404, "That payment isn't under this customer's email.");
  const left = p.amount - p.refunded;
  const pence = amount == null ? left : Number(amount);
  if (!p.refundable) throw fail(409, CLEARED.includes(p.status) ? "That payment has already been refunded in full." : `That payment can't be refunded yet (it is ${p.status.replace(/_/g, " ")}). GoCardless only refunds payments that have cleared.`);
  if (!Number.isInteger(pence) || pence < 1 || pence > left) throw fail(400, `Enter an amount between ${gbp(1)} and ${gbp(left)}.`);
  const test = normEmail(email) === TEST_EMAIL, who = `payment of ${gbp(p.amount)} from ${p.date}`;
  const key = { type: "refund", amount: pence, detail: note ? `Reason noted: ${String(note).slice(0, 300)}` : undefined };
  try {
    if (!test) {
      const r = await gc("POST", "/refunds", { refunds: { amount: pence, total_amount_confirmation: p.refunded + pence, links: { payment: p.id }, metadata: { reason: "forced_by_owner" } } }, `desk-refund-${p.id}-${p.refunded}-${pence}`);
      if (r.status >= 300 && !r.data.error?.errors?.some((e) => e.reason === "idempotent_creation_conflict")) throw fail(502, `GoCardless refused the refund: ${String(r.data.error?.message || "status " + r.status).slice(0, 200)}`);
    }
  } catch (err) {
    await logActivity(email, { ...key, status: "failed", summary: `Forced refund of ${gbp(pence)} on ${who} failed`, detail: err.message });
    throw err;
  }
  let ended = false, endNote = "";
  if (end) {
    try { if (!test) await endLicence(p.customer); ended = true; } catch (e) { endNote = " The refund went through but the licence could not be ended automatically; do that in GoCardless."; }
  }
  await logActivity(email, { ...key, status: "completed", summary: `Forced refund of ${gbp(pence)} on ${who} (by you, from the desk)${ended ? " and ended the licence" : ""}` + endNote });
  return { amount: pence, ended, note: endNote };
}
