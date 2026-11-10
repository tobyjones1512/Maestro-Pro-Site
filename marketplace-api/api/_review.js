// The review of one product: VirusTotal for every file, then the AI reviewer against the Merchant Content Review Guidelines.
// status: "scanning" (VirusTotal) -> "reviewing" (the AI) -> "ready" (Accepted, Ready For Distribution) or "refused" (with a reason). Nothing is on sale until "ready".
// It moves one step at a time and saves as it goes, so it is safe to call from anywhere (the merchant's page, the daily sweep) and to be interrupted.
import { inflateRawSync } from "node:zlib";
import guidelines from "../lib/guidelines.js";
import { readJson, updateProduct, products } from "./_blob.js";
import { bundleInfo, readRange, ALLOWED, ext } from "./_bundle.js";
import { startScan, pollScan, SCAN_CALLS } from "./_vt.js";
import { buildEmail, sendMail, LINKS } from "./_email.js";
import { OWNER } from "./_mp.js";

const SELLER = (id) => `marketplace/sellers/${id}.json`;
export const GUIDELINE = Object.fromEntries(guidelines.sections.flatMap((s) => s.items.map((i) => [i.id, i])));
const LLM_URL = () => `${(process.env.LLM_BASE_URL || "https://api.pawan.krd/v1").replace(/\/$/, "")}/chat/completions`;
const MODEL = () => process.env.LLM_MODEL || "openai/gpt-oss-20b";
const MAX_LLM_TRIES = 6;
const RETRY_ERROR_MS = 5 * 60000;

/** The model's words are kept plain: no dashes, no emoji, no links. */
export const tidy = (t) => String(t).replace(/https?:\/\/\S+/g, "").replace(/(\d)\s*[–]\s*(\d)/g, "$1 to $2").replace(/\s*[–—]\s*/g, ", ").replace(/[\p{Extended_Pictographic}️‍⃣]/gu, "").replace(/\s+/g, " ").trim();
const maskPersonal = (t) => String(t).replace(/[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+/g, "[email]").replace(/\+?\d[\d\s().-]{8,}\d/g, "[number]");

// ---- What the reviewer gets to read from the files
function unzipFirstXml(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) return "";
  let p = buf.readUInt32LE(e + 16);
  for (let n = buf.readUInt16LE(e + 10); n > 0 && buf.readUInt32LE(p) === 0x02014b50; n--) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString();
    p += 46 + nl + el + cl;
    if (!/\.(xml|musicxml)$/i.test(name) || /^META-INF\//i.test(name)) continue;
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), data = buf.subarray(start, start + csize);
    return (method === 8 ? inflateRawSync(data, { maxOutputLength: 8e6 }) : data).toString("utf8", 0, 600000);
  }
  return "";
}
function xmlFacts(x) {
  const pick = (re) => [...x.matchAll(re)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 6);
  const f = {
    "work title": pick(/<work-title>([^<]*)</g), "movement title": pick(/<movement-title>([^<]*)</g),
    creators: [...x.matchAll(/<creator[^>]*type="([^"]*)"[^>]*>([^<]*)</g)].map((m) => `${m[1]}: ${m[2].trim()}`).slice(0, 6),
    rights: pick(/<rights[^>]*>([^<]*)</g), "credit words": pick(/<credit-words[^>]*>([^<]*)</g), software: pick(/<software>([^<]*)</g),
  };
  return Object.entries(f).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.join(" | ")}`).join("\n");
}
function id3(buf) {
  if (buf.subarray(0, 3).toString() !== "ID3") return "";
  const size = ((buf[6] & 127) << 21) | ((buf[7] & 127) << 14) | ((buf[8] & 127) << 7) | (buf[9] & 127), want = { TIT2: "title", TPE1: "artist", TALB: "album", TCOP: "copyright", TPUB: "publisher" };
  const out = []; let p = 10;
  while (p + 10 < Math.min(buf.length, 10 + size)) {
    const tag = buf.subarray(p, p + 4).toString(), len = buf.readUInt32BE(p + 4);
    if (!/^[A-Z0-9]{4}$/.test(tag) || len <= 0 || p + 10 + len > buf.length) break;
    if (want[tag]) out.push(`${want[tag]}: ${buf.subarray(p + 11, p + 10 + len).toString(buf[p + 10] === 1 ? "utf16le" : "utf8").replace(/[\0﻿]/g, "").trim()}`);
    p += 10 + len;
  }
  return out.join("\n");
}
async function pdfText(buf) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true });
  return String(text || "").replace(/\s+/g, " ").trim();
}
/** One short entry per file. Never throws: a file that can't be read is described by its name and size. */
async function evidence(id, files) {
  const out = [];
  for (const f of files.slice(0, 12)) {
    const e = ext(f.name);
    let body = "";
    try {
      if (["musicxml", "xml"].includes(e) && f.size <= 40e6) body = xmlFacts((await readRange(id, f.offset, f.offset + Math.min(f.size, 600000))).toString("utf8"));
      else if (e === "mxl" && f.size <= 30e6) body = xmlFacts(unzipFirstXml(await readRange(id, f.offset, f.offset + f.size)));
      else if (e === "pdf" && f.size <= 25e6) body = (await pdfText(await readRange(id, f.offset, f.offset + f.size))).slice(0, 1800);
      else if (["lrc", "txt"].includes(e)) body = (await readRange(id, f.offset, f.offset + Math.min(f.size, 4000))).toString("utf8").replace(/\[\d+:\d+(?:[.:]\d+)?\]/g, "").replace(/\s+/g, " ").trim().slice(0, 1800);
      else if (e === "mp3") body = id3(await readRange(id, f.offset, f.offset + Math.min(f.size, 65536)));
    } catch { /* described by its name only */ }
    out.push(`<file name="${f.name}" size="${f.size}">${body ? "\n" + body + "\n" : ""}</file>`);
  }
  return out.join("\n");
}

// ---- The reviewer
const POLICY = guidelines.sections.map((s) => `${s.n}. ${s.title}\n` + s.items.map((i) => `${i.id} ${i.title}: ${i.text}`).join("\n")).join("\n\n");
const SYSTEM = `You review items submitted to the Maestro Pro Marketplace, where musicians sell sheet music, backing tracks, karaoke and lyrics. Decide whether an item may go on sale, using only the guidelines below.
The merchant has confirmed they own the rights. That is not proof. Look for signs the item copies someone else's work:
- A title, lyric or tune that is a recognisable, commercially published song or composition whose writer is alive or died within the last 70 years (arrangements, transcriptions, covers and lyrics of it need a licence under 2.2, 2.4 and 2.5), unless the listing shows a licence.
- A copyright line, publisher's name, "all rights reserved", a publisher's edition, or a scan of a printed edition in the file text or tags.
- Audio tags or names that show a commercial release, or a karaoke disc rip.
- A listing that doesn't match the files, or breaks 1.3 or 3.1 to 3.3.
- Countries ("available in") where the work is probably still protected even though it looks old or public domain elsewhere (2.9).
Public domain works (writer died before 1955) are fine when the arrangement or engraving looks like the merchant's own. Original work with no sign of copying is fine. If it looks like a well-known protected work and the listing gives no licence, refuse. If nothing points to a problem, accept.
Answer with one JSON object and nothing else: {"decision":"accept" or "refuse","guidelines":["2.2"],"reason":"..."}
"guidelines" lists the numbers of the guidelines the decision rests on (at least one when refusing, empty when accepting). "reason" is one to three plain sentences to the merchant that say what in the item led to the decision. Do not quote the guidelines (that is added for you), do not write links, greetings or sign-offs, and do not use dashes.

GUIDELINES
${POLICY}`;

async function ask(p, evid, files) {
  const user = `<listing>\ntitle: ${maskPersonal(p.title)}\ncomposer or arranger: ${maskPersonal(p.composer || "(none given)")}\ndescription: ${maskPersonal(p.description || "(none given)")}\ncontents: ${p.contents}\nprice: $${p.priceUSD} USD\navailable in: ${p.regions?.length ? p.regions.join(", ") : "worldwide"}\nmerchant: ${maskPersonal(p.sellerName)}\n</listing>\n<files count="${files.length}">\n${maskPersonal(evid)}\n</files>`;
  const r = await fetch(LLM_URL(), {
    method: "POST", headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL(), max_tokens: 1500, temperature: 0.1, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error("LLM " + r.status);
  const content = (await r.json()).choices?.[0]?.message?.content || "";
  let j = {};
  try { j = JSON.parse(/\{[\s\S]*\}/.exec(content)?.[0] || "{}"); } catch { /* unusable: tried again later */ }
  const ids = [...new Set((Array.isArray(j.guidelines) ? j.guidelines : []).map(String).filter((g) => GUIDELINE[g]))];
  const reason = tidy(j.reason || "").slice(0, 600);
  if (j.decision === "accept") return { accept: true, ids: [], reason };
  if (j.decision === "refuse" && ids.length && reason) return { accept: false, ids, reason };
  throw new Error("The reviewer's answer wasn't usable.");
}

// ---- Deciding and telling the merchant
const decide = (id, accept, ids, reason) => updateProduct(id, (p) => (["ready", "refused"].includes(p.status) ? undefined : {
  ...p, status: accept ? "ready" : "refused", review: { ...p.review, decidedAt: Date.now(), ids, reason, notified: false, error: undefined },
}));

/** Emails the merchant the outcome (once). */
export async function notify(p) {
  if (!["ready", "refused"].includes(p.status) || p.review?.notified) return;
  const m = p.sellerId === "platform" ? { name: "Maestro Pro", email: OWNER } : await readJson(SELLER(p.sellerId));
  if (!m?.email) return;
  const ok = p.status === "ready";
  const cards = ok ? [] : (p.review.ids || []).map((i) => ({ label: "Guideline " + i, title: `${i} ${GUIDELINE[i].title}`, url: `${LINKS.guidelines}#g${i.replace(".", "-")}`, text: "“" + GUIDELINE[i].text + "”" }));
  const reply = ok
    ? `Good news: **${p.title}** has been **Accepted** and is now **Ready For Distribution**. It is on the Marketplace at $${p.priceUSD.toFixed(2)} USD, and buyers can buy and download it from now on.\n\nEvery file was checked with VirusTotal, and the item was reviewed against the [Merchant Content Review Guidelines](guidelines). Once someone has bought it, they keep it for good, even if you later withdraw it from sale.`
    : `**${p.title}** has been **Refused**, so it is not on sale.\n\n**Reason:** ${p.review.reason}\n\nThis is what the [Merchant Content Review Guidelines](guidelines) say about it:\n\nYou can fix the problem and submit the item again from your [merchant account](merchant). If you think this was a mistake, email [support](support) with proof that you own the rights or hold a licence, and a person will look again (guideline 5.3).`;
  const sent = await sendMail({ to: m.email, idem: `mp-review-${p.id}-${p.review.decidedAt}`, subject: ok ? `Accepted: ${p.title} is Ready For Distribution` : `Refused: ${p.title}`,
    mail: buildEmail({ name: String(m.name).split(" ")[0], reply, cards, label: "Marketplace review", buttons: ok ? [["View your products", LINKS.merchant]] : [["Read the guidelines", LINKS.guidelines]] }) });
  if (sent) await updateProduct(p.id, (x) => ({ ...x, review: { ...x.review, notified: true } }));
}

// ---- One step
const mayStep = (p) => ["scanning", "reviewing"].includes(p.status);
async function scanStep(p) {
  const info = await bundleInfo(p.id);
  if (!info) return decide(p.id, false, ["1.2"], "The upload isn't a complete Maestro Pro bundle, so it could not be opened.");
  const bad = info.files.filter((f) => !ALLOWED.has(ext(f.name)) || /[\\/]/.test(f.name));
  if (bad.length) return decide(p.id, false, ["1.2"], `The bundle holds a file type that isn't allowed: ${tidy(bad.map((f) => f.name).slice(0, 3).join(", "))}.`);
  if (!info.files.length || !info.files.some((f) => f.size > 0)) return decide(p.id, false, ["3.2"], "The bundle is empty.");
  const files = (p.review?.files || info.files.map((f) => ({ name: f.name, size: f.size, offset: f.offset, scan: { status: "queued" } }))).map((f) => ({ ...f }));
  let budget = SCAN_CALLS;
  for (const f of files) {
    if (budget <= 0) break;
    const s = f.scan;
    if (["error", "unscanned"].includes(s.status) && Date.now() - Date.parse(s.checkedAt || 0) > RETRY_ERROR_MS) s.status = "queued";
    if (s.status === "queued" && !(s.retryAt > Date.now())) {
      const r = await startScan(await readRange(p.id, f.offset, f.offset + f.size), f.name);
      f.scan = r.scan; budget -= r.calls;
      if (r.scan.status === "queued") f.scan.retryAt = Date.now() + 60000;
    } else if (s.status === "pending") {
      const r = await pollScan(s);
      f.scan = r.scan; budget -= r.calls;
    }
  }
  await updateProduct(p.id, (x) => ({ ...x, review: { ...x.review, files } }));
  const flagged = files.find((f) => f.scan.status === "flagged");
  if (flagged) return decide(p.id, false, ["1.1"], `VirusTotal reported ${flagged.scan.malicious + flagged.scan.suspicious} of ${flagged.scan.total} scanning engines flagging ${tidy(flagged.name)} as harmful.`);
  if (files.every((f) => f.scan.status === "clean")) await updateProduct(p.id, (x) => (x.status === "scanning" ? { ...x, status: "reviewing" } : undefined));
}
async function reviewStep(p) {
  const info = await bundleInfo(p.id);
  if (!info) return decide(p.id, false, ["1.2"], "The upload isn't a complete Maestro Pro bundle, so it could not be opened.");
  try {
    const v = await ask(p, await evidence(p.id, info.files), info.files);
    await decide(p.id, v.accept, v.ids, v.reason);
  } catch (e) {
    const tries = (p.review?.tries || 0) + 1;
    await updateProduct(p.id, (x) => ({ ...x, review: { ...x.review, tries, error: String(e?.message || e).slice(0, 120) } }));
    if (tries === MAX_LLM_TRIES) await sendMail({ to: OWNER, idem: `mp-stuck-${p.id}`, subject: `Marketplace review stuck: ${p.title}`, mail: buildEmail({ name: "Toby", reply: `The automatic review of **${p.title}** has failed ${tries} times (${String(e?.message || e).slice(0, 120)}). It stays in review and is retried every day. Check LLM_API_KEY and the model.` }) });
  }
}

/** Moves one product forward by one step, if no other request is working on it. Never throws. */
export async function step(id) {
  let mine = null;
  try {
    await updateProduct(id, (p) => {
      if (!mayStep(p) || p.lock > Date.now()) return undefined;
      mine = p;
      return { ...p, lock: Date.now() + 55000 };
    });
    if (!mine) return;
    await (mine.status === "scanning" ? scanStep(mine) : reviewStep(mine));
    const now = await updateProduct(id, () => undefined);
    if (now) await notify(now);
  } catch { /* the next step tries again */ }
  finally { if (mine) await updateProduct(id, (p) => ({ ...p, lock: 0 })).catch(() => {}); }
}

/** The daily sweep: a step for every product still in review, and the emails that didn't go. */
export async function sweep() {
  const all = await products();
  for (const p of all.filter(mayStep).slice(0, 5)) await step(p.id);
  for (const p of (await products()).filter((x) => ["ready", "refused"].includes(x.status) && !x.review?.notified)) await notify(p).catch(() => {});
}
