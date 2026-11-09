// Device limit for licences bought on the website: a key may be used on 3 devices (Education licences are unlimited).
//
// The app is not changed and sends the server only {"key": ...}, so a device is recognised by a cookie. The app's requests go through
// URLSession.shared, which keeps cookies, so the first check from an install is answered with a random device id and every later
// check from that install sends it back. A device only counts towards the limit once it has sent its id back (so an install that
// cannot keep cookies is never locked out, it just is not counted). The 4th device is refused; the customer removes a device on
// the licence key devices page (api/licence-devices.js), which also signs that device out the next time it checks.
//
// State is one small JSON file per key in the Blob store, named by a hash of the key (the key itself is never stored).
// Environment: DEVICE_LIMIT_MODE = "enforce" (default), "monitor" (record devices, never refuse) or "off".
import crypto from "node:crypto";
import { gc, isMaestro } from "./_gc.js";
import { readVersioned, writeVersioned } from "./_threads.js";

export const LIMIT = 3;
export const EXPIRE_MS = 60 * 864e5;      // a device not seen for 60 days stops counting
const TOMB_MS = 90 * 864e5;               // a removed device is remembered this long, so it can be told it was removed
const FP_WINDOW_MS = 48 * 36e5;           // an unconfirmed device is matched by app/OS version and network for this long
const MAX_UNCONFIRMED = 8;
const sha = (x) => crypto.createHash("sha256").update(String(x)).digest("hex");
export const keyHash = (key) => sha("maestro-licence|" + String(key).trim().toUpperCase());
const rand = (n) => crypto.randomBytes(n).toString("hex");

export const MSG = {
  limit: `This licence is already in use on ${LIMIT} devices. To use it on this device, remove one on the licence key page (maestro-pro.app/key/devices/), then enter your licence key again.`,
  revoked: "This device has been removed from the licence. Enter your licence key again to add it back, if you have a free device slot.",
};

export const parseCookie = (header, name = "mpd") => new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]{32})\\b`).exec(String(header || ""))?.[1] || null;
export const cookieHeader = (id) => `mpd=${id}; Max-Age=94608000; Path=/; Secure; HttpOnly; SameSite=None`;

/** The network part of a client address (first three numbers of an IPv4 address, first three groups of IPv6), so a change of address within a network still matches. */
export function netPrefix(xff) {
  const ip = String(xff || "").split(",")[0].trim();
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":");
  return ip.split(".").slice(0, 3).join(".");
}
export const fingerprint = (ua, xff) => sha(`${ua}|${netPrefix(xff)}|${process.env.LICENCE_SECRET || ""}`).slice(0, 24);
const DARWIN = { 21: "iOS 15 or macOS 12", 22: "iOS 16 or macOS 13", 23: "iOS 17 or macOS 14", 24: "iOS 18 or macOS 15", 25: "iOS 26 or macOS 26" };
/** "Maestro Pro/20 CFNetwork/1494.0.7 Darwin/23.4.0" -> "iOS 17 or macOS 14". Empty when the version is not recognised. */
export const osLabel = (ua) => DARWIN[/Darwin\/(\d+)/.exec(String(ua || ""))?.[1]] || "";

/** The licence check for one request, applied to the key's state (changed in place). Returns {ok, code?, error?, setCookie?, changed}. */
export function decide(state, { cookieId = null, fp = "", ua = "", now = Date.now(), limit = LIMIT, mode = "enforce" } = {}) {
  const before = (state.devices || []).length;
  state.devices = (state.devices || []).filter((d) => (d.revoked ? now - d.revokedAt < TOMB_MS : now - d.last < EXPIRE_MS));
  let changed = state.devices.length !== before;
  const live = () => state.devices.filter((d) => !d.revoked);
  const confirmed = (except) => live().filter((d) => d.confirmed && d !== except).length;
  const touch = (d) => { d.last = now; d.uses = (d.uses || 0) + 1; d.ua = String(ua).slice(0, 120); d.os = osLabel(ua) || d.os || ""; d.fp = fp; changed = true; };
  const refuse = (code, error) => (mode === "monitor" ? null : { ok: false, code, error, changed });

  let d = cookieId ? state.devices.find((x) => x.id === cookieId) : null;
  if (d?.revoked) {
    if (!d.notified) { d.notified = true; return { ok: false, code: "revoked", error: MSG.revoked, changed: true }; }
    d = null;   // it has been told; entering the key again signs this install up as a new device
  }
  if (d) {
    touch(d);
    if (!d.confirmed) {
      if (confirmed(d) >= limit) { const r = refuse("limit", MSG.limit); if (r) return r; }
      d.confirmed = true;
    }
    return { ok: true, changed };
  }
  // No usable cookie: an install that has not yet sent its id back may still be the same one (same app/OS version, same network).
  const match = state.devices.find((x) => !x.revoked && !x.confirmed && x.fp === fp && now - x.last < FP_WINDOW_MS);
  if (match) { touch(match); return { ok: true, setCookie: match.id, changed }; }
  if (confirmed() >= limit) { const r = refuse("limit", MSG.limit); if (r) return r; }
  const unconfirmed = live().filter((x) => !x.confirmed).sort((a, b) => a.last - b.last);
  for (const old of unconfirmed.slice(0, Math.max(0, unconfirmed.length - MAX_UNCONFIRMED + 1))) state.devices.splice(state.devices.indexOf(old), 1);
  const nd = { id: rand(16), pub: rand(4), first: now, last: now, uses: 1, confirmed: false, ua: String(ua).slice(0, 120), os: osLabel(ua), fp };
  state.devices.push(nd);
  return { ok: true, setCookie: nd.id, changed: true };
}

const FILE = (hash) => `licences/${hash}.json`;
/** Reads the key's state, lets `fn(state)` change it, and saves it only if nobody else did meanwhile (retrying if they did). */
export async function updateState(hash, fn, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const { data, etag } = await readVersioned(FILE(hash));
    const state = data || { devices: [] };
    const out = await fn(state);
    if (!out.changed) return out;
    if (await writeVersioned(FILE(hash), state, etag)) return out;
  }
  throw new Error("The device list was busy.");
}

// ---- Education licences have no device limit. They are the same kind of key as any other, so they are recognised by their plan:
// any Maestro Pro subscription or instalment plan with "Education" in its name. (EDUCATION_PLAN_PATTERN can change the word.)
const EDU_NAME = new RegExp(process.env.EDUCATION_PLAN_PATTERN || "education", "i");
export const planIsEducation = (p) => EDU_NAME.test(p.name || "");
/** True when this GoCardless customer's Maestro Pro plan is an Education licence. */
export async function isEducation(customerId) {
  const subs = (await gc("GET", `/subscriptions?customer=${customerId}&status=active`)).data.subscriptions || [];
  const inst = (await gc("GET", `/instalment_schedules?customer=${customerId}`)).data.instalment_schedules || [];
  const plans = [
    ...subs.filter((s) => isMaestro(s.name)).map((s) => ({ name: s.name, amount: Number(s.amount), unit: s.interval_unit })),
    ...inst.filter((x) => ["pending", "active"].includes(x.status) && isMaestro(x.name)).map((x) => ({ name: x.name, total: Number(x.total_amount) })),
  ];
  return plans.some(planIsEducation);
}
/** Whether the key is an Education licence, remembered in its state for a day so checks do not all go to GoCardless. Marks the state changed when it looks again. */
export async function educationFlag(state, customerId, now = Date.now()) {
  if (state.edu && now - state.edu.at < 864e5) return { value: state.edu.v, looked: false };
  state.edu = { v: await isEducation(customerId), at: now };
  return { value: state.edu.v, looked: true };
}

/** The whole device check for one licence request, used by student-check.js. Never throws, and any storage problem lets the licence through,
 *  so a paying customer is not locked out by a fault on our side. Returns {ok, error?, setCookie?}. */
export async function deviceGate({ key, customerId, headers = {}, now = Date.now() }) {
  const mode = process.env.DEVICE_LIMIT_MODE || "enforce";
  if (mode === "off" || !process.env.BLOB_READ_WRITE_TOKEN) return { ok: true };
  try {
    const ua = String(headers["user-agent"] || ""), xff = String(headers["x-forwarded-for"] || "");
    return await updateState(keyHash(key), async (state) => {
      const edu = await educationFlag(state, customerId, now);
      if (edu.value) return { ok: true, changed: edu.looked };
      const r = decide(state, { cookieId: parseCookie(headers.cookie), fp: fingerprint(ua, xff), ua, now, mode });
      return { ...r, changed: r.changed || edu.looked };
    });
  } catch (e) {
    console.error("device check", e?.message);
    return { ok: true };
  }
}
