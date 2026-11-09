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
import { loadThread, saveThread, readVersioned, writeVersioned } from "./_threads.js";

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
export async function refreshScan(meta) {
  let scan = meta.scan || {};
  if (scan.status !== "pending") return scan;
  if (scan.polledAt && Date.now() - Date.parse(scan.polledAt) < POLL_EVERY_MS) return scan;
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
export async function refreshThreadScans(thread, max = 4) {
  const all = [...(thread.messages || []).flatMap((m) => m.attachments || []), ...(thread.drafts || [])];
  let changed = false;
  const stale = all.filter((m) => m.scan?.status === "queued" && Date.now() - Date.parse(m.scan.queuedAt || 0) > STALE_QUEUED_MS);
  if (stale.length) { await enqueueScans(thread.id, stale); for (const m of stale) m.scan = { ...m.scan, queuedAt: new Date().toISOString() }; changed = true; }
  for (const m of all.filter((x) => x.scan?.status === "pending").slice(0, max)) {
    const next = await refreshScan(m);
    if (JSON.stringify(next) !== JSON.stringify(m.scan)) { m.scan = next; changed = true; }
  }
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
  await Promise.all(taken.take.map(async (it) => {
    try {
      const thread = await loadThread(it.threadId), m = thread && findMeta(thread, it.fileId);
      if (!m || m.scan?.status !== "queued") return;
      const buf = await readBuffer(m.path);
      m.scan = buf ? await startScan(buf, m.name) : { ...m.scan, status: "error", note: "The stored file is missing." };
      await saveThread(thread);
    } catch (e) { console.error("scan queue", e?.message); }
  }));
  return { started: taken.take.length, waiting: taken.waiting };
}

/** Queue freshly saved files and run the queue. Never throws. */
export async function queueScans(threadId, metas) {
  try { await enqueueScans(threadId, metas); await processQueue(); } catch (e) { console.error("queue scans", e?.message); }
}
