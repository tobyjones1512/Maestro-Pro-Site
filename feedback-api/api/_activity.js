// Account activity log: refund requests (even ones that did not complete), cancellations, device removals and licence key emails,
// each with the date and time, kept per customer email so the escalations desk can show them next to that customer's chain.
// One small JSON file per email in the Blob store, named by a hash of the address (the address itself is not in the file name) and the
// licence key is stored only as its last 6 characters. Logging must never break the thing being logged: logActivity swallows every error.
import crypto from "node:crypto";
import { readVersioned, writeVersioned, writeRaw, storeReady } from "./_threads.js";

const MAX = 200;   // entries kept per email, oldest dropped first
export const normEmail = (e) => String(e ?? "").trim().toLowerCase();
const FILE = (email) => `activity/${crypto.createHash("sha256").update("maestro-activity|" + normEmail(email)).digest("hex").slice(0, 32)}.json`;
const clip = (t, n) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const maskKey = (key) => { const k = String(key ?? "").trim().toUpperCase(); return k ? "..." + k.slice(-6) : ""; };

/** Adds one entry: {type, status, summary, detail?, key?, amount?}. `at` is set here (ISO time, UTC). Never throws. */
export async function logActivity(email, entry, now = new Date()) {
  const addr = normEmail(email);
  if (!addr || !storeReady()) return false;
  try {
    const row = { at: now.toISOString(), type: clip(entry.type, 40), status: clip(entry.status, 40), summary: clip(entry.summary, 300), ...(entry.detail && { detail: clip(entry.detail, 600) }), ...(entry.key && { key: maskKey(entry.key) }), ...(entry.amount != null && { amount: Number(entry.amount) }) };
    for (let i = 0; i < 6; i++) {
      const { data, etag } = await readVersioned(FILE(addr));
      const log = data || { email: addr, entries: [] };
      log.entries = [...log.entries, row].slice(-MAX);
      if (await writeVersioned(FILE(addr), log, etag)) return true;
    }
  } catch (e) { console.error("activity log", e?.message); }
  return false;
}

/** This email's entries, newest first. */
export async function loadActivity(email) {
  const addr = normEmail(email);
  if (!addr || !storeReady()) return [];
  const { data } = await readVersioned(FILE(addr));
  return (data?.entries || []).slice().reverse();
}

/** Test data for the desk: a made-up customer with a chain and a spread of activity, so the log can be seen without a real customer.
 *  Wipes and rewrites that one customer's log, so pressing the button again just resets it. */
export const TEST_EMAIL = "test.customer@example.com";
export async function seedActivity(now = Date.now()) {
  const ago = (h) => new Date(now - h * 36e5).toISOString();
  const entries = [
    { at: ago(96), type: "key_resent", status: "completed", summary: "Licence key emailed to the customer", key: "MPS-CUTEST-AAAAAAAAAA" },
    { at: ago(70), type: "device_removed", status: "completed", summary: "Removed a device: iOS 17 or macOS 14 (ref 3fa9c1d2)", key: "MPS-CUTEST-AAAAAAAAAA" },
    { at: ago(70), type: "device_removed", status: "completed", summary: "Removed all devices (3 removed)", key: "MPS-CUTEST-AAAAAAAAAA" },
    { at: ago(30), type: "refund_request", status: "not completed", summary: "Asked for a refund, but the first payment was only taken 3 days ago", detail: "Too early: told to try again on 12 November 2026 (day 8). Nothing was refunded.", key: "MPS-CUTEST-AAAAAAAAAA", amount: 0 },
    { at: ago(29), type: "refund_request", status: "not completed", summary: "Asked for a refund, but the payment has not cleared yet", detail: "Payment still on its way through the banks. Told to try again tomorrow.", key: "MPS-CUTEST-AAAAAAAAAA", amount: 0 },
    { at: ago(6), type: "refund_request", status: "checked", summary: "Checked a refund: £89.00 would be refunded (day 10)", key: "MPS-CUTEST-AAAAAAAAAA", amount: 8900 },
    { at: ago(6), type: "refund", status: "failed", summary: "Refund of £89.00 attempted but failed, nothing cancelled", detail: "GoCardless refused the refund. The customer was asked to email for it to be done by hand.", key: "MPS-CUTEST-AAAAAAAAAA", amount: 8900 },
    { at: ago(2), type: "refund", status: "completed", summary: "Refunded £89.00 and cancelled the licence", detail: "Reason given: I bought it by mistake and do not need a score editor, sorry for the trouble.", key: "MPS-CUTEST-AAAAAAAAAA", amount: 8900 },
  ];
  await writeRaw(FILE(TEST_EMAIL), { email: TEST_EMAIL, entries });
  return entries.length;
}
