// Marketplace emails. The look is the support desk's email (same table layout, colours and dark mode); every one is sent from the noreply
// address and replies go to the noreply address too. Links in the text are written [words](name) and only the names in `links` are turned into addresses.
import { NOREPLY, SUPPORT, SITE } from "./_mp.js";

export const FROM = () => process.env.MARKETPLACE_FROM || `Maestro Pro Marketplace <${NOREPLY}>`;
export const LINKS = {
  guidelines: `${SITE}/marketplace/guidelines/`,
  merchant: `${SITE}/marketplace/seller/`,
  marketplace: `${SITE}/marketplace/`,
  support: `mailto:${SUPPORT}`,
};
export const resolve = (t) => LINKS[t] || (t.startsWith(LINKS.guidelines) ? t : null);

const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const C = { walnut: "#15100B", amber: "#F6A828", deep: "#B86F00", paper: "#FFFDF7", cream: "#EFE8D6", card: "#FBF6E8", ink: "#1B140D", muted: "#6B5F4D", rule: "#E6DCC3", foot: "#F6F0E1" };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";
const linkStyle = `color:${C.deep};font-weight:600;text-decoration:underline`;

function blocks(text) {
  const out = []; let cur = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) { cur = null; continue; }
    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) { if (cur?.type === "bullets") cur.items.push(b[1]); else { cur = { type: "bullets", items: [b[1]] }; out.push(cur); } }
    else { cur = null; out.push({ type: "p", items: [line] }); }
  }
  return out;
}
const inline = (t) => esc(t).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, (m, txt, target) => {
  const url = resolve(target.replace(/&amp;/g, "&").trim());
  return url ? `<a href="${esc(url)}" class="lnk" style="${linkStyle}">${txt}</a>` : txt;
});
const plain = (t) => String(t).replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, (m, txt, target) => { const u = resolve(target.trim()); return u ? `${txt} (${u})` : txt; });

/** reply: the text; buttons: [label, url]; cards: [{ label, title, url, text }] (a guideline and its quote). Returns { html, text }. */
export function buildEmail({ name, reply, buttons = [], cards = [], label = "Marketplace", footnote = `This inbox is not monitored. If you need help, email ${SUPPORT}.` }) {
  const bl = blocks(reply), hi = `Hi ${name || "there"},`;
  const body = bl.map((b) => b.type === "bullets"
    ? `<ul style="margin:0 0 16px;padding-left:22px">${b.items.map((l) => `<li style="margin:4px 0">${inline(l)}</li>`).join("")}</ul>`
    : `<p style="margin:0 0 16px">${inline(b.items[0])}</p>`).join("");
  const btns = buttons.length ? `<div style="margin:8px 0 10px">${buttons.map(([l, u]) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;margin:0 12px 10px 0"><tr><td bgcolor="${C.amber}" style="border-radius:999px"><a href="${esc(u)}" style="display:inline-block;padding:12px 24px;font:700 15px ${FONT};color:${C.walnut};text-decoration:none;border-radius:999px">${esc(l)}</a></td></tr></table>`).join("")}</div>` : "";
  const cardHtml = cards.map((c) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="guide" style="margin:0 0 10px;border:1px solid ${C.rule};border-radius:10px;background:${C.card}"><tr><td style="padding:12px 16px"><div class="muted" style="font:700 10px ${FONT};letter-spacing:.09em;text-transform:uppercase;color:${C.muted}">${esc(c.label)}</div><a href="${esc(c.url)}" class="lnk" style="font:700 18px/1.3 ${SERIF};color:${C.deep};text-decoration:underline">${esc(c.title)}</a>${c.text ? `<div class="muted" style="margin-top:4px;font:14px/1.5 ${FONT};color:${C.muted}">${esc(c.text)}</div>` : ""}</td></tr></table>`).join("");
  const preheader = esc(plain(reply).replace(/\s+/g, " ").slice(0, 110));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>Maestro Pro ${esc(label)}</title>
<style>@media (max-width:620px){.card{padding:24px 20px !important}.wrap{padding:12px 6px !important}}@media (prefers-color-scheme:dark){.bg{background:#0F0B07 !important}.card{background:#1E1710 !important}.ink,.card p,.card li,.card td{color:#F3EBDA !important}.muted{color:#CDB991 !important}.lnk{color:#F6A828 !important}.guide{background:#2A2017 !important;border-color:#4A3B2B !important}.foot{background:#15100B !important;color:#9C8B6C !important}.foot a,.foot div{color:#9C8B6C !important}}</style></head>
<body class="bg" style="margin:0;padding:0;background:${C.cream}"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:${C.cream}"><tr><td align="center" class="wrap" style="padding:28px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td style="background:${C.walnut};border-radius:14px 14px 0 0;padding:18px 28px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td width="46" valign="middle"><img src="https://maestro-pro.app/assets/app-icon-160.png" width="38" height="38" alt="" style="display:block;border-radius:9px"></td><td valign="middle" style="font:700 21px ${SERIF};color:#F3EBDA">Maestro Pro</td><td align="right" valign="middle" style="font:700 11px ${FONT};letter-spacing:.1em;text-transform:uppercase;color:#CDB991">${esc(label)}</td></tr></table></td></tr>
<tr><td style="height:4px;background:${C.amber};font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td class="card" style="background:${C.paper};padding:32px 34px 30px;font:16px/1.6 ${FONT};color:${C.ink}">
<p class="ink" style="margin:0 0 18px;font:700 22px/1.3 ${SERIF};color:${C.ink}">${esc(hi)}</p>
${body}${btns}${cardHtml}
<p class="ink" style="margin:26px 0 0;font:16px/1.5 ${FONT};color:${C.ink}">Best regards,<br><strong>Maestro Pro Marketplace</strong></p>${footnote ? `\n<p class="muted" style="margin:20px 0 0;padding-top:14px;border-top:1px solid ${C.rule};font:13px/1.55 ${FONT};color:${C.muted}">${esc(footnote)}</p>` : ""}
</td></tr>
<tr><td class="foot" style="background:${C.foot};border-radius:0 0 14px 14px;padding:18px 34px;font:12px/1.5 ${FONT};color:#7A6E5B">Maestro Pro, made by <a href="https://thecaffeinemediacompany.com" style="color:#7A6E5B">Caffeine Media</a> &middot; <a href="https://maestro-pro.app/" style="color:#7A6E5B">maestro-pro.app</a> &middot; <a href="mailto:${SUPPORT}" style="color:#7A6E5B">${SUPPORT}</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = [hi, ...bl.map((b) => (b.type === "bullets" ? b.items.map((l) => `- ${plain(l)}`).join("\n") : plain(b.items[0]))),
    ...(buttons.length ? [buttons.map(([l, u]) => `${l}: ${u}`).join("\n")] : []),
    ...cards.map((c) => `${c.label}: ${c.title}${c.text ? `\n${c.text}` : ""}\n${c.url}`), "Best regards,\nMaestro Pro Marketplace", ...(footnote ? [footnote] : [])].join("\n\n");
  return { html, text };
}

/** Sends one email through Resend. `idem` makes a retry harmless. Returns true if Resend took it. */
export async function sendMail({ to, subject, mail, idem }) {
  if (!process.env.RESEND_API_KEY) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": idem },
    body: JSON.stringify({ from: FROM(), to: [to], reply_to: NOREPLY, subject, text: mail.text, html: mail.html }),
  }).catch(() => null);
  return Boolean(r && r.ok);
}
