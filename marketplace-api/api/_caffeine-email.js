import crypto from "node:crypto";
// Caffeine Media emails. Same table layout as the Maestro Pro marketplace email (see _email.js), but branded for
// The Caffeine Media Company: ink + carton yellow, system sans, and the Caffeine Media mark.
// Sent through Resend from one of hello@ / toby@ / noreply@thecaffeinemediacompany.com.
export const SITE_URL = "https://thecaffeinemediacompany.com";
export const LOGO = "https://thecaffeinemediacompany.com/assets/mark.png";

const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const C = { ink: "#16110E", paper: "#FAFAF7", field: "#F2B705", red: "#C8211A", dim: "#55504B", rule: "#D9D6CE", foot: "#F0EDE6", card: "#FFFFFF" };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";
const linkStyle = "color:" + C.red + ";font-weight:700;text-decoration:underline";

function blocks(text) {
  const out = []; let cur = null;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) { cur = null; continue; }
    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) { if (cur && cur.type === "bullets") cur.items.push(b[1]); else { cur = { type: "bullets", items: [b[1]] }; out.push(cur); } }
    else { cur = null; out.push({ type: "p", items: [line] }); }
  }
  return out;
}
const inline = (t) => esc(t).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, (m, txt, target) => {
  const url = /^https?:\/\//.test(target.trim()) ? target.trim() : null;
  return url ? "<a href=\"" + esc(url) + "\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"lnk\" style=\"" + linkStyle + "\">" + esc(txt) + "</a>" : esc(txt);
});
const plain = (t) => String(t).replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, (m, txt, target) => {
  const url = /^https?:\/\//.test(target.trim()) ? target.trim() : null;
  return url ? txt + " (" + url + ")" : txt;
});

export function buildEmail({ name, reply, buttons = [], label = "", signoff = "The Caffeine Media Company", footnote = "", fromName = "Caffeine Media" }) {
  const bl = blocks(reply), hi = "Hi " + (name || "there") + ",";
  const body = bl.map((b) => b.type === "bullets"
    ? "<ul style=\"margin:0 0 16px;padding-left:22px\">" + b.items.map((l) => "<li style=\"margin:4px 0\">" + inline(l) + "</li>").join("") + "</ul>"
    : "<p style=\"margin:0 0 16px\">" + inline(b.items[0]) + "</p>").join("");
  const btns = buttons.length ? "<div style=\"margin:8px 0 10px\">" + buttons.map(([l, u]) => "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"display:inline-block;margin:0 12px 10px 0\"><tr><td bgcolor=\"" + C.field + "\" style=\"border-radius:999px\"><a href=\"" + esc(u) + "\" style=\"display:inline-block;padding:12px 24px;font:700 15px " + FONT + ";color:" + C.ink + ";text-decoration:none;border-radius:999px\">" + esc(l) + "</a></td></tr></table>").join("") + "</div>" : "";
  const preheader = esc(plain(reply).replace(/\s+/g, " ").slice(0, 110));
  const html = "<!doctype html><html lang=\"en-GB\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\"><meta name=\"supported-color-schemes\" content=\"light dark\"><title>" + esc(fromName) + "</title>\n"
    + "<style>@media (max-width:620px){.card{padding:24px 20px !important}.wrap{padding:12px 6px !important}}@media (prefers-color-scheme:dark){.bg{background:#0F0B0A !important}.card{background:#1E1A16 !important}.ink,.card p,.card li,.card td{color:#F3EFE6 !important}.muted{color:#B5A98F !important}.lnk{color:" + C.field + " !important}.foot{background:#0F0B0A !important;color:#9C9280 !important}.foot a,.foot div{color:#9C9280 !important}}</style></head>\n"
    + "<body class=\"bg\" style=\"margin:0;padding:0;background:" + C.paper + "\"><div style=\"display:none;max-height:0;overflow:hidden;opacity:0;color:transparent\">" + preheader + "</div>\n"
    + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" class=\"bg\" style=\"background:" + C.paper + "\"><tr><td align=\"center\" class=\"wrap\" style=\"padding:28px 12px\">\n"
    + "<table role=\"presentation\" width=\"600\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"width:100%;max-width:600px\">\n"
    + "<tr><td style=\"background:" + C.ink + ";border-radius:14px 14px 0 0;padding:18px 28px\"><table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"100%\"><tr><td width=\"46\" valign=\"middle\"><img src=\"" + LOGO + "\" width=\"38\" height=\"38\" alt=\"\" style=\"display:block;border-radius:9px\"></td><td valign=\"middle\" style=\"font:800 21px " + FONT + ";color:" + C.paper + ";letter-spacing:-.01em;text-transform:uppercase\">" + esc(fromName) + "</td><td align=\"right\" valign=\"middle\" style=\"font:650 11px " + FONT + ";letter-spacing:.1em;text-transform:uppercase;color:" + C.field + "\">" + esc(label) + "</td></tr></table></td></tr>\n"
    + "<tr><td style=\"height:4px;background:" + C.field + ";font-size:0;line-height:0\">&nbsp;</td></tr>\n"
    + "<tr><td class=\"card\" style=\"background:" + C.card + ";padding:32px 34px 30px;font:16px/1.6 " + FONT + ";color:" + C.ink + "\">\n"
    + "<p class=\"ink\" style=\"margin:0 0 18px;font:800 22px/1.3 " + SERIF + ";color:" + C.ink + "\">" + esc(hi) + "</p>\n"
    + body + btns + "\n"
    + "<p class=\"ink\" style=\"margin:26px 0 0;font:16px/1.5 " + FONT + ";color:" + C.ink + "\">Best regards,<br><strong>" + esc(signoff) + "</strong></p>"
    + (footnote ? "\n<p class=\"muted\" style=\"margin:20px 0 0;padding-top:14px;border-top:1px solid " + C.rule + ";font:13px/1.55 " + FONT + ";color:" + C.dim + "\">" + esc(footnote) + "</p>" : "") + "\n"
    + "</td></tr>\n"
    + "<tr><td class=\"foot\" style=\"background:" + C.foot + ";border-radius:0 0 14px 14px;padding:18px 34px;font:12px/1.5 " + FONT + ";color:" + C.dim + "\">The Caffeine Media Company &middot; <a href=\"" + SITE_URL + "\" style=\"color:" + C.dim + "\">thecaffeinemediacompany.com</a>" + (label ? " &middot; " + esc(label) : "") + "</td></tr>\n"
    + "</table></td></tr></table></body></html>";
  const text = [hi, ...bl.map((b) => (b.type === "bullets" ? b.items.map((l) => "- " + plain(l)).join("\n") : plain(b.items[0]))),
    ...(buttons.length ? [buttons.map(([l, u]) => l + ": " + u).join("\n")] : []),
    "Best regards,\n" + signoff, ...(footnote ? [footnote] : [])].join("\n\n");
  return { html, text };
}

export async function sendCaffeineMail({ from, to, reply_to, subject, text, html, idem, attachments }) {
  if (!process.env.RESEND_API_KEY) return false;
  const payload = { from, to: [to], reply_to: reply_to || from, subject, text, html };
  if (Array.isArray(attachments) && attachments.length) {
    payload.attachments = attachments.map((a) => ({ filename: a.filename, content: a.content, ...(a.content_type ? { content_type: a.content_type } : {}) }));
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json", "Idempotency-Key": idem || "cm-" + Date.now() },
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!r) return false;
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: body && (body.message || body.error) || ("Resend " + r.status) };
  return { ok: true, id: body && body.id };
}


const INBOUND_ADDRESS = process.env.CAFFEINE_INBOUND_ADDRESS || "2a0ee022@oldaupi.resend.app";
const SECRET = process.env.MARKETPLACE_SECRET || process.env.ADMIN_PASSWORD || "caffeine";
function inboundParts() {
  const at = INBOUND_ADDRESS.indexOf("@");
  return { local: INBOUND_ADDRESS.slice(0, at), domain: INBOUND_ADDRESS.slice(at + 1) };
}

export function inboundDomain() { return inboundParts().domain; }

export function makeAlias(recipient, fromKey) {
  const { local, domain } = inboundParts();
  const payload = Buffer.from(JSON.stringify({ r: String(recipient || ""), f: String(fromKey || "") })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url").slice(0, 12);
  return `${local}+${payload}.${sig}@${domain}`;
}

export function parseAlias(to) {
  const { local, domain } = inboundParts();
  const addr = Array.isArray(to) ? to.join(", ") : String(to || "");
  const re = new RegExp(local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\+([^\s,<>]+)@" + domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const m = re.exec(addr);
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 2) return null;
  const payload = parts[0], sig = parts[1];
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url").slice(0, 12);
  if (sig !== expected) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return { recipient: obj.r, fromKey: obj.f };
  } catch {
    // legacy: payload was plain recipient
    try { return { recipient: Buffer.from(payload, "base64url").toString("utf8"), fromKey: "" }; } catch { return null; }
  }
}

export function stripGreetingSignature(text) {
  let lines = String(text || "").split(/\r?\n/);
  // drop leading greeting line
  while (lines.length && /^\s*(hi|hello|dear|hey)\b[!,.]?\s*$/i.test(lines[0].trim())) lines.shift();
  while (lines.length && !lines[0].trim()) lines.shift();
  // drop trailing signature from a marker
  const markers = /^(best regards|regards|thanks|cheers|sincerely|yours|kind regards|many thanks|--|sent from my )/i;
  let cut = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (markers.test(lines[i].trim())) { cut = i; break; }
  }
  if (cut >= 0) lines = lines.slice(0, cut);
  // trim trailing blanks
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n").trim();
}

export function ownerAddress(addr) {
  const a = String(addr || "").toLowerCase().trim();
  if (a.endsWith("@thecaffeinemediacompany.com")) return true;
  if (a === "inbound@thecaffeinemedia.com") return true;
  const extra = (process.env.CAFFEINE_OWNER_ADDRESSES || "").split(/[\s,]+/).filter(Boolean).map((x) => x.toLowerCase());
  return extra.includes(a);
}

export function inboundForwardTo() {
  return process.env.CAFFEINE_FORWARD_TO || "inbound@thecaffeinemedia.com";
}
