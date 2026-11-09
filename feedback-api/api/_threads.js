// Storage for the support inbox and the escalations desk: one JSON file per email chain ("thread") in a Vercel Blob store, plus an index of
// summaries so the desk page loads fast. Needs BLOB_READ_WRITE_TOKEN (added automatically when a Blob store is connected to the project).
// BLOB_ACCESS is "private" (default) or "public", and must match how the store was created. Nothing here may ever break the support bot:
// callers wrap every call in try/catch, and without a store the bot simply works as before and the desk shows that storage is not connected.
import crypto from "node:crypto";
import { put, get, BlobPreconditionFailedError } from "@vercel/blob";

export const storeReady = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const ACCESS = () => (process.env.BLOB_ACCESS === "public" ? "public" : "private");
const INDEX = "support/index.json";
const THREAD = (id) => `support/threads/${id}.json`;

/** "Re: Fwd: Hello  there" -> "hello there": the same chain whatever the mail app adds in front. */
export function normSubject(s) {
  let t = String(s ?? "").trim();
  for (;;) { const n = t.replace(/^\s*(re|fwd?|aw|sv)\s*:\s*/i, ""); if (n === t) break; t = n; }
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}
/** One chain per customer address and subject. */
export const threadId = (customer, subject) => crypto.createHash("sha256").update(`${String(customer).trim().toLowerCase()}|${normSubject(subject)}`).digest("hex").slice(0, 16);

const blobStore = {
  async read(path) {
    try {
      const r = await get(path, { access: ACCESS(), useCache: false });
      if (!r || r.statusCode !== 200) return null;
      return JSON.parse(await new Response(r.stream).text());
    } catch { return null; }
  },
  write: (path, data) => put(path, JSON.stringify(data), { access: ACCESS(), allowOverwrite: true, addRandomSuffix: false, contentType: "application/json", cacheControlMaxAge: 60 }),
  /** Read with the blob's ETag, for a conditional write afterwards. */
  async readV(path) {
    try {
      const r = await get(path, { access: ACCESS(), useCache: false });
      if (!r || r.statusCode !== 200) return { data: null, etag: null };
      return { data: JSON.parse(await new Response(r.stream).text()), etag: r.blob.etag };
    } catch { return { data: null, etag: null }; }
  },
  /** Writes only if nobody else has since (the ETag still matches, or the blob still does not exist). False when someone got there first. */
  async writeV(path, data, etag) {
    try {
      await put(path, JSON.stringify(data), { access: ACCESS(), addRandomSuffix: false, contentType: "application/json", cacheControlMaxAge: 60, ...(etag ? { allowOverwrite: true, ifMatch: etag } : { allowOverwrite: false }) });
      return true;
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError || /already exists|precondition/i.test(String(e?.message))) return false;
      throw e;
    }
  },
};
let store = blobStore;
export const useStore = (s) => { store = s || blobStore; };   // for tests
const readJson = (path) => store.read(path), writeJson = (path, data) => store.write(path, data);
/** Plain overwrite, for files that are simply reset. */
export const writeRaw = (path, data) => writeJson(path, data);
export const readVersioned = async (path) => (store.readV ? store.readV(path) : { data: await store.read(path), etag: "-" });
export const writeVersioned = async (path, data, etag) => (store.writeV ? store.writeV(path, data, etag) : (await store.write(path, data), true));

const clip = (t, n) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export function summary(t) {
  const last = t.messages[t.messages.length - 1] || {};
  const waiting = t.messages.filter((m) => m.scheduledAt && !m.cancelled).map((m) => m.scheduledAt).sort().pop() || null;   // latest reply that has a send time and was not deleted
  return { scheduledAt: waiting, id: t.id, customer: t.customer, name: t.name || null, subject: t.subject, escalated: !!t.escalated, pendingNotice: !!t.pendingNotice, escalatedAt: t.escalatedAt || null, reason: t.reason || null, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt, count: t.messages.length, preview: clip(last.text, 140), lastBy: last.by || null };
}

export const loadThread = (id) => (/^[a-f0-9]{16}$/.test(String(id)) ? readJson(THREAD(id)) : null);
export async function loadIndex() { return (await readJson(INDEX))?.threads || []; }

/** Saves the thread and its line in the index. (A webhook arriving at the very same moment as another could drop one index line; the thread file itself is kept.) */
export async function saveThread(t) {
  await writeJson(THREAD(t.id), t);
  const threads = (await loadIndex()).filter((x) => x.id !== t.id);
  threads.push(summary(t));
  threads.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  await writeJson(INDEX, { threads });
}

/** Adds a message to its chain (creating the chain if needed). `message.key` makes a retried webhook a no-op.
 *  `escalate` ({reason}) marks the chain as escalated; a customer message on an escalated chain reopens it. */
export async function recordMessage({ customer, name, subject, message, escalate, status, threadKey }) {
  const now = message.at || new Date().toISOString();
  const existing = threadKey ? await loadThread(threadKey) : null;   // threadKey: add to a known chain (a re-opened case) whatever the sender and subject
  const id = existing?.id || threadId(customer, subject);
  const t = existing || (await loadThread(id)) || { id, customer: String(customer).trim().toLowerCase(), name: name || null, subject: String(subject).replace(/^\s*(re|fwd?)\s*:\s*/gi, "").trim() || "(no subject)", escalated: false, status: "bot", createdAt: now, updatedAt: now, messages: [] };
  if (message.key && t.messages.some((m) => m.key === message.key)) return t;
  if (name && !t.name) t.name = name;
  t.messages.push({ ...message, at: now, text: String(message.text ?? "").slice(0, 8000) });
  t.updatedAt = now;
  if (escalate) { t.escalated = true; t.escalatedAt = t.escalatedAt || now; t.reason = escalate.reason || t.reason; t.status = "open"; }
  else if (t.escalated && message.by === "customer") t.status = "open";
  if (status) t.status = status;
  await saveThread(t);
  return t;
}

// ---- Settings the desk can change (the bot prompt and the reply delay), one small JSON file.
const SETTINGS = "support/settings.json";
export async function loadSettings() { return (await readJson(SETTINGS)) || {}; }
export async function saveSettings(patch) { const next = { ...(await loadSettings()), ...patch }; await writeJson(SETTINGS, next); return next; }

// ---- Case numbers. A closed chain gets one, shown in the closing email; support@ uses it to find the chain again.
const CASE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no I, O, 0 or 1, so a number is easy to read out
const CASE_FILE = (n) => `support/cases/${n}.json`;
export const newCaseNumber = () => { const pick = (k) => Array.from({ length: k }, () => CASE_CHARS[crypto.randomInt(CASE_CHARS.length)]).join(""); return `MP-${pick(4)}-${pick(4)}`; };
/** "mp 7k2q 9xdf" or "MP-7K2Q-9XDF" -> "MP-7K2Q-9XDF", or null. */
export const normCase = (t) => { const m = /\bMP[\s-]?([A-HJ-NP-Z2-9]{4})[\s-]?([A-HJ-NP-Z2-9]{4})\b/i.exec(String(t ?? "")); return m ? `MP-${m[1].toUpperCase()}-${m[2].toUpperCase()}` : null; };
/** Gives the chain a unique case number (keeping the one it has). Returns the number. */
export async function assignCase(thread) {
  if (thread.caseNumber) return thread.caseNumber;
  for (let i = 0; i < 20; i++) {
    const n = newCaseNumber();
    if (await readJson(CASE_FILE(n))) continue;
    await writeJson(CASE_FILE(n), { id: thread.id, at: new Date().toISOString() });
    thread.caseNumber = n;
    return n;
  }
  throw new Error("Could not make a unique case number.");
}
/** The chain id behind a case number, or null. */
export async function findCase(text) { const n = normCase(text); return n ? { caseNumber: n, id: (await readJson(CASE_FILE(n)))?.id || null } : null; }
