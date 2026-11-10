// The Dispute Resolution Centre: copyright disputes against an item (guideline 8). A rights holder files one (on the website, or the support bot does it
// from an email). The item goes off sale while it is open, the merchant may respond, and the site owner decides. If it is upheld, the item is removed for
// good and the merchant gets a copyright strike. Three strikes bar the Merchant Account: everything is withdrawn and payouts stop.
import crypto from "node:crypto";
import { readJson, writeRaw, modify, products, updateProduct } from "./_blob.js";
import { buildEmail, sendMail, LINKS } from "./_email.js";
import { OWNER, SITE } from "./_mp.js";

export const DISPUTES = "marketplace/disputes.json";
export const STRIKES = 3;
export const RESPOND_DAYS = 7;
export const APPEAL_DAYS = 14;
const SELLER = (id) => `marketplace/sellers/${id}.json`;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const first = (n) => String(n || "").split(" ")[0] || "there";
export const disputes = async () => (await readJson(DISPUTES)) || [];
const open = (d) => d.status === "open" || d.status === "responded";

/** The ID shown on the Marketplace for an item, for example MP-1A2B3C4D. */
export const code = (p) => `MP-${p.id.slice(0, 8).toUpperCase()}`;
/** The item a claim names: a Marketplace link or id, its MP- ID, or an exact title. */
export function findListing(all, ref) {
  const r = String(ref || "").trim();
  const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(r)?.[0]?.toLowerCase();
  if (id) return all.find((p) => p.id === id);
  const short = /MP-([0-9A-F]{8})\b/i.exec(r)?.[1];
  if (short) { const hit = all.filter((p) => code(p) === `MP-${short.toUpperCase()}`); return hit.length === 1 ? hit[0] : undefined; }
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
  const d = { id: crypto.randomUUID(), created: Date.now(), status: "open", productId: p.id, productTitle: p.title, sellerId: p.sellerId, claimant, work, details, files: Array.isArray(b.evidence) ? b.evidence : [], via: b.via === "support" ? "support" : "form", appealKey: crypto.randomBytes(16).toString("hex"), respondBy: Date.now() + RESPOND_DAYS * 864e5 };
  await modify(DISPUTES, (a) => [...(a || []), d]);
  await updateProduct(p.id, (x) => ({ ...x, hold: x.hold || { dispute: d.id, at: Date.now() } }));   // off sale while the dispute is open
  const m = await sellerOf(p);
  const tag = d.id.slice(0, 8).toUpperCase();
  if (m?.email) await sendMail({ to: m.email, idem: `mp-dispute-${d.id}`, subject: `Copyright dispute: ${p.title}`,
    mail: buildEmail({ name: first(m.name), label: "Dispute Resolution Centre", reply: `A copyright dispute has been filed against **${p.title}** (reference ${tag}). The item is off sale while it is open.\n\n**The work:** ${work}\n**Their claim:** ${details}${d.files.length ? `\n**Evidence:** ${d.files.length} file${d.files.length > 1 ? "s" : ""}, in the Dispute Resolution Centre.` : ""}\n\nYou have ${RESPOND_DAYS} days to respond in the [Dispute Resolution Centre](merchant). We may decide without your response after that. If the dispute is upheld the item is removed and your account gets a copyright strike. Three strikes close a Merchant Account (see [the guidelines](guidelines)).`, buttons: [["Respond", LINKS.merchant]] }) }).catch(() => {});
  await sendMail({ to: OWNER, idem: `mp-dispute-o-${d.id}`, subject: `Dispute filed: ${p.title}`,
    mail: buildEmail({ name: "Toby", label: "Dispute Resolution Centre", reply: `${claimant.name} (${claimant.email}) filed a copyright dispute against **${p.title}** by ${p.sellerName}, ${d.via === "support" ? "through the support bot" : "on the website"}. Open the [merchant console](merchant) with your admin key to decide it.\n\n**The work:** ${work}\n**Claim:** ${details}` }) }).catch(() => {});
  await sendMail({ to: claimant.email, idem: `mp-dispute-c-${d.id}`, subject: `We have your copyright dispute (${tag})`,
    mail: buildEmail({ name: first(claimant.name), label: "Dispute Resolution Centre", reply: `Thank you. Your copyright dispute about **${p.title}** is filed, reference ${tag}. The item is off sale while it is looked at. The merchant has ${RESPOND_DAYS} days to respond, and we will email you the outcome.` }) }).catch(() => {});
  return { id: d.id };
}

/** A merchant answers a dispute against one of their items. */
export async function respond(sellerId, id, text, files = []) {
  let done = null;
  await modify(DISPUTES, (a) => (a || []).map((d) => {
    if (d.id !== id || d.sellerId !== sellerId || !open(d)) return d;
    done = { ...d, status: "responded", response: { text, files, at: Date.now() } };
    return done;
  }));
  if (done) await sendMail({ to: OWNER, idem: `mp-dispute-r-${id}-${Date.now()}`, subject: `Dispute response: ${done.productTitle}`,
    mail: buildEmail({ name: "Toby", label: "Dispute Resolution Centre", reply: `The merchant responded to the dispute about **${done.productTitle}**:\n\n${text}${files.length ? `\n\n(${files.length} evidence file${files.length > 1 ? "s" : ""} attached.)` : ""}\n\nDecide it in the [merchant console](merchant).` }) }).catch(() => {});
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

/** The item is removed for good and the merchant gets a strike (three bar the account). The item's earlier state is kept so an appeal can restore it. Returns true if the account was barred. */
async function takeDown(d, m) {
  let was;
  await updateProduct(d.productId, (x) => {
    was = { status: x.status, final: x.final, withdrawn: x.withdrawn, review: x.review };
    return { ...x, status: "refused", final: true, withdrawn: true, review: { ...x.review, ids: ["8.1"], reason: "Removed after a copyright dispute was decided against it.", decidedAt: Date.now(), notified: true } };
  });
  await modify(DISPUTES, (a) => (a || []).map((x) => (x.id === d.id ? { ...x, restore: was } : x)));
  if (!m || m.id === "platform") return false;
  const next = await modify(SELLER(m.id), (x) => (x ? { ...x, strikes: [...(x.strikes || []), { at: Date.now(), dispute: d.id, title: d.productTitle }] } : undefined));
  if (next && next.strikes.length >= STRIKES && !next.barred) { await bar(next); return true; }
  return false;
}

/** A successful appeal against an upheld dispute: the item goes back as it was, the strike is removed, and an account closed by that strike is reopened. */
async function putBack(d, m) {
  const others = (await disputes()).filter((x) => x.id !== d.id && x.productId === d.productId);
  const r = d.restore || {};
  if (!others.some((x) => x.status === "upheld")) await updateProduct(d.productId, (x) => ({ ...x, status: r.status && r.status !== "refused" ? r.status : "ready", final: r.final, withdrawn: r.withdrawn, sellerBarred: undefined, review: r.review || x.review, hold: others.some(open) ? x.hold : undefined }));
  if (!m || m.id === "platform") return false;
  let reopened = false;
  await modify(SELLER(m.id), (x) => {
    if (!x) return x;
    const strikes = (x.strikes || []).filter((s) => s.dispute !== d.id);
    reopened = Boolean(x.barred) && x.barred.reason === `${STRIKES} copyright strikes` && strikes.length < STRIKES;
    return { ...x, strikes, barred: reopened ? undefined : x.barred };
  });
  if (reopened) for (const p of (await products()).filter((x) => x.sellerId === m.id && x.sellerBarred)) await updateProduct(p.id, (x) => ({ ...x, withdrawn: undefined, sellerBarred: undefined }));
  return reopened;
}

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Who may appeal and what they may do, for the page that shows it. Returns { side, ok, why }. */
export function appealState(d, { sellerId, key }) {
  const side = sellerId ? "seller" : same(key, d.appealKey) ? "claimant" : null;
  if (!side || (side === "seller" && d.sellerId !== sellerId)) return { side: null, ok: false, why: "This decision can't be appealed." };
  if (d.status !== (side === "seller" ? "upheld" : "dismissed")) return { side, ok: false, why: side === "seller" ? "Only an upheld dispute can be appealed." : "Only a dismissed dispute can be appealed." };
  if (d.appeal) return { side, ok: false, why: "This decision has already been appealed. Each decision can be appealed once." };
  if (Date.now() - d.decision.at > APPEAL_DAYS * 864e5) return { side, ok: false, why: `The ${APPEAL_DAYS} days to appeal have passed.` };
  return { side, ok: true };
}

/** An appeal, with a statement and at least one evidence file. By the merchant (upheld) or by the rights holder with their link's key (dismissed). */
export async function appeal({ id, sellerId, key, text, files }) {
  text = clip(text, 2000);
  if (text.length < 20) return { error: "Explain why the decision should change.", code: 400 };
  if (!files?.length) return { error: "An appeal needs evidence. Attach at least one file.", code: 400 };
  let done = null, why = "";
  await modify(DISPUTES, (a) => (a || []).map((d) => {
    if (d.id !== id) return d;
    const s = appealState(d, { sellerId, key });
    if (!s.ok) { why = s.why; return d; }
    done = { ...d, appeal: { by: s.side, text, files, at: Date.now() } };
    return done;
  }));
  if (!done) return { error: why || "We couldn't find that dispute.", code: why ? 403 : 404 };
  const tag = done.id.slice(0, 8).toUpperCase(), by = done.appeal.by;
  const p = (await products()).find((x) => x.id === done.productId), m = p && (await sellerOf(p));
  const to = by === "seller" ? m : { email: done.claimant.email, name: done.claimant.name };
  await sendMail({ to: OWNER, idem: `mp-appeal-o-${id}`, subject: `Appeal filed: ${done.productTitle}`,
    mail: buildEmail({ name: "Toby", label: "Dispute Resolution Centre", reply: `${by === "seller" ? `The merchant (${m?.name || "unknown"})` : `${done.claimant.name} (${done.claimant.email})`} appealed the ${by === "seller" ? "upheld" : "dismissed"} dispute about **${done.productTitle}** (reference ${tag}):\n\n${text}\n\n(${files.length} evidence file${files.length > 1 ? "s" : ""} attached.) Decide it in the escalations desk.` }) }).catch(() => {});
  if (to?.email) await sendMail({ to: to.email, idem: `mp-appeal-c-${id}`, subject: `We have your appeal (${tag})`,
    mail: buildEmail({ name: first(to.name), label: "Dispute Resolution Centre", reply: `Thank you. Your appeal about **${done.productTitle}** (reference ${tag}) is filed. A person at Maestro Pro will look at it again, with your new evidence, and we will email you the outcome.` }) }).catch(() => {});
  return { ok: true };
}

/** The owner's decision on an appeal. overturn reverses the earlier decision (and its strike); otherwise the earlier decision stands and nothing else changes. */
export async function decideAppeal(id, overturn, note) {
  let d = null;
  await modify(DISPUTES, (a) => (a || []).map((x) => {
    if (x.id !== id || !x.appeal || x.appeal.outcome) return x;
    d = { ...x, appeal: { ...x.appeal, outcome: overturn ? "overturned" : "rejected", decidedAt: Date.now(), note }, status: overturn ? (x.status === "upheld" ? "dismissed" : "upheld") : x.status };
    return d;
  }));
  if (!d) return null;
  const p = (await products()).find((x) => x.id === d.productId), m = p && (await sellerOf(p)), by = d.appeal.by;
  let extra = false;   // seller appeal won: the account was reopened. claimant appeal won: the account was barred.
  if (overturn) extra = by === "seller" ? await putBack(d, m) : await takeDown(d, m);
  const tag = d.id.slice(0, 8).toUpperCase(), n = note ? `\n\n**Note:** ${note}` : "", t = `**${d.productTitle}** (reference ${tag})`;
  const msgs = {
    "seller-overturn": [`Good news: your appeal about ${t} was **successful**. We have reversed the earlier decision. The copyright strike is removed from your account and the item is back on sale.${extra ? " Your Merchant Account is open again. Sign in to your [merchant account](merchant) and reconnect your payment account." : ""}${n}`,
      `We looked again at the dispute about ${t}. The merchant appealed with new evidence and we have **reversed** our decision, so the dispute is now dismissed and the item is back on sale. We are sorry that this is not the outcome you wanted.${n}`],
    "seller-rejected": [`Your appeal about ${t} was **not successful**. The earlier decision stands and the item stays removed. You do not get another copyright strike for the appeal; the original strike stays on your account.${n}`,
      `The merchant appealed the decision about ${t}. We looked at their evidence and the original decision stands, so the item stays removed. Thank you for your patience.${n}`],
    "claimant-overturn": [`The rights holder appealed the dismissed dispute about ${t}. With their new evidence we have **reversed** our decision: the dispute is now **upheld**, the item has been removed for good and your account has a copyright strike.${extra ? " That was your third strike, so your Merchant Account has been closed (see the separate email)." : ""}${n}`,
      `Thank you for your appeal about ${t}, and we are sorry we did not get this right the first time. We looked again with your evidence and **reversed** our decision: the dispute is upheld and the item has been removed for good.${n}`],
    "claimant-rejected": [`The rights holder appealed the dismissed dispute about ${t}. We looked at their evidence and the dismissal stands. The item stays on sale and you do not need to do anything.${n}`,
      `Thank you for your appeal about ${t}. We looked at your new evidence carefully and the original decision stands, so the item stays on sale. We know this is not what you were hoping for, and we are sorry for any disappointment.${n}`],
  };
  const [toSeller, toClaimant] = msgs[`${by}-${overturn ? "overturn" : "rejected"}`], word = overturn ? "successful" : "not successful";
  if (m?.email) await sendMail({ to: m.email, idem: `mp-appeal-ds-${d.id}`, subject: `Appeal ${by === "seller" ? word : "decided"}: ${d.productTitle}`, mail: buildEmail({ name: first(m.name), label: "Dispute Resolution Centre", reply: toSeller }) }).catch(() => {});
  await sendMail({ to: d.claimant.email, idem: `mp-appeal-dc-${d.id}`, subject: `Appeal ${by === "claimant" ? word : "decided"}: ${d.productTitle}`, mail: buildEmail({ name: first(d.claimant.name), label: "Dispute Resolution Centre", reply: toClaimant }) }).catch(() => {});
  return d;
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
    barred = await takeDown(d, m);
  } else if (p && !all.some((x) => x.id !== d.id && x.productId === p.id && open(x))) {
    await updateProduct(p.id, (x) => ({ ...x, hold: undefined }));
  }
  const tag = d.id.slice(0, 8).toUpperCase(), n = note ? `\n\n**Note:** ${note}` : "";
  if (m?.email) await sendMail({ to: m.email, idem: `mp-dispute-d-${d.id}`, subject: `Dispute ${uphold ? "upheld" : "dismissed"}: ${d.productTitle}`,
    mail: buildEmail({ name: first(m.name), label: "Dispute Resolution Centre", reply: uphold
      ? `The copyright dispute about **${d.productTitle}** (reference ${tag}) was **upheld**. The item has been removed for good, and your account has a copyright strike.${barred ? "" : ` Three strikes close a Merchant Account (guideline 8.4).`}${n}`
      : `The copyright dispute about **${d.productTitle}** (reference ${tag}) was **dismissed**. The item is back on sale.${n}` }) }).catch(() => {});
  await sendMail({ to: d.claimant.email, idem: `mp-dispute-dc-${d.id}`, subject: uphold ? `We are sorry, and your copyright dispute was upheld (${tag})` : `Your copyright dispute was dismissed (${tag})`,
    mail: buildEmail({ name: first(d.claimant.name), label: "Dispute Resolution Centre", reply: uphold
      ? `Thank you for telling us, and we are truly sorry that your work was being sold on the Maestro Pro Marketplace without your permission. That should never have happened, and we understand how upsetting it is to find.\n\nYour dispute about **${d.productTitle}** (reference ${tag}) has been **upheld**. The item has been removed from the Marketplace for good, and the merchant has received a copyright strike on their account.${n}\n\nWe take the protection of creators' work very seriously, and we are sorry for the worry and the time this has cost you.`
      : `Thank you for telling us about **${d.productTitle}** (reference ${tag}). We looked at your dispute carefully and have **dismissed** it, so the item stays on sale.${n}\n\nWe know this is not the answer you were hoping for, and we are sorry for any disappointment. If you have more evidence that the work is yours, or you think we have this wrong, you can appeal within ${APPEAL_DAYS} days. An appeal needs evidence.`, buttons: uphold ? [] : [["Appeal this decision", `${SITE}/marketplace/disputes/appeal/?d=${d.id}&k=${d.appealKey}`]] }) }).catch(() => {});
  return d;
}
