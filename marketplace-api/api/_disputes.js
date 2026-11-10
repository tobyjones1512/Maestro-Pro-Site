// The Dispute Resolution Centre: copyright disputes against an item (guideline 8). A rights holder files one (on the website, or the support bot does it
// from an email). The item goes off sale while it is open, the merchant may respond, and the site owner decides. If it is upheld, the item is removed for
// good and the merchant gets a copyright strike. Three strikes bar the Merchant Account: everything is withdrawn and payouts stop.
import crypto from "node:crypto";
import { readJson, writeRaw, modify, products, updateProduct } from "./_blob.js";
import { buildEmail, sendMail, LINKS } from "./_email.js";
import { OWNER } from "./_mp.js";

export const DISPUTES = "marketplace/disputes.json";
export const STRIKES = 3;
export const RESPOND_DAYS = 7;
const SELLER = (id) => `marketplace/sellers/${id}.json`;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const first = (n) => String(n || "").split(" ")[0] || "there";
export const disputes = async () => (await readJson(DISPUTES)) || [];
const open = (d) => d.status === "open" || d.status === "responded";

/** The item a claim names: a Marketplace link or id, or an exact title. */
export function findListing(all, ref) {
  const r = String(ref || "").trim();
  const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(r)?.[0]?.toLowerCase();
  if (id) return all.find((p) => p.id === id);
  const hits = all.filter((p) => p.title.toLowerCase() === r.toLowerCase());
  return hits.length === 1 ? hits[0] : undefined;
}
const sellerOf = async (p) => (p.sellerId === "platform" ? { id: "platform", name: "Maestro Pro", email: OWNER } : await readJson(SELLER(p.sellerId)));

/** Opens a dispute. Returns { id } or { error, code }. */
export async function fileDispute(b) {
  const claimant = { name: clip(b.name, 80), org: clip(b.org, 80), email: clip(b.email, 120).toLowerCase() };
  const work = clip(b.work, 200), details = clip(b.details, 2000);
  if (claimant.name.length < 2 || !EMAIL.test(claimant.email)) return { error: "Give your name and a valid email address.", code: 400 };
  if (work.length < 3 || details.length < 20) return { error: "Say which work is yours and explain why the item infringes it.", code: 400 };
  if (b.goodFaith !== true) return { error: "Confirm the statements at the end of the form.", code: 400 };
  const p = findListing(await products(), b.listing);
  if (!p) return { error: "We couldn't find that item. Paste its Marketplace address.", code: 404 };
  const all = await disputes();
  const mine = all.filter((d) => d.claimant.email === claimant.email);
  const twin = mine.find((d) => d.productId === p.id && open(d));
  if (twin) return { id: twin.id };
  if (mine.filter((d) => Date.now() - d.created < 864e5).length >= 5) return { error: "Too many claims today. Please try again tomorrow.", code: 429 };
  const d = { id: crypto.randomUUID(), created: Date.now(), status: "open", productId: p.id, productTitle: p.title, sellerId: p.sellerId, claimant, work, details, via: b.via === "support" ? "support" : "form", respondBy: Date.now() + RESPOND_DAYS * 864e5 };
  await modify(DISPUTES, (a) => [...(a || []), d]);
  await updateProduct(p.id, (x) => ({ ...x, hold: x.hold || { dispute: d.id, at: Date.now() } }));   // off sale while the dispute is open
  const m = await sellerOf(p);
  const tag = d.id.slice(0, 8).toUpperCase();
  if (m?.email) await sendMail({ to: m.email, idem: `mp-dispute-${d.id}`, subject: `Copyright dispute: ${p.title}`,
    mail: buildEmail({ name: first(m.name), label: "Dispute Resolution Centre", reply: `A copyright dispute has been filed against **${p.title}** (reference ${tag}). The item is off sale while it is open.\n\n**The work:** ${work}\n**Their claim:** ${details}\n\nYou have ${RESPOND_DAYS} days to respond in the [Dispute Resolution Centre](merchant). We may decide without your response after that. If the dispute is upheld the item is removed and your account gets a copyright strike. Three strikes close a Merchant Account (see [the guidelines](guidelines)).`, buttons: [["Respond", LINKS.merchant]] }) }).catch(() => {});
  await sendMail({ to: OWNER, idem: `mp-dispute-o-${d.id}`, subject: `Dispute filed: ${p.title}`,
    mail: buildEmail({ name: "Toby", label: "Dispute Resolution Centre", reply: `${claimant.name} (${claimant.email}) filed a copyright dispute against **${p.title}** by ${p.sellerName}, ${d.via === "support" ? "through the support bot" : "on the website"}. Open the [merchant console](merchant) with your admin key to decide it.\n\n**The work:** ${work}\n**Claim:** ${details}` }) }).catch(() => {});
  await sendMail({ to: claimant.email, idem: `mp-dispute-c-${d.id}`, subject: `We have your copyright dispute (${tag})`,
    mail: buildEmail({ name: first(claimant.name), label: "Dispute Resolution Centre", reply: `Thank you. Your copyright dispute about **${p.title}** is filed, reference ${tag}. The item is off sale while it is looked at. The merchant has ${RESPOND_DAYS} days to respond, and we will email you the outcome.` }) }).catch(() => {});
  return { id: d.id };
}

/** A merchant answers a dispute against one of their items. */
export async function respond(sellerId, id, text) {
  let done = null;
  await modify(DISPUTES, (a) => (a || []).map((d) => {
    if (d.id !== id || d.sellerId !== sellerId || !open(d)) return d;
    done = { ...d, status: "responded", response: { text, at: Date.now() } };
    return done;
  }));
  if (done) await sendMail({ to: OWNER, idem: `mp-dispute-r-${id}-${Date.now()}`, subject: `Dispute response: ${done.productTitle}`,
    mail: buildEmail({ name: "Toby", label: "Dispute Resolution Centre", reply: `The merchant responded to the dispute about **${done.productTitle}**:\n\n${text}\n\nDecide it in the [merchant console](merchant).` }) }).catch(() => {});
  return done;
}

async function revokeMollie(token, hint) {
  if (!token || !process.env.MOLLIE_CLIENT_ID) return;
  await fetch("https://api.mollie.com/oauth2/tokens", {
    method: "DELETE",
    headers: { Authorization: "Basic " + Buffer.from(`${process.env.MOLLIE_CLIENT_ID}:${process.env.MOLLIE_CLIENT_SECRET}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, token_type_hint: hint }),
  }).catch(() => {});
}

/** Three strikes: the account is barred, every item is withdrawn, and our connection to the merchant's payment account is cut. */
async function bar(m) {
  const reason = `${STRIKES} copyright strikes`;
  await modify(SELLER(m.id), (x) => (x ? { ...x, barred: { at: Date.now(), reason }, access: undefined, refresh: undefined } : undefined));
  await revokeMollie(m.access, "access_token"); await revokeMollie(m.refresh, "refresh_token");
  for (const p of (await products()).filter((x) => x.sellerId === m.id)) await updateProduct(p.id, (x) => ({ ...x, withdrawn: true, sellerBarred: true }));
  await sendMail({ to: m.email, idem: `mp-barred-${m.id}`, subject: "Your Merchant Account has been closed",
    mail: buildEmail({ name: first(m.name), label: "Merchant account", reply: `Your Maestro Pro Merchant Account has been **closed** after ${STRIKES} copyright strikes (guideline 8.4).\n\n- Every item you sold has been withdrawn from sale.\n- You can no longer add or change items.\n- Payouts connected with your account are cancelled, and we have cut our connection to your payment account. No technology fee is refunded.\n- People who already bought your items keep them.\n\nIf you think this was a mistake, reply through the [Dispute Resolution Centre](merchant).` }) }).catch(() => {});
}

/** The owner's decision. uphold: the item is removed for good and the merchant gets a strike. Otherwise the dispute is dismissed and the item goes back on sale. */
export async function decide(id, uphold, note) {
  let d = null;
  await modify(DISPUTES, (a) => (a || []).map((x) => {
    if (x.id !== id || !open(x)) return x;
    d = { ...x, status: uphold ? "upheld" : "dismissed", decision: { at: Date.now(), note } };
    return d;
  }));
  if (!d) return null;
  const all = await disputes(), p = (await products()).find((x) => x.id === d.productId), m = p && (await sellerOf(p));
  let barred = false;
  if (uphold) {
    await updateProduct(d.productId, (x) => ({ ...x, status: "refused", final: true, withdrawn: true, review: { ...x.review, ids: ["8.1"], reason: "Removed after a copyright dispute was decided against it.", decidedAt: Date.now(), notified: true } }));
    if (m && m.id !== "platform") {
      const next = await modify(SELLER(m.id), (x) => (x ? { ...x, strikes: [...(x.strikes || []), { at: Date.now(), dispute: d.id, title: d.productTitle }] } : undefined));
      if (next && next.strikes.length >= STRIKES && !next.barred) { barred = true; await bar(next); }
    }
  } else if (p && !all.some((x) => x.id !== d.id && x.productId === p.id && open(x))) {
    await updateProduct(p.id, (x) => ({ ...x, hold: undefined }));
  }
  const tag = d.id.slice(0, 8).toUpperCase(), n = note ? `\n\n**Note:** ${note}` : "";
  if (m?.email) await sendMail({ to: m.email, idem: `mp-dispute-d-${d.id}`, subject: `Dispute ${uphold ? "upheld" : "dismissed"}: ${d.productTitle}`,
    mail: buildEmail({ name: first(m.name), label: "Dispute Resolution Centre", reply: uphold
      ? `The copyright dispute about **${d.productTitle}** (reference ${tag}) was **upheld**. The item has been removed for good, and your account has a copyright strike.${barred ? "" : ` Three strikes close a Merchant Account (guideline 8.4).`}${n}`
      : `The copyright dispute about **${d.productTitle}** (reference ${tag}) was **dismissed**. The item is back on sale.${n}` }) }).catch(() => {});
  await sendMail({ to: d.claimant.email, idem: `mp-dispute-dc-${d.id}`, subject: `Your copyright dispute was ${uphold ? "upheld" : "dismissed"} (${tag})`,
    mail: buildEmail({ name: first(d.claimant.name), label: "Dispute Resolution Centre", reply: uphold ? `Your dispute about **${d.productTitle}** was **upheld**. The item has been removed from the Marketplace.${n}` : `Your dispute about **${d.productTitle}** was **dismissed**, so the item stays on sale.${n}` }) }).catch(() => {});
  return d;
}
