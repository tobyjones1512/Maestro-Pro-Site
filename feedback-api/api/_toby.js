// toby@maestro-pro.app: a personal mailbox that runs through the same Resend inbound webhook as the support inbox (api/support-inbound.js).
//
//  1. Anyone emails toby@maestro-pro.app  ->  forwardInbound(): the email is forwarded to TOBY_FORWARD_TO with Reply-To set to reply@maestro-pro.app.
//     Every attachment is stored and checked with VirusTotal first (the same queue the support desk uses). The forward goes out once every file has a result:
//     files VirusTotal calls clean are attached; anything else is left off and listed with its result.
//  2. Toby answers that forward  ->  it lands on reply@maestro-pro.app  ->  replyInbound(): only your own addresses are accepted. The text you wrote
//     (no quoted history, greeting or sign-off) is put into the Maestro Pro email design with nothing in the top right and "Toby Jones" as the sign-off, and sent
//     from toby@maestro-pro.app to the original sender, as a reply to their email. Their reply to that comes back to toby@maestro-pro.app and starts again.
//
// Which customer a reply is for: the forward carries "Ref: TB-<chain id>", "Original sender" and "Original subject" lines, which every mail app quotes in a reply.
// Environment variables on Vercel (all optional):
//   TOBY_FORWARD_TO   where forwards go (default toby@thecaffeinemediacompany.com).
//   TOBY_SENDERS      comma-separated addresses allowed to send replies through reply@ (default toby@ and hello@ thecaffeinemediacompany.com).
//   TOBY_FROM         the From of the replies (default "Toby Jones <toby@maestro-pro.app>").
import { send, addr, firstName, esc, buildEmail, headerMap, LINKS } from "./support-inbound.js";
import { recordMessage, threadId, normSubject, loadThread, saveThread, loadIndex, updateThread } from "./_threads.js";
import { ingestInbound, queueScans, waitForScans, readBuffer, MAX_SENT_TOTAL } from "./_attachments.js";

export const TOBY = "toby@maestro-pro.app";
export const REPLY = "reply@maestro-pro.app";
const forwardTo = () => (process.env.TOBY_FORWARD_TO || "toby@thecaffeinemediacompany.com").trim();
const senders = () => (process.env.TOBY_SENDERS || "toby@thecaffeinemediacompany.com,hello@thecaffeinemediacompany.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const REPLY_FROM = () => process.env.TOBY_FROM || `Toby Jones <${TOBY}>`;
const MAIL_API = (id) => `https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`;
const getEmail = async (id) => (await fetch(MAIL_API(id), { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } })).json();

const cleanSubject = (s) => String(s || "(no subject)").replace(/[\r\n]+/g, " ").trim().slice(0, 200) || "(no subject)";
/** A display name that is safe inside a From header. */
const displayName = (s) => String(s || "").replace(/["<>\r\n\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
const tokenOf = (tid) => `TB-${tid}`;

/** Readable text from an email's HTML. With `unquoted`, everything from the first quoted block on is left out. */
export function htmlToText(html, unquoted = false) {
  let h = String(html || "");
  if (unquoted) { const q = h.search(/<blockquote|<div[^>]+class="[^"]*(gmail_quote|yahoo_quoted|moz-cite-prefix)/i); if (q > 0) h = h.slice(0, q); }
  return h.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- Reading Toby's reply: only what he wrote, with his greeting and sign-off taken off (the design adds both).
const SIGNOFF = /^(best regards|kind regards|warm regards|regards|best wishes|many thanks|thanks|thank you|cheers|best|yours sincerely|sincerely),?!?$/i;
const NAME = /^(?:[-\u2013\u2014~]\s*)?toby(?:\s+jones)?[.,]?$/i;
const FORMAL_ALONE = /^(best regards|kind regards|warm regards|regards|best wishes|cheers|best|yours sincerely|sincerely),?!?$/i;
export function stripFraming(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length > 1 && /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b/i.test(lines[0].trim()) && lines[0].trim().split(/\s+/).length <= 6) lines.shift();
  const last = () => { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); return lines[lines.length - 1]?.trim() || ""; };
  while (/^(sent from my .*|get outlook for .*|--)$/i.test(last())) lines.pop();
  last();
  // A sign-off: a closing phrase in the last few lines with only a short name or title under it ("Best regards,", "Thanks,", then "Toby Jones"), all taken off.
  for (let i = Math.max(0, lines.length - 6); i < lines.length; i++) {
    const t = lines[i].trim();
    if (!SIGNOFF.test(t)) continue;
    const after = lines.slice(i + 1).filter((l) => l.trim());
    if (after.length ? after.length <= 4 && after.every((l) => l.trim().length <= 60 && !/[.!?]$/.test(l.trim())) : FORMAL_ALONE.test(t)) { lines.length = i; break; }
  }
  last();
  while (NAME.test(last())) lines.pop();   // just a name at the end: "Toby", "Toby Jones", "- Toby"
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
/** The new text of a reply, without the quoted conversation. */
export function ownText(e) {
  const raw = e.text ? String(e.text) : htmlToText(e.html, true);
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l, i) =>
    /^\s*>/.test(l) || /^\s*On .{3,250} wrote:\s*$/i.test(l) || (/^\s*On .{5,250}$/i.test(l) && /wrote:\s*$/i.test(lines[i + 1] || "")) ||
    /^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}\s*$/i.test(l) || /^\s*_{8,}\s*$/.test(l) || (/^\s*\*?From:\*?\s/.test(l) && /^\s*\*?(Sent|Date):/i.test(lines[i + 1] || "")) ||
    /\bRef: (TB|ES)-[a-f0-9]{16}\b/.test(l) || /^\s*New email to toby@maestro-pro\.app\b/i.test(l) || /^\s*An escalation has been raised/i.test(l));
  return stripFraming((at >= 0 ? lines.slice(0, at) : lines).join("\n"));
}
/** The chain and customer a reply is about, from the lines the forward carries (they survive in the quoted part of Toby's reply). */
export function findReference(e) {
  const t = [e.text || "", htmlToText(e.html)].join("\n");
  const m = /\bRef: (TB|ES)-([a-f0-9]{16})\b/.exec(t), ref = m?.[2] || null, kind = m?.[1] || null;   // TB: a forward from toby@, ES: an escalation notice
  const who = /Original sender:[ \t]*(.*)/.exec(t)?.[1] || "";
  const subject = /Original subject:[ \t]*(.*)/.exec(t)?.[1]?.trim() || "";
  return { ref, kind, customer: who ? addr(who.replace(/^[>\s]+/, "")) : "", name: firstName(who), subject };
}
/** An out-of-office or other robot reply must never be sent on as Toby's answer. */
export const automated = (headers = {}) => {
  const h = headerMap(headers);
  return Boolean((h["auto-submitted"] && h["auto-submitted"].toLowerCase() !== "no") || /bulk|list|junk|auto_reply/i.test(h["precedence"] || "") || h["x-autoreply"] || h["x-autorespond"] || h["x-auto-response-suppress"]);
};
/** A failed DMARC check on the sender. Where the headers say nothing the sender is accepted by address alone. */
export const spoofed = (headers = {}) => /dmarc=fail/i.test(headerMap(headers)["authentication-results"] || "");

const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const verdict = (f, attached) => {
  const s = f.scan || {};
  if (s.status === "clean") return attached === true ? "virus-free, attached" : attached === "big" ? "virus-free, but too big to attach (it is in the Resend dashboard)" : "virus-free, but the stored file is missing";
  if (s.status === "flagged") return `FLAGGED by ${(s.malicious || 0) + (s.suspicious || 0)} VirusTotal engine(s), NOT attached, do not open`;
  if (s.status === "toolarge") return "too large to scan, NOT attached (it is in the Resend dashboard)";
  if (s.status === "unscanned") return "not scanned, NOT attached";
  return "the virus scan failed, NOT attached";
};
/** Keeps scripts and other active content out of the HTML of the email being forwarded. */
const tame = (html) => String(html).replace(/<(script|iframe|object|embed|form|meta|base|link)\b[\s\S]*?(<\/\1>|\/?>)/gi, "").replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

/** The email that goes to Toby: a short banner (who it is from, the VirusTotal results, the reference), then the original message. Waits on nothing: `files` already have results. */
export async function fwdPayload(n, files = []) {
  const f = n.fwd, attach = [], rows = [];
  let total = 0;
  for (const file of files) {
    let attached = false;
    if (file.scan?.status === "clean" && file.path) {
      if (total + (file.size || 0) > MAX_SENT_TOTAL) attached = "big";
      else { const buf = await readBuffer(file.path).catch(() => null); if (buf) { attach.push({ filename: file.name, content: buf.toString("base64"), ...(file.type && { content_type: file.type }) }); total += buf.length; attached = true; } }
    }
    rows.push({ file, line: `${file.name} (${bytes(file.size)}): ${verdict(file, attached)}` });
  }
  const who = f.name ? `${f.name} <${f.customer}>` : f.customer;
  const lines = [`New email to ${TOBY}`, `From: ${who}`, `Subject: ${f.subject}`, ...(f.date ? [`Date: ${f.date}`] : [])];
  const note = f.note || "";
  const head = [...lines, "", "Reply to this email to answer them. Your reply goes out from toby@maestro-pro.app in the Maestro Pro design, signed Toby Jones.",
    ...(rows.length ? ["", `Attachments (${rows.length}), checked with VirusTotal:`, ...rows.map((r) => `- ${r.line}`)] : []), ...(note ? ["", note] : []),
    "", `Ref: ${tokenOf(f.tid)}`, `Original sender: ${who}`, `Original subject: ${f.subject}`];
  const text = `${head.join("\n")}\n\n----------\n\n${f.text || "(no text)"}`;
  const c = { ink: "#1B140D", muted: "#6B5F4D", rule: "#E6DCC3", card: "#FBF6E8", deep: "#B86F00" };
  const banner = `<div style="margin:0 0 18px;padding:14px 18px;background:${c.card};border:1px solid ${c.rule};border-radius:10px;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${c.ink}">
<div style="font-weight:700;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:${c.muted}">New email to ${esc(TOBY)}</div>
<div style="margin-top:6px"><strong>From:</strong> ${esc(who)}<br><strong>Subject:</strong> ${esc(f.subject)}${f.date ? `<br><strong>Date:</strong> ${esc(f.date)}` : ""}</div>
<div style="margin-top:8px;color:${c.muted}">Reply to this email to answer them. Your reply goes out from toby@maestro-pro.app in the Maestro Pro design, signed Toby Jones.</div>
${rows.length ? `<div style="margin-top:10px;font-weight:700">Attachments (${rows.length}), checked with VirusTotal</div>${rows.map((r) => `<div style="margin-top:2px;${r.file.scan?.status === "clean" ? "" : "color:#B3261E;"}">&bull; ${esc(r.line)}${r.file.scan?.link && ["clean", "flagged"].includes(r.file.scan.status) ? ` <a href="${esc(r.file.scan.link)}" style="color:${c.deep}">VirusTotal report</a>` : ""}</div>`).join("")}` : ""}
${note ? `<div style="margin-top:10px;color:#B3261E">${esc(note)}</div>` : ""}
<div style="margin-top:10px;font-size:11px;color:${c.muted}">Ref: ${esc(tokenOf(f.tid))}<br>Original sender: ${esc(who)}<br>Original subject: ${esc(f.subject)}</div></div>`;
  let html;
  if (f.html) {
    const body = tame(f.html);
    html = /<body[^>]*>/i.test(body) ? body.replace(/(<body[^>]*>)/i, `$1${banner}`) : `<!doctype html><html><body>${banner}${body}</body></html>`;
  } else html = `<!doctype html><html><body>${banner}<div style="white-space:pre-wrap;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">${esc(f.text || "(no text)")}</div></body></html>`;
  return { ...n.payload, text, html, ...(attach.length && { attachments: attach }) };
}

/** Tells Toby something went wrong (a reply that could not be sent, mail that could not be matched). */
async function tell(subject, text, idem) {
  await send({ from: `Maestro Pro Mail <${TOBY}>`, to: [forwardTo()], subject, text }, idem).catch((e) => console.error("tell toby", e?.message));
}

async function ensureThread(customer, name, subject) {
  const id = threadId(`toby:${customer}`, subject);
  if (!(await loadThread(id))) {
    const now = new Date().toISOString();
    await saveThread({ id, kind: "toby", customer, name: name || null, subject: String(subject).replace(/^\s*(re|fwd?)\s*:\s*/gi, "").trim() || subject, escalated: false, status: "open", createdAt: now, updatedAt: now, messages: [] });
  }
  return id;
}

// ---- 1. Mail to toby@
export async function forwardInbound(evt) {
  const id = evt.data.email_id;
  const { noticeOwner } = await import("./support-inbound.js");
  let full = {};
  try { full = await getEmail(id); } catch (e) { console.error("toby fetch", e?.message); }
  const from = evt.data.from || full.from || "", customer = addr(from);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer) || /@maestro-pro\.app$/.test(customer)) return { ok: true, ignored: "sender" };   // our own mail: never forward it back
  const subject = cleanSubject(evt.data.subject || full.subject), name = firstName(from);
  const text = String(full.text || htmlToText(full.html) || "").slice(0, 120000);
  const msgId = evt.data.message_id || full.message_id;
  const date = full.created_at || evt.created_at || new Date().toISOString();
  const hasFiles = Array.isArray(full.attachments) ? full.attachments.length > 0 : true;

  let tid = threadId(`toby:${customer}`, subject), note = "", stored = false;
  try {
    tid = await ensureThread(customer, name, subject);
    const metas = hasFiles ? await ingestInbound(id, tid) : [];
    await recordMessage({ threadKey: tid, customer, name, subject, message: { key: id, dir: "in", by: "customer", at: new Date().toISOString(), text, msgId, ...(metas.length && { attachments: metas }) } });
    stored = true;
    if (metas.length) { await queueScans(tid, metas); await waitForScans(tid, metas.map((m) => m.id), 40000); }
  } catch (e) {
    console.error("toby store", e?.message);
    if (hasFiles && !stored) note = "Attachments (if any) were not forwarded: storage was unavailable so they could not be virus-scanned. Open the email in the Resend dashboard (email " + id + ").";
  }
  const full_name = displayName(/^\s*"?([^"<@]+?)"?\s*</.exec(from)?.[1]);   // the whole display name, for the banner (the greeting only uses the first name)
  const fwd = { tid, customer, name: full_name || name, subject, text, html: full.html || "", date, note };
  const payload = { from: `${full_name || displayName(customer) || "Someone"} via Maestro Pro <${TOBY}>`, to: [forwardTo()], reply_to: REPLY, subject: `Fwd: ${subject}` };
  await noticeOwner({ tid, msgKey: id, idem: `toby-fwd-${id}`, payload, fwd });
  return { ok: true, forwarded: true };
}

// ---- 2. Toby's answer, to reply@
export async function replyInbound(evt) {
  const id = evt.data.email_id;
  let full = {};
  try { full = await getEmail(id); } catch (e) { console.error("toby reply fetch", e?.message); return { ok: false }; }
  const from = addr(evt.data.from || full.from || "");
  if (!senders().includes(from)) { console.warn("reply@: ignored a sender that is not allowed"); return { ok: true, ignored: "sender" }; }
  if (spoofed(full.headers)) { console.warn("reply@: ignored mail failing DMARC"); return { ok: true, ignored: "spoofed" }; }
  if (automated(full.headers)) return { ok: true, ignored: "automated" };
  const subjectIn = cleanSubject(evt.data.subject || full.subject);

  const refs = findReference(full);
  if (refs.kind === "ES") return escalationReply({ id, full, refs, subjectIn });
  let thread = refs.ref ? await loadThread(refs.ref).catch(() => null) : null;
  if (thread && thread.kind !== "toby") thread = null;
  if (!thread) {   // no reference: the most recent chain with this subject
    const idx = (await loadIndex().catch(() => [])).filter((t) => t.kind === "toby" && normSubject(t.subject) === normSubject(subjectIn));
    if (idx.length) thread = await loadThread(idx[0].id).catch(() => null);
  }
  const customer = thread?.customer || (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(refs.customer) ? refs.customer : "");
  if (!customer || /@maestro-pro\.app$/.test(customer)) {
    await tell(`Couldn't send your reply: ${subjectIn}`, `Your reply to "${subjectIn}" was not sent because I couldn't tell who it is for. Reply to the forwarded email itself (so the lines at the bottom that start with Ref and Original sender are kept), or write to them directly.`, `toby-nomatch-${id}`);
    return { ok: true, ignored: "no-match" };
  }
  const text = ownText(full);
  if (!text) { await tell(`Your reply was empty: ${subjectIn}`, `Nothing was sent to ${customer}: I couldn't find any new text in your reply.`, `toby-empty-${id}`); return { ok: true, ignored: "empty" }; }
  if (text.length > 6000) { await tell(`Your reply was too long: ${subjectIn}`, `Nothing was sent to ${customer}: the reply is over 6,000 characters. Please shorten it.`, `toby-long-${id}`); return { ok: true, ignored: "long" }; }

  const name = thread?.name || refs.name || null;
  const subject = refs.subject || thread?.subject || subjectIn.replace(/^\s*(re|fwd?)\s*:\s*/gi, "");
  const lastIn = thread && [...thread.messages].reverse().find((m) => m.dir === "in" && m.msgId)?.msgId;
  const rep = { emailId: id, customer, name, subject, text, lastIn: lastIn || null, tid: thread?.id || null };
  // Files on your reply are stored and virus-scanned like any others; the reply goes out when every one has a result (see sendReply).
  if (Array.isArray(full.attachments) ? full.attachments.length > 0 : false) {
    let held = false;
    try {
      const tid = thread?.id || (await ensureThread(customer, name, subject));
      rep.tid = tid;
      const metas = await ingestInbound(id, tid);
      if (!metas.length) throw new Error("the files could not be fetched");
      await recordMessage({ threadKey: tid, customer, name, subject, message: { key: `toby-${id}`, dir: "out", by: "toby", at: new Date().toISOString(), text, attachments: metas } });
      await queueScans(tid, metas);
      await waitForScans(tid, metas.map((m) => m.id), 40000);
      const { noticeOwner } = await import("./support-inbound.js");
      await noticeOwner({ tid, msgKey: `toby-${id}`, idem: `toby-reply-${id}`, payload: {}, rep });
      held = true;
    } catch (e) {
      console.error("toby reply files", e?.message);
      if (!held) await tell(`Your reply was not sent: ${subjectIn}`, `Your reply to ${customer} was NOT sent: its attachments could not be stored and virus-scanned (${String(e?.message).slice(0, 100)}). Try again, or write to them directly.`, `toby-attach-${id}`);
    }
    return { ok: true, scanning: true };
  }
  return sendReply(rep, []);
}

/** The lines an escalation notice carries so that a reply to it can be matched (see noticeOwner in support-inbound.js). */
export const escRefs = (tid, who, subject) => `\n\n---\nTo answer, just reply to this email. Your reply is sent to them from escalations@maestro-pro.app.\nRef: ES-${tid}\nOriginal sender: ${who}\nOriginal subject: ${subject}`;
const autolink = (t) => t.replace(/(^|\s)(https:\/\/[^\s<>()\[\]]+?)([.,;:!?]*)(?=\s|$|\))/g, "$1[$2]($2)$3");

/** Toby's answer to an escalation notice: sent from escalations@ exactly as a reply typed on the desk would be (same design, "Escalations" label, case handling),
 *  and kept on the desk's chain. Files on the reply go through the desk's own VirusTotal hold: the reply is sent once every one is clean. */
async function escalationReply({ id, full, refs, subjectIn }) {
  const thread = refs.ref ? await loadThread(refs.ref).catch(() => null) : null;
  if (!thread || thread.kind === "toby") {
    await tell(`Couldn't send your reply: ${subjectIn}`, `Your reply to "${subjectIn}" was not sent because I couldn't find that escalation. Reply to the escalation email itself (keeping the Ref line), or use the desk: https://maestro-pro.app/escalations/`, `toby-es-nomatch-${id}`);
    return { ok: true, ignored: "no-match" };
  }
  const text = ownText(full);
  if (!text) { await tell(`Your reply was empty: ${thread.subject}`, `Nothing was sent to ${thread.customer}: I couldn't find any new text in your reply.`, `toby-es-empty-${id}`); return { ok: true, ignored: "empty" }; }
  if (text.length > 6000) { await tell(`Your reply was too long: ${thread.subject}`, `Nothing was sent to ${thread.customer}: the reply is over 6,000 characters. Please shorten it.`, `toby-es-long-${id}`); return { ok: true, ignored: "long" }; }
  const { sendDeskReply } = await import("./support-admin.js");
  const reply = autolink(text), hasFiles = Array.isArray(full.attachments) ? full.attachments.length > 0 : false;
  try {
    if (!hasFiles) { await sendDeskReply(thread, { text: reply }); return { ok: true, replied: true }; }
    const metas = await ingestInbound(id, thread.id);
    if (!metas.length) throw new Error("the files could not be fetched");
    const ids = metas.map((m) => m.id);
    await updateThread(thread.id, (t) => { t.drafts = [...(t.drafts || []), ...metas]; t.heldReply = { id: `mail-${id}`, text: reply, close: false, guides: [], attachments: ids, at: new Date().toISOString() }; return true; });
    await queueScans(thread.id, metas);
    const t = await waitForScans(thread.id, ids, 40000);   // sends the held reply as soon as every file is clean
    const h = t?.heldReply;
    if (h?.blocked) {   // a file was flagged or could not be scanned: nothing goes out
      await updateThread(thread.id, (x) => { x.heldReply = null; return true; }).catch(() => {});
      await tell(`Your reply was not sent: ${thread.subject}`, `Your reply to ${thread.customer} was NOT sent. ${h.blocked}\n\nRemove or replace the file and reply again.`, `toby-es-blocked-${id}`);
      return { ok: true, blocked: true };
    }
    return { ok: true, replied: !h, scanning: Boolean(h) };   // still scanning: it goes out on its own when the scans finish
  } catch (e) {
    console.error("toby escalation reply", e?.message);
    await tell(`Your reply could not be sent: ${thread.subject}`, `Your reply to ${thread.customer} could not be sent (${String(e?.message).slice(0, 200)}). Try again, or use the desk: https://maestro-pro.app/escalations/`, `toby-es-fail-${id}`);
    return { ok: false };
  }
}

/** Builds and sends the answer in the support email design, from toby@, with the given clean files attached. Called straight away, or once the scans of a reply's files are done. */
export async function sendReply(rep, files = []) {
  const { emailId: id, customer, name, subject, text, lastIn, tid } = rep;
  const bad = files.filter((f) => f.scan?.status !== "clean" || !f.path);
  if (bad.length) {
    await tell(`Your reply was not sent: ${subject}`, `Your reply to ${customer} was NOT sent because VirusTotal did not clear every file:\n${bad.map((f) => `- ${f.name}: ${verdict(f, false)}`).join("\n")}\n\nRemove or replace those files and reply to the forwarded email again.`, `toby-blocked-${id}`);
    return { ok: true, blocked: true };
  }
  const loaded = [];
  let total = 0;
  for (const f of files) {
    const buf = await readBuffer(f.path).catch(() => null);
    total += buf?.length || 0;
    if (!buf || total > MAX_SENT_TOTAL) { await tell(`Your reply was not sent: ${subject}`, `Your reply to ${customer} was NOT sent: ${f.name} ${buf ? "and the other files add up to too much for one email" : "is missing from storage"}.`, `toby-size-${id}`); return { ok: true, blocked: true }; }
    loaded.push({ f, buf });
  }
  const resolve = (t) => { const x = String(t).trim(); return /^https:\/\/[^\s"<>]+$/.test(x) ? x : LINKS[x]?.[1] || null; };
  const linked = text.replace(/(^|\s)(https:\/\/[^\s<>()\[\]]+?)([.,;:!?]*)(?=\s|$|\))/g, "$1[$2]($2)$3");   // a web address typed on its own becomes a link
  const built = buildEmail({ name, reply: linked, resolve, label: "", contact: TOBY, signoff: "Toby Jones", attachments: loaded.map(({ f }) => ({ name: f.name, size: f.size })) });
  const html = built.html, plain = built.text.replace(/(https?:\/\/\S+) \(\1\)/g, "$1");
  const r = await send({
    from: REPLY_FROM(), to: [customer], reply_to: TOBY,   // sent from toby@; their answer comes back to toby@, is forwarded to you again, and so on
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    text: plain, html,
    ...(loaded.length && { attachments: loaded.map(({ f, buf }) => ({ filename: f.name, content: buf.toString("base64"), ...(f.type && { content_type: f.type }) })) }),
    ...(lastIn && { headers: { "In-Reply-To": lastIn, References: lastIn } }),
  }, `toby-reply-${id}`);
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    await tell(`Your reply could not be sent: ${subject}`, `Your reply to ${customer} could not be sent (${String(out.message || out.error || "Resend " + r.status).slice(0, 200)}). Reply to the forwarded email again to retry.`, `toby-fail-${id}`);
    return { ok: false };
  }
  if (tid) {
    try { await recordMessage({ threadKey: tid, customer, name, subject, message: { key: `toby-${id}`, dir: "out", by: "toby", at: new Date().toISOString(), text: plain, ...(out.id && { resendId: out.id }) }, status: "answered" }); }
    catch (e) { console.error("toby record", e?.message); }
  }
  return { ok: true, replied: true };
}
