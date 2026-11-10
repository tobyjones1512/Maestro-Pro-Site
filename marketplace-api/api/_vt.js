// VirusTotal, the same way the support desk uses it (needs VIRUSTOTAL_API_KEY). Every file of every submission is scanned, and an item
// goes no further until each file is "clean". A scan record: { status, sha256, link, malicious, suspicious, total, analysisId, note, polledAt }
// status: "pending" (VirusTotal is still looking), "clean", "flagged" (an engine says malicious or suspicious), "unscanned" (no key) or "error".
import crypto from "node:crypto";

const VT = "https://www.virustotal.com/api/v3";
const key = () => process.env.VIRUSTOTAL_API_KEY;
const POLL_EVERY_MS = 20000;
const DIRECT_MAX = 32 * 1024 * 1024;   // larger files go to an upload address VirusTotal hands out
export const SCAN_CALLS = 3;           // the free key allows 4 requests a minute

export function verdictFrom(stats = {}) {
  const malicious = Number(stats.malicious) || 0, suspicious = Number(stats.suspicious) || 0;
  const total = malicious + suspicious + (Number(stats.harmless) || 0) + (Number(stats.undetected) || 0);
  return { status: malicious + suspicious > 0 ? "flagged" : "clean", malicious, suspicious, total };
}

/** Looks the file up by its hash; if VirusTotal has not seen it, uploads it. Returns the scan record and how many requests it used. */
export async function startScan(buf, name) {
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const base = { sha256: sha, link: `https://www.virustotal.com/gui/file/${sha}`, checkedAt: new Date().toISOString() };
  if (!key()) return { scan: { ...base, status: "unscanned", note: "VIRUSTOTAL_API_KEY is not set on the server." }, calls: 0 };
  const headers = { "x-apikey": key() };
  let calls = 1;
  try {
    const known = await fetch(`${VT}/files/${sha}`, { headers });
    if (known.ok) {
      const v = verdictFrom((await known.json())?.data?.attributes?.last_analysis_stats);
      if (v.total > 0) return { scan: { ...base, ...v }, calls };
    } else if (known.status === 429) return { scan: { ...base, status: "queued", note: "VirusTotal is busy, trying again shortly." }, calls };
    else if (known.status !== 404) return { scan: { ...base, status: "error", note: `VirusTotal answered ${known.status}.` }, calls };
    let url = `${VT}/files`;
    if (buf.length > DIRECT_MAX) {
      calls++;
      const u = await fetch(`${VT}/files/upload_url`, { headers });
      if (!u.ok) return { scan: { ...base, status: u.status === 429 ? "queued" : "error", note: `VirusTotal answered ${u.status}.` }, calls };
      url = (await u.json()).data;
    }
    calls++;
    const fd = new FormData();
    fd.append("file", new Blob([buf]), String(name).replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "file");
    const up = await fetch(url, { method: "POST", headers, body: fd });
    if (up.status === 429) return { scan: { ...base, status: "queued", note: "VirusTotal is busy, trying again shortly." }, calls };
    if (!up.ok) return { scan: { ...base, status: "error", note: `VirusTotal answered ${up.status} to the upload.` }, calls };
    return { scan: { ...base, status: "pending", analysisId: (await up.json())?.data?.id || null }, calls };
  } catch (e) {
    return { scan: { ...base, status: "error", note: `Could not reach VirusTotal (${String(e?.message || e).slice(0, 80)}).` }, calls };
  }
}

/** The result of a pending scan, or the same record if it is still running (or was checked a moment ago). Returns { scan, calls }. */
export async function pollScan(scan) {
  if (scan.polledAt && Date.now() - Date.parse(scan.polledAt) < POLL_EVERY_MS) return { scan, calls: 0 };
  const next = { ...scan, polledAt: new Date().toISOString() };
  if (!scan.analysisId) return { scan: { ...next, status: "queued" }, calls: 0 };   // nothing to poll: start it again
  try {
    const r = await fetch(`${VT}/analyses/${encodeURIComponent(scan.analysisId)}`, { headers: { "x-apikey": key() } });
    if (r.status === 429) return { scan: next, calls: 1 };
    if (!r.ok) return { scan: { ...next, status: "error", note: `VirusTotal answered ${r.status}.` }, calls: 1 };
    const a = (await r.json())?.data?.attributes || {};
    if (a.status !== "completed") return { scan: next, calls: 1 };
    const v = verdictFrom(a.stats);
    return { scan: v.total > 0 ? { ...next, ...v, note: undefined } : { ...next, status: "error", note: "VirusTotal finished but returned no results." }, calls: 1 };
  } catch { return { scan: next, calls: 1 }; }
}
