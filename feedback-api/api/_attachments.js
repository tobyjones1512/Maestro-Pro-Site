// Attachments for the support desk: files customers send (stored when the email arrives) and files you attach to a reply. Every file is kept in the
// Vercel Blob store and checked with VirusTotal. A file can only be opened from the desk, or sent to a customer, once VirusTotal calls it clean.
// Needs VIRUSTOTAL_API_KEY (set on Vercel, never in the code). Nothing here may break the support bot: callers wrap it in try/catch.
//
// A file's record ("meta") lives on the message that carried it, or in thread.drafts until it is sent:
//   { id, name, type, size, path (in the blob store), scan: { status, sha256, link, malicious, suspicious, total, analysisId, note } }
// scan.status: "queued" (waiting its turn: only SCANS_PER_MINUTE files are sent to VirusTotal per minute), "pending" (VirusTotal is still looking), "clean", "flagged" (at least one engine says malicious or suspicious),
//              "unscanned" (no API key), "error" (VirusTotal could not be reached) or "toolarge" (not stored or scanned).
import crypto from "node:crypto";
import { put, get, del } from "@vercel/blob";
import { loadThread, saveThread, updateThread, readVersioned, writeVersioned } from "./_threads.js";

const ACCESS = () => (process.env.BLOB_ACCESS === "public" ? "public" : "private");
export const MAX_FILE = 25 * 1024 * 1024;          // customer files above this are not stored (VirusTotal takes up to 32 MB)
export const MAX_UPLOAD = 3 * 1024 * 1024;         // a file attached to a reply: it travels as base64 inside one request (Vercel allows 4.5 MB)
export const MAX_FILES = 10;
export const SCANS_PER_MINUTE = 3;                // the queue lets this many files start a scan in any rolling minute (VirusTotal's free key allows 4 requests a minute)
const POLL_EVERY_MS = 20000;                       // a running scan is checked at most this often
const STALE_QUEUED_MS = 3 * 60000;                 // a file queued longer than this without being picked up is put back in the queue
export const MAX_SENT_TOTAL = 20 * 1024 * 1024;    // Resend allows 40 MB per email; stay well under
const VT = "https://www.virustotal.com/api/v3";
const vtKey = () => process.env.VIRUSTOTAL_API_KEY;

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
export const newId = () => crypto.randomBytes(6).toString("hex");
export const safeName = (n) => String(n || "file").replace(/[\\/\0]/g, "_").replace(/[^\w.\- ()]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "file";
/** Only these are ever sent to the browser with their real type, so an attachment can never run as a web page. */
export const VIEWABLE = /^(image\/(png|jpe?g|gif|webp|heic|heif)|application\/pdf|text\/plain)$/i;

/** True when the file may be opened or sent. */
export const isClean = (m) => Boolean(m && m.path && m.scan && m.scan.status === "clean");

export function verdictFrom(stats = {}) {
  const malicious = Number(stats.malicious) || 0, suspicious = Number(stats.suspicious) || 0;
  const total = malicious + suspicious + (Number(stats.harmless) || 0) + (Number(stats.undetected) || 0);
  return { status: malicious + suspicious > 0 ? "flagged" : "clean", malicious, suspicious, total };
}

/** Looks the file up by hash; if VirusTotal has not seen it, uploads it. Returns the scan record (pending when the result is not ready yet). */
export async function startScan(buf, name) {
  const sha = sha256(buf);
  const base = { sha256: sha, link: `https://www.virustotal.com/gui/file/${sha}`, checkedAt: new Date().toISOString() };
  if (!vtKey()) return { ...base, status: "unscanned", note: "VIRUSTOTAL_API_KEY is not set on the server." };
  const headers = { "x-apikey": vtKey() };
  try {
    const known = await fetch(`${VT}/files/${sha}`, { headers });
    if (known.ok) {
      const stats = (await known.json())?.data?.attributes?.last_analysis_stats;
      const v = verdictFrom(stats);
      if (v.total > 0) return { ...base, ...v };
    } else if (known.status === 429) return { ...base, status: "pending", note: "VirusTotal is busy, trying again shortly." };
    else if (known.status !== 404) return { ...base, status: "error", note: `VirusTotal answered ${known.status}.` };
    const fd = new FormData();
    fd.append("file", new Blob([buf]), safeName(name));
    const up = await fetch(`${VT}/files`, { method: "POST", headers, body: fd });
    if (up.status === 429) return { ...base, status: "pending", note: "VirusTotal is busy, trying again shortly." };
    if (!up.ok) return { ...base, status: "error", note: `VirusTotal answered ${up.status} to the upload.` };
    return { ...base, status: "pending", analysisId: (await up.json())?.data?.id || null };
  } catch (e) {
    return { ...base, status: "error", note: `Could not reach VirusTotal (${String(e?.message || e).slice(0, 80)}).` };
  }
}

/** Asks VirusTotal for the result of a pending scan. Returns the new scan record (the same one if it is still running). */
export async function refreshScan(meta, gapMs = POLL_EVERY_MS) {
  let scan = meta.scan || {};
  if (scan.status !== "pending") return scan;
  if (scan.polledAt && Date.now() - Date.parse(scan.polledAt) < gapMs) return scan;
  scan = { ...scan, polledAt: new Date().toISOString() };
  if (!scan.analysisId) { const buf = await readBuffer(meta.path); return buf ? startScan(buf, meta.name) : { ...scan, status: "error", note: "The stored file is missing." }; }
  try {
    const r = await fetch(`${VT}/analyses/${encodeURIComponent(scan.analysisId)}`, { headers: { "x-apikey": vtKey() } });
    if (r.status === 429) return scan;
    if (!r.ok) return { ...scan, status: "error", note: `VirusTotal answered ${r.status}.` };
    const a = (await r.json())?.data?.attributes || {};
    if (a.status !== "completed") return scan;
    const v = verdictFrom(a.stats);
    return v.total > 0 ? { ...scan, ...v, note: undefined } : { ...scan, status: "error", note: "VirusTotal finished but returned no results." };
  } catch { return scan; }
}

/** Refreshes every running scan in a thread (messages and drafts), and puts back in the queue any file that has waited too long. Returns true if anything changed.
 *  At most `max` lookups per call, and a scan is only checked every POLL_EVERY_MS, to respect VirusTotal's rate limit. */
export async function refreshThreadScans(thread, max = 4, gapMs = POLL_EVERY_MS) {
  const all = [...(thread.messages || []).flatMap((m) => m.attachments || []), ...(thread.drafts || [])];
  let changed = false;
  const stale = all.filter((m) => m.scan?.status === "queued" && Date.now() - Date.parse(m.scan.queuedAt || 0) > STALE_QUEUED_MS);
  if (stale.length) { await enqueueScans(thread.id, stale); for (const m of stale) m.scan = { ...m.scan, queuedAt: new Date().toISOString() }; changed = true; }
  for (const m of all.filter((x) => x.scan?.status === "pending").slice(0, max)) {
    const next = await refreshScan(m, gapMs);
    if (JSON.stringify(next) !== JSON.stringify(m.scan)) { m.scan = next; changed = true; }
  }
  if (await releaseNotice(thread)) changed = true;
  if (await releaseHeldReply(thread)) changed = true;
  if (await releasePendingBot(thread)) changed = true;
  return changed;
}

/** Finds a file's record anywhere in the thread. */
export function findMeta(thread, id) {
  return [...(thread.messages || []).flatMap((m) => m.attachments || []), ...(thread.drafts || [])].find((m) => m.id === id) || null;
}

// ---- Blob storage. Files are always stored as application/octet-stream, and are only ever served as a download.
export async function storeFile(threadId, name, buf) {
  const r = await put(`support/files/${threadId}/${safeName(name)}`, buf, { access: ACCESS(), addRandomSuffix: true, contentType: "application/octet-stream" });
  return r.pathname;
}
export async function readStream(path) {
  const r = await get(path, { access: ACCESS(), useCache: false });
  return r && r.statusCode === 200 ? r.stream : null;
}
export async function readBuffer(path) {
  const s = await readStream(path);
  return s ? Buffer.from(await new Response(s).arrayBuffer()) : null;
}
export const removeFile = (path) => del(path).catch(() => {});

/** Stores a buffer: the record for a message or a draft. Its scan is "queued"; the caller saves it, then calls queueScans. */
export async function makeMeta(threadId, { name, type, buf, inline }) {
  const meta = { id: newId(), name: safeName(name), type: String(type || "").slice(0, 100), size: buf.length, ...(inline && { inline: true }) };
  meta.path = await storeFile(threadId, meta.name, buf);
  const sha = sha256(buf);
  meta.scan = { status: "queued", sha256: sha, link: `https://www.virustotal.com/gui/file/${sha}`, queuedAt: new Date().toISOString() };   // scanned in turn by the queue, once the caller has saved it
  return meta;
}

/** Downloads the attachments of a received email (Resend receiving API) into the store and scans them. Never throws; a file that fails gets an error record. */
export async function ingestInbound(emailId, threadId) {
  const out = [];
  try {
    const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}/attachments`, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
    if (!r.ok) return out;
    const list = ((await r.json())?.data || []).slice(0, MAX_FILES);
    for (const a of list) {
      const base = { id: newId(), name: safeName(a.filename), type: String(a.content_type || "").slice(0, 100), size: Number(a.size) || 0, ...(a.content_disposition === "inline" && { inline: true }) };
      try {
        if (base.size > MAX_FILE) { out.push({ ...base, scan: { status: "toolarge", note: `Over ${MAX_FILE / 1048576} MB, so it was not stored or scanned. It is still in the Resend dashboard (email ${emailId}).` } }); continue; }
        if (!a.download_url) throw new Error("no download link");
        const d = await fetch(a.download_url);
        if (!d.ok) throw new Error("download " + d.status);
        const buf = Buffer.from(await d.arrayBuffer());
        if (buf.length > MAX_FILE) { out.push({ ...base, size: buf.length, scan: { status: "toolarge", note: `Over ${MAX_FILE / 1048576} MB, so it was not stored or scanned.` } }); continue; }
        out.push(await makeMeta(threadId, { name: base.name, type: base.type, buf, inline: base.inline }));
      } catch (e) {
        console.error("attachment", e?.message);
        out.push({ ...base, scan: { status: "error", note: `Could not fetch this file (${String(e?.message || e).slice(0, 80)}). It is still in the Resend dashboard (email ${emailId}).` } });
      }
    }
  } catch (e) { console.error("attachments", e?.message); }
  return out;
}

// ---- The scan queue. One small JSON file: the files waiting, and when the last scans started. Only SCANS_PER_MINUTE files start in any rolling minute;
// the rest wait. Anyone can run the queue (a new email, the desk being open): the file is updated with an ETag check so two runs never start the same file.
const QUEUE = "support/scan-queue.json";
async function updateQueue(change) {
  for (let i = 0; i < 5; i++) {
    const { data, etag } = await readVersioned(QUEUE);
    const q = { items: data?.items || [], starts: data?.starts || [] };
    const result = change(q);
    if (await writeVersioned(QUEUE, q, etag)) return result;
  }
  throw new Error("The scan queue was busy.");
}

/** Puts files at the back of the queue (once each) and marks them queued. Call after the files are saved on their thread. */
export async function enqueueScans(threadId, metas) {
  const add = metas.filter((m) => m && m.id);
  if (!add.length) return;
  await updateQueue((q) => { for (const m of add) if (!q.items.some((x) => x.threadId === threadId && x.fileId === m.id)) q.items.push({ threadId, fileId: m.id, at: new Date().toISOString() }); });
}

/** Starts as many queued scans as this minute's allowance leaves, oldest first. Returns { started, waiting }. */
export async function processQueue() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { started: 0, waiting: 0 };
  const taken = await updateQueue((q) => {
    const now = Date.now();
    q.starts = q.starts.filter((t) => now - Date.parse(t) < 60000);
    const take = q.items.splice(0, Math.max(0, SCANS_PER_MINUTE - q.starts.length));
    for (let i = 0; i < take.length; i++) q.starts.push(new Date(now).toISOString());
    return { take, waiting: q.items.length };
  });
  for (const it of taken.take) {   // one at a time: they may share a thread, and each saves it
    try {
      const thread = await loadThread(it.threadId), m = thread && findMeta(thread, it.fileId);
      if (!m || m.scan?.status !== "queued") continue;
      const buf = await readBuffer(m.path);
      m.scan = buf ? await startScan(buf, m.name) : { ...m.scan, status: "error", note: "The stored file is missing." };
      await releaseNotice(thread);
      await saveThread(thread);
      await releaseHeldReply(thread);   // saves the thread itself if it sends
      await releasePendingBot(thread);
    } catch (e) { console.error("scan queue", e?.message); }
  }
  return { started: taken.take.length, waiting: taken.waiting };
}

/** Queue freshly saved files and run the queue. Never throws. */
export async function queueScans(threadId, metas) {
  try { await enqueueScans(threadId, metas); await processQueue(); } catch (e) { console.error("queue scans", e?.message); }
}

// ---- Held escalation emails. An escalation email about a message with attachments is not sent straight away: it is kept on the thread
// (thread.pendingNotice) and sent once every file on that message has a scan result (clean, flagged, failed or too large), with the results in it.
let noticeSender = null;
/** support-inbound.js registers the function that emails the owner: (notice, files) => Promise, throwing if the email could not be sent. */
export const setNoticeSender = (fn) => { noticeSender = fn; };
const SETTLED = new Set(["clean", "flagged", "unscanned", "error", "toolarge"]);
/** Has this file's scan finished (whatever the result)? */
export const isSettled = (m) => SETTLED.has(m?.scan?.status);
/** If this thread holds a held escalation email and every file on its message has a result, sends it and clears it. Returns true if the thread changed (the caller saves it).
 *  A failed send leaves it held to try again; Resend's idempotency key stops a double send. */
export async function releaseNotice(thread) {
  const n = thread.pendingNotice;
  if (!n || !noticeSender) return false;
  const files = (thread.messages || []).find((m) => m.key === n.msgKey)?.attachments || [];
  if (files.some((f) => !SETTLED.has(f.scan?.status))) return false;
  try { await noticeSender(n, files); } catch (e) { console.error("held notice", e?.message); return false; }
  thread.pendingNotice = null;
  return true;
}

/** Runs the queue and checks the thread's scans, a few times over `waitMs`, until its held email and held reply have gone out. Always returns; they may still be held. */
export async function settleScans(threadId, waitMs = 0) {
  const end = Date.now() + waitMs;
  for (;;) {
    await processQueue().catch(() => {});
    const t = await loadThread(threadId);
    if (!t || (!t.pendingNotice && !t.heldReply && !t.pendingBot)) return;
    if (await refreshThreadScans(t)) await saveThread(t);
    if ((!t.pendingNotice && !t.heldReply && !t.pendingBot) || Date.now() + 5000 > end) return;
    await new Promise((r) => setTimeout(r, 4000));
  }
}

/** Waits (up to `ms`) for the scans of the given files to finish, moving the queue and checking VirusTotal as it goes. Returns the thread as last saved.
 *  Used by the support bot, which wants to read a customer's files before it replies. */
export async function waitForScans(threadId, fileIds, ms, gapMs = 12000) {
  const end = Date.now() + ms;
  for (;;) {
    await processQueue().catch(() => {});
    const t = await loadThread(threadId);
    if (!t) return null;
    if (await refreshThreadScans(t, 4, gapMs).catch(() => false)) await saveThread(t);
    const mine = [...(t.messages || []).flatMap((m) => m.attachments || [])].filter((m) => fileIds.includes(m.id));
    if (mine.every((m) => SETTLED.has(m.scan?.status)) || Date.now() + 4000 > end) return t;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---- Held replies. A reply you write with files attached is accepted straight away, but if any of its files is still being scanned it is kept on the thread
// (thread.heldReply) and sent automatically once every file is clean. If a file is flagged or its scan fails, the reply is NOT sent: it stays held
// with a note ("blocked") until you cancel it or fix the files.
let replySender = null;
/** support-admin.js registers the function that sends a reply: (thread, { id, text, close, guides, attachments }) => the updated thread. */
export const setReplySender = (fn) => { replySender = fn; };
/** Sends the held reply if all its files are clean. Saves the thread itself when it sends. Returns true if the thread changed. */
export async function releaseHeldReply(thread) {
  const h = thread.heldReply;
  if (!h || !replySender) return false;
  const files = (h.attachments || []).map((id) => (thread.drafts || []).find((d) => d.id === id));
  const badAt = files.findIndex((f) => !f || ["flagged", "error", "unscanned", "toolarge"].includes(f.scan?.status));
  if (badAt >= 0) {
    const f = files[badAt];
    const why = !f ? "One of the attached files is no longer there." : f.scan.status === "flagged" ? `${f.name} was flagged by VirusTotal.` : `${f.name} could not be scanned (${f.scan.status === "toolarge" ? "too large" : f.scan.status}).`;
    if (h.blocked === why) return false;
    h.blocked = why;
    return true;
  }
  const unblocked = Boolean(h.blocked); h.blocked = null;   // a failed file was rescanned: no longer blocked
  if (files.some((f) => f.scan?.status !== "clean")) return unblocked;   // still queued or scanning
  await saveThread(thread);   // keep the scan results, then send (which reloads the thread)
  try { Object.assign(thread, await replySender(thread, h)); } catch (e) { console.error("held reply", e?.message); return false; }
  return true;
}

// ---- A support@ email whose reply is waiting for its files to be scanned. The bot answers exactly once, after every file has a result (so it can read them):
// the webhook waits a short while, and if the scans are not done it keeps the email's details here (thread.pendingBot) and the reply is built and sent when they are.
let botRunner = null;
/** support-inbound.js registers the function that answers an email: (job) => Promise. It never throws. */
export const setBotRunner = (fn) => { botRunner = fn; };
const BOT_WAIT_MAX_MS = 15 * 60000;   // if the scans have not finished after this long (VirusTotal down?), answer anyway without those files
/** Answers the held email if every file on it has a scan result. Returns true if the thread changed (it is reloaded into `thread`). */
export async function releasePendingBot(thread) {
  const p = thread.pendingBot;
  if (!p || !botRunner) return false;
  const files = (thread.messages || []).find((m) => m.key === p.job.id)?.attachments || [];
  const waited = Date.now() - Date.parse(p.at || 0);
  if (!files.every(isSettled) && waited < BOT_WAIT_MAX_MS) return false;
  await saveThread(thread);   // keep the scan results first
  const claimed = await updateThread(thread.id, (t) => {
    const c = t.pendingBot;
    if (!c || (c.claimedAt && Date.now() - Date.parse(c.claimedAt) < 3 * 60000)) return false;   // gone, or another run is on it
    c.claimedAt = new Date().toISOString();
    return true;
  }).catch(() => false);
  if (!claimed) return false;
  const fresh = await loadThread(thread.id);
  if (!fresh?.messages.some((m) => m.key === `bot-${p.job.id}`)) await botRunner(p.job);   // not already answered
  await updateThread(thread.id, (t) => { t.pendingBot = null; return true; }).catch(() => {});
  Object.assign(thread, (await loadThread(thread.id)) || {});
  thread.pendingBot = null;
  return true;
}
