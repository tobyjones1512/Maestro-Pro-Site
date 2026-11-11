// The Maestro Pro marketplace server (its own Vercel project, separate from the support desk). One function, picked by ?fn=; vercel.json rewrites /api/marketplace-<fn>.
//
// Merchants: sign up and pay the one-time £5 technology fee (Mollie), connect a Mollie account for payouts (Mollie Connect), then add content.
// Every product is reviewed before it can be sold (see _review.js): VirusTotal on each file, then the AI reviewer against the guidelines.
// Buyers pay in their own currency (Mollie). A merchant's sales are charged on their own Mollie account with a 30% application fee that Mollie moves to the platform.
// Nothing here deletes a bundle or an order: once someone has paid they can download again, whatever happens to the listing.
import { Readable } from "node:stream";
import { get } from "@vercel/blob";
import { readJson, writeRaw, modify, products, addProduct, updateProduct, INDEX } from "./_blob.js";
import crypto from "node:crypto";
import { TAX, TAX_ON, taxFor, quote, recordTax, refundTax, LEDGER } from "./_tax.js";
import { SUPPORT, SITE, API, CUT, FEE_GBP, decimals, cors, rand, sha, isAdmin, sign, unsign, currencyFor, rate, minor, fmt, price, cleanRegions, availableIn, refundable, REFUND_DAYS, live, mollie, oauth, OWNER } from "./_mp.js";
import { BUNDLE, ALLOWED, COVER, ext, readBlob, readRange, bundleInfo, variantsOf } from "./_bundle.js";
import { step, sweep, ownerDecide, MAX_REFUSALS, GUIDELINE } from "./_review.js";
import { buildEmail, sendMail, LINKS } from "./_email.js";
import { code, disputes, fileDispute, respond as respondDispute, decide as decideDispute, appeal as fileAppeal, decideAppeal, appealState, STRIKES, RESPOND_DAYS, APPEAL_DAYS } from "./_disputes.js";
import guidelines from "../lib/guidelines.js";

const ORDER = (id) => `marketplace/orders/${id}.json`;
const SELLER = (id) => `marketplace/sellers/${id}.json`;
const BY_EMAIL = (email) => `marketplace/sellers-by-email/${sha(email)}.json`;
const SALES = (id) => `marketplace/sales/${id}.json`;
const BUYER = (id) => `marketplace/buyers/${id}.json`;
const ORDERS_OF = (email) => `marketplace/orders-by-email/${sha(email)}.json`;   // every order a buyer email has started
const MAGIC = "PLAYALONG1";
const AUTHORIZE = "https://my.mollie.com/oauth2/authorize";
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const fail = (res, code, error) => res.status(code).json({ error });
const inReview = (p) => p.status === "scanning" || p.status === "reviewing";
/** Distribution: "auto" puts an accepted item on sale straight away, "manual" waits for the merchant to release it, "date" waits for a date and time in GMT. */
const released = (p) => p.released === true || !p.release || p.release.mode === "auto" || (p.release.mode === "date" && Date.now() >= p.release.at);
const onSale = (p) => p.status === "ready" && !p.withdrawn && !p.hold && released(p);   // a dispute puts an item on hold
const awaiting = (p) => p.status === "ready" && !p.withdrawn && !released(p);
function releaseOf(r) {
  const mode = r?.mode;
  if (!mode || mode === "auto") return { release: { mode: "auto" } };
  if (mode === "manual") return { release: { mode: "manual" } };
  const at = Number(r?.at);
  if (mode !== "date" || !Number.isFinite(at)) return { error: "Choose the release date and time." };
  if (at < Date.now() - 6e4) return { error: "The release date must be in the future (GMT)." };
  if (at > Date.now() + 2 * 365 * 864e5) return { error: "The release date can be at most two years away." };
  return { release: { mode: "date", at } };
}
/** Mollie's card fee (3.25% + 20p), as it applies to a payment in this currency (the fixed part in that currency's smallest unit). The buyer is charged it on top of the price. */
const CARD_PCT = 0.0325, CARD_FIXED_GBP = 0.2;
async function cardFee(cur, r) {
  const gbp = (await rate("GBP")) || 0.78;
  return { pct: CARD_PCT, fixed: Math.ceil(CARD_FIXED_GBP * (r / gbp) * 10 ** decimals(cur) - 1e-6) };
}
const REOPEN_DAYS = 30;
const REOPEN_FEE_GBP = "15.00";   // the technology fee to reactivate a closed account (a new account pays FEE_GBP)
const feeFor = (m) => (m.reactivating ? REOPEN_FEE_GBP : FEE_GBP);
const day = (t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const first = (name) => String(name || "").split(" ")[0] || "there";

async function who(req) {
  const key = String(req.headers["x-mp-key"] || "");
  if (isAdmin(key)) return { id: "platform", name: "Maestro Pro", admin: true };
  const [id, secret] = key.split(".");
  if (!/^[0-9a-f]{16}$/.test(id || "") || !secret) return null;
  const m = await readJson(SELLER(id));
  return m && !m.closed && m.keyHash === sha(secret) ? m : null;
}
/** A merchant may add content once the fee is paid and a Mollie account is connected. */
const ready = (m) => Boolean(m.admin || (!m.barred && m.fee?.status === "paid" && m.access));

/** The bundle must be there and really be a .maestropro file, not whatever a merchant chose to upload. */
async function bundleOK(id) {
  const r = await get(BUNDLE(id), { access: process.env.BLOB_ACCESS === "public" ? "public" : "private", useCache: false }).catch(() => null);
  if (!r || r.statusCode !== 200) return false;
  const reader = r.stream.getReader();
  const { value } = await reader.read();
  reader.cancel().catch(() => {});
  return Boolean(value) && Buffer.from(value.slice(0, MAGIC.length)).toString() === MAGIC;
}

// ---- Public
// What a buyer can open without the app: PDF and audio files work anywhere. The rest are for Maestro Pro or other music software.
const FORMAT = { pdf: "PDF", mp3: "Audio", m4a: "Audio", wav: "Audio", aif: "Audio", aiff: "Audio", caf: "Audio", aac: "Audio", flac: "Audio", musicxml: "MusicXML", mxl: "MusicXML", xml: "MusicXML", mid: "MIDI", midi: "MIDI", kar: "Karaoke", cdg: "Karaoke", lrc: "Lyrics", txt: "Lyrics" };
const formatsOf = (p) => [...new Set([...(p.review?.files || []).filter((f) => !f.proof), ...(p.extras || [])].map((f) => FORMAT[ext(f.name)]).filter(Boolean))];
const GENRES = ["Ambient", "Blues", "Children's", "Classical", "Country", "Dance", "Electronic", "Film and TV", "Folk", "Gospel and Worship", "Hip-hop", "Holiday and Seasonal", "Indie", "Jazz", "Latin", "Metal", "Musical Theatre", "Pop", "Punk", "R&B and Soul", "Reggae", "Rock", "Video Games", "World", "Other"];
const cleanGenres = (g) => [...new Set((Array.isArray(g) ? g : []).map(String).filter((x) => GENRES.includes(x)))].slice(0, 3);
const TYPE = { single: "Single", ep: "EP", album: "Album" };
const coverIx = (p) => (p.extras || []).findIndex((x) => x.cover);
const pub = (p) => ({ genres: p.genres || [], kind: p.kind === "music" ? "music" : "score", type: p.kind === "music" ? TYPE[p.format] || "" : "", cover: coverIx(p) >= 0 ? `${API}/api/marketplace-preview?id=${p.id}&x=${coverIx(p)}` : "", code: code(p), formats: formatsOf(p), anywhere: formatsOf(p).some((f) => f === "PDF" || f === "Audio"), id: p.id, title: p.title, composer: p.composer, description: p.description, priceUSD: p.priceUSD, sellerName: p.sellerName, contents: p.contents, versions: variantsOf(p).map((v) => v.label).filter(Boolean), downloads: (p.extras || []).length, created: p.created, regions: p.regions || [] });
const country = (req) => req.headers["x-vercel-ip-country"];
async function list(req, res) {
  const cur = currencyFor(req.headers["x-vercel-ip-country"]);
  const r = await rate(cur);
  res.status(200).json({ listings: (await products()).filter((p) => onSale(p) && availableIn(p.regions, country(req))).reverse().map(pub), currency: r ? cur : "USD", rate: r || 1, cardFee: await cardFee(r ? cur : "USD", r || 1), cut: CUT, tax: taxFor(country(req)) });
}
/** One item for its page: the files in each version, with a preview where one is safe to show. */
async function item(req, res) {
  const cur = currencyFor(req.headers["x-vercel-ip-country"]), r = await rate(cur);
  const p = (await products()).find((x) => x.id === String(req.query.id) && onSale(x) && availableIn(x.regions, country(req)));
  if (!p) return fail(res, 404, "That piece isn't for sale.");
  const kind = (n) => ({ pdf: "pdf", mp3: "audio", musicxml: "xml", xml: "xml" })[ext(n)] || "", ex = p.extras || [];
  const url = (q) => `${API}/api/marketplace-preview?id=${p.id}&${q}`;
  const detail = await Promise.all(variantsOf(p).map(async (v, i) => ({ id: v.id, label: v.label || "", files: [
    ...(((await bundleInfo(v.id).catch(() => null))?.files) || []).map((f) => ({ name: f.name, size: f.size, type: FORMAT[ext(f.name)] || "", kind: kind(f.name), preview: kind(f.name) ? url(`v=${v.id}&f=${encodeURIComponent(f.name)}`) : "" })),
    ...ex.map((e, k) => [e, k]).filter(([e]) => (e.v ? e.v === v.id : i === 0)).map(([e, k]) => ({ name: e.name, size: e.size, type: FORMAT[ext(e.name)] || "", kind: kind(e.name), preview: kind(e.name) ? url(`x=${k}`) : "" })),
  ] })));
  if (p.kind === "music") detail.push({ id: p.id, label: "Tracks", files: ex.map((e, k) => [e, k]).filter(([e]) => !e.cover).map(([e, k]) => ({ name: e.name, title: e.title ? `${e.n}. ${e.title}` : e.name, size: e.size, type: FORMAT[ext(e.name)] || "", kind: kind(e.name), preview: kind(e.name) ? url(`x=${k}`) : "" })) });
  res.status(200).json({ listing: { ...pub(p), detail }, currency: r ? cur : "USD", rate: r || 1, cardFee: await cardFee(r ? cur : "USD", r || 1), tax: taxFor(country(req)), taxes: TAX_ON ? TAX : {}, country: String(country(req) || "").toUpperCase() });
}
const CLIP = 450000;   // about 30 seconds of a typical MP3
/** A preview that is no use as a copy: the first page of a PDF with a PREVIEW watermark across it, or the first 30 seconds or so of an MP3. */
async function preview(req, res) {
  const p = (await products()).find((x) => x.id === String(req.query.id) && onSale(x));
  if (!p) return fail(res, 404, "Not found.");
  const { v, f, x } = req.query;
  let name, buf;
  if (x !== undefined) {
    const e = (p.extras || [])[Number(x)];
    if (!e || e.size > 40e6) return fail(res, 404, "No preview.");
    name = e.name;
    const r = await get(e.path, { access: process.env.BLOB_ACCESS === "public" ? "public" : "private", useCache: false }).catch(() => null);
    if (!r || r.statusCode !== 200) return fail(res, 404, "No preview.");
    const reader = r.stream.getReader(), parts = [], want = ext(name) === "mp3" ? CLIP : Infinity;
    let n = 0;
    while (n < want) { const { value, done } = await reader.read(); if (done) break; parts.push(value); n += value.length; }
    reader.cancel().catch(() => {});
    buf = Buffer.concat(parts).subarray(0, want === Infinity ? undefined : want);
  } else {
    const info = variantsOf(p).some((a) => a.id === v) && (await bundleInfo(String(v)).catch(() => null)), file = info?.files.find((a) => a.name === f);
    if (!file || file.size > 40e6) return fail(res, 404, "No preview.");
    name = file.name;
    buf = await readRange(String(v), file.offset, file.offset + (ext(name) === "mp3" ? Math.min(file.size, CLIP) : file.size));
  }
  if (!buf) return fail(res, 404, "No preview.");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "public, max-age=300");
  if (ext(name) === "mp3") { res.setHeader("Content-Type", "audio/mpeg"); return res.status(200).send(buf); }
  if (x !== undefined && (p.extras || [])[Number(x)]?.cover && COVER.has(ext(name))) { res.setHeader("Content-Type", ext(name) === "png" ? "image/png" : "image/jpeg"); return res.status(200).send(buf); }
  if (ext(name) === "musicxml" || ext(name) === "xml") {   // only the first eight bars of each part, so the preview isn't the whole score
    const xml = buf.toString("utf8").replace(/<part\s[^>]*>[\s\S]*?<\/part>/g, (part) => {
      const bars = part.match(/<measure\b[\s\S]*?<\/measure>/g) || [], head = part.slice(0, part.indexOf(bars[0] ?? "</part>"));
      return head + bars.slice(0, 8).join("") + "</part>";
    });
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    return res.status(200).send(xml);
  }
  if (ext(name) !== "pdf") return fail(res, 404, "No preview.");
  const { PDFDocument, StandardFonts, rgb, degrees } = await import("pdf-lib");
  const src = await PDFDocument.load(buf, { ignoreEncryption: true }), out = await PDFDocument.create();
  const [pg] = await out.copyPages(src, [0]);
  out.addPage(pg);
  const font = await out.embedFont(StandardFonts.HelveticaBold), { width, height } = pg.getSize(), size = Math.min(width, height) / 5;
  pg.drawText("PREVIEW", { x: width * 0.12, y: height * 0.28, size, font, color: rgb(0.45, 0.45, 0.45), opacity: 0.28, rotate: degrees(40) });
  pg.drawText(`Preview: page 1 of ${src.getPageCount()}`, { x: 24, y: 14, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="preview.pdf"');
  res.status(200).send(Buffer.from(await out.save()));
}
const guidelinesInfo = (req, res) => res.status(200).json(guidelines);

// ---- Paying
/** The token for the merchant's current Mollie connection, or (e) for an earlier one that they have since changed away from. */
async function sellerToken(s, e = s) {
  if (e.exp > Date.now() + 60e3) return e.access;
  const r = await oauth({ grant_type: "refresh_token", refresh_token: e.refresh });
  if (!r.data.access_token) throw new Error("Seller's Mollie connection has expired.");
  Object.assign(e, { access: r.data.access_token, exp: Date.now() + r.data.expires_in * 1e3, refresh: r.data.refresh_token || e.refresh });
  await writeRaw(SELLER(s.id), s);
  return e.access;
}
/** Who gets paid for an order: the platform itself, or a connected merchant. */
async function payee(sellerId, at) {
  if (sellerId === "platform") return { token: process.env.MOLLIE_API_KEY, extra: "" };
  const s = await readJson(SELLER(sellerId));
  if (!s?.access) throw new Error("Seller not found.");
  // A payment made before the merchant changed their Mollie account lives in the account they had then: it is looked up, and refunded, there.
  const old = at && s.connectedAt && at < s.connectedAt ? (s.previous || []).find((e) => (e.from || 0) <= at && at < e.until) : null;
  return { token: await sellerToken(s, old || s), seller: s, extra: live() ? "" : "?testmode=true" };
}

async function buy(req, res) {
  const { id, method } = req.body || {};
  const buyer = await buyerWho(req);
  if (!buyer) return fail(res, 401, "Sign in to your buyer account to buy.");
  const email = buyer.email;
  const l = (await products()).find((x) => x.id === id);
  if (!l || !onSale(l)) return fail(res, 404, "That piece isn't for sale any more.");
  if (!availableIn(l.regions, country(req))) return fail(res, 403, "This piece isn't available in your country.");
  if (!EMAIL.test(String(email ?? "").trim())) return fail(res, 400, "Enter a valid email address.");
  // An optional tip, as a percentage of the price or an amount in dollars. It is charged with the price.
  // The app pays with Apple Pay at the price it showed: the quote (asked for with quote: true) is signed, and its currency and rate are used again here.
  const paying = req.body?.applePayToken || req.body?.cardToken;   // Apple Pay (the app or the website) or a card (Mollie Components): both pay the signed quote
  const wallet = paying ? unsign(req.body.quoteToken) : null;
  if (paying && (!wallet || wallet.id !== l.id || wallet.exp < Date.now())) return fail(res, 400, "The price has expired. Try again.");
  const t = req.body?.tip || {};   // the app sends the same tip (a percentage) with the quote and with the payment; the signed total below holds it to the price shown
  let cur = currencyFor(req.headers["x-vercel-ip-country"]), r = await rate(cur);
  if (!r) { cur = "USD"; r = 1; }
  if (wallet) ({ cur, r } = wallet);
  const pct = t.local === undefined && t.usd === undefined && [0, 5, 10, 15].includes(Number(t.percent)) ? Number(t.percent) : 0;   // a percentage is of the price the buyer sees
  let tipUSD = t.local !== undefined ? Number(t.local) / r : t.usd !== undefined ? Math.round(Number(t.usd) * 100) / 100 : 0;
  if (!Number.isFinite(tipUSD) || tipUSD < 0 || tipUSD > 500) return fail(res, 400, "A tip can be from $0 to $500.");
  const ip = String(country(req) || "").toUpperCase(), cc = ip, tax = taxFor(cc);   // the country is worked out from the buyer's connection
  let q;
  if (req.body?.quote) {
    const cf = wallet ? wallet.fee : await cardFee(cur, r);
    q = quote(l.priceUSD, tipUSD || 0, cur, r, tax.rate, cf, pct);
    // The card form (Mollie Components) is made for the profile that will take the payment.
    const who0 = await payee(l.sellerId);
    const prof = (await mollie("GET", "/profiles/me", who0.token).catch(() => null))?.data;   // the profile's name is what a card statement shows
    const profileId = who0.seller?.profileId || process.env.MOLLIE_PROFILE_ID || prof?.id;
    return res.status(200).json({ profileId, statement: prof?.name || "", testmode: !live(), currency: cur, total: fmt(q.total, cur), net: fmt(q.net, cur), tax: fmt(q.tax, cur), tip: fmt(q.tip, cur), taxName: tax.name, taxRate: tax.rate, token: sign({ id: l.id, cur, r, fee: cf, total: q.total, exp: Date.now() + 10 * 60e3 }) });
  }
  if (wallet && quote(l.priceUSD, tipUSD || 0, cur, r, tax.rate, wallet.fee, pct).total !== wallet.total) return fail(res, 409, "The price changed. Try again.");   // never charge more than the Apple Pay sheet showed
  if (pct) tipUSD = quote(l.priceUSD, 0, cur, r, tax.rate, wallet ? wallet.fee : await cardFee(cur, r), pct).tip / 10 ** decimals(cur) / r;   // what the tip comes to in dollars, for the seller's records
  const order = { id: rand(), token: rand(), listing: l.id, sellerId: l.sellerId, title: l.title, email: String(email).trim(), usd: l.priceUSD, tipUSD, status: "open", created: Date.now() };
  const pay = await payee(l.sellerId);
  const create = async (currency, rt, how) => {
    q = quote(l.priceUSD, tipUSD || 0, currency, rt, tax.rate, wallet ? wallet.fee : await cardFee(currency, rt), pct);   // the total is rounded up once, so the price, tax and tip shown add up to it
    const m = q.total;
    return mollie("POST", "/payments", pay.token, {
      amount: { currency, value: fmt(m, currency) },
      description: `${l.title} (Maestro Pro marketplace)`,
      redirectUrl: `${SITE}/marketplace/thanks/?o=${order.id}&t=${order.token}${req.body?.app ? "&app=1" : ""}`,
      webhookUrl: `${API}/api/marketplace-webhook?o=${order.id}`,
      metadata: { order: order.id, listing: l.id },
      ...(how && { method: how }),
      ...(wallet && (req.body.applePayToken ? { applePayPaymentToken: req.body.applePayToken } : { cardToken: req.body.cardToken })),
      ...(pay.seller && { profileId: pay.seller.profileId, testmode: !live(), applicationFee: { amount: { currency, value: fmt(Math.min(m, Math.max(1, Math.round((q.net - q.fee + q.tip) * CUT) + q.tax)), currency) }, description: q.tax ? "Maestro Pro marketplace fee (30%) and tax" : "Maestro Pro marketplace fee (30%)" } }),
    });
  };
  // Apple Pay first when asked; then any method; then dollars, for a currency this account can't take.
  const tries = wallet ? [[cur, r, req.body.cardToken ? "creditcard" : "applepay"]] : [...(method === "applepay" ? [[cur, r, "applepay"]] : []), [cur, r], ...(cur !== "USD" ? [["USD", 1]] : [])];
  let p, used = cur;
  for (const [c, rt, how] of tries) { used = c; p = await create(c, rt, how); if (p.status !== 422) break; }
  const url = p.data?._links?.checkout?.href;
  if (wallet ? p.status >= 300 : !url) return fail(res, 502, p.data?.detail || "Couldn't start the payment.");
  order.paymentId = p.data.id; order.currency = used; order.amount = p.data.amount.value;
  order.tax = { cc, ip, name: tax.name, rate: tax.rate, inclusive: tax.inclusive, fx: used === "USD" ? 1 : r, ...q };
  await writeRaw(ORDER(order.id), order);
  await modify(ORDERS_OF(order.email.toLowerCase()), (a) => [...(a || []), { order: order.id, token: order.token, listing: l.id, title: l.title, t: order.created }]).catch(() => {});
  if (wallet) {   // paid at once, failed, or (a card that needs 3-D Secure) waiting for the bank's check, which is at the url
    const status = (await sync(order).catch(() => order)).status;
    return res.status(200).json({ status, order: order.id, token: order.token, ...(status === "open" && url && { url }) });
  }
  res.status(200).json({ url, order: order.id, token: order.token });
}

/** Apple Pay on the website only: Mollie's merchant session for the browser's validation URL. (The iOS app has no merchant validation step: its merchant ID is checked by Apple through the entitlement.) */
async function applePaySession(req, res) {
  if (!(await buyerWho(req)) && !(await who(req))) return fail(res, 401, "Sign in to pay.");   // a buyer, or a merchant paying the fee
  const { validationUrl, domain } = req.body || {};
  if (!/^https:\/\/[\w.-]+\.apple\.com\//.test(String(validationUrl)) || !["maestro-pro.app", "www.maestro-pro.app"].includes(domain)) return fail(res, 400, "That Apple Pay request isn't valid.");
  const m = await mollie("POST", "/wallets/applepay/sessions", process.env.MOLLIE_API_KEY, { validationUrl, domain });
  if (m.status >= 300) return fail(res, 502, m.data?.detail || "Apple Pay couldn't be started.");
  res.status(200).json(m.data);
}

const link = (o) => `${API}/api/marketplace-download?o=${o.id}&t=${o.token}`;
/** Asks Mollie where the payment stands, and the first time it is paid: records the sale and emails the download link. */
async function sync(order) {
  if (order.status === "paid" || order.status === "refunded") return order;
  const pay = await payee(order.sellerId || (await products()).find((x) => x.id === order.listing)?.sellerId, order.created);
  const p = await mollie("GET", `/payments/${order.paymentId}${pay.extra}`, pay.token);
  const s = p.data?.status;
  if (!s || s === order.status) return order;
  order.status = s;
  if (s === "paid") order.paidAt = Date.now();
  await writeRaw(ORDER(order.id), order);
  if (s === "paid") {
    const sale = { id: order.id, t: Date.now(), listing: order.listing, title: order.title, usd: order.usd, ...(order.tipUSD && { tipUSD: order.tipUSD }), currency: order.currency, amount: order.amount };
    await modify(SALES(order.sellerId || "platform"), (a) => ((a || []).some((x) => x.id === sale.id) ? undefined : [...(a || []), sale])).catch(() => {});
    const seller = (await products()).find((x) => x.id === order.listing)?.sellerName || "Maestro Pro";
    await recordTax(order, seller).catch((e) => console.error("tax ledger", e?.message));
    await sendMail({ to: order.email, idem: `mp-${order.id}`, subject: `Your receipt: ${order.title}`,
      mail: buildEmail({ name: "there", label: "Marketplace receipt", reply: `Thank you for your purchase. This is your receipt.\n\n- Item: **${order.title}**\n- Seller: ${seller}\n- Amount paid: **${order.amount} ${order.currency}**${order.tax?.tax ? ` (includes ${order.tax.name} of ${fmt(order.tax.tax, order.currency)} ${order.currency})` : ""}${order.tipUSD ? ` (includes a tip of $${order.tipUSD.toFixed(2)} USD)` : ""}\n- Date: ${new Date().toUTCString().slice(0, 16)}\n- Order number: ${order.id.slice(0, 8).toUpperCase()}\n\nYour download is ready. Download it, then open the file in Maestro Pro, or use the files on their own. It is yours to keep, and you can use this link to download it again at any time.\n\nYou can cancel for a full refund within ${REFUND_DAYS} days from your [buyer account](account), under the [refund rules](refunds).`, buttons: [["Download", link(order)]] }) });
  }
  return order;
}

async function owned(req) {
  const { o, t } = req.query;
  const order = /^[0-9a-f]{32}$/.test(o || "") && (await readJson(ORDER(o)));
  return order && t && order.token === t ? order : null;
}
async function webhook(req, res) {
  const order = /^[0-9a-f]{32}$/.test(req.query.o || "") && (await readJson(ORDER(req.query.o)));
  if (order) await sync(order).catch(() => {});
  res.status(200).end();
}
/** What a buyer may download: the last accepted version of the item (versions and extra files). */
const packageOf = (o, all) => {
  const p = all.find((x) => x.id === o.listing);
  return p?.published || { variants: p ? variantsOf(p) : [{ id: o.listing, label: "" }], extras: p?.extras || [] };
};
const TYPES = { pdf: "application/pdf", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", aif: "audio/aiff", aiff: "audio/aiff", caf: "audio/x-caf", flac: "audio/flac", mid: "audio/midi", midi: "audio/midi", kar: "audio/midi", musicxml: "application/vnd.recordare.musicxml+xml", mxl: "application/vnd.recordare.musicxml", xml: "application/xml", txt: "text/plain; charset=utf-8", lrc: "text/plain; charset=utf-8" };
const safeName = (n) => String(n).replace(/[^\w .()-]/g, "").trim() || "file";
async function order(req, res) {
  let o = await owned(req);
  if (!o) return fail(res, 404, "Order not found.");
  o = await sync(o);
  const out = { status: o.status, title: o.title };
  if (o.status === "paid") {
    const pk = packageOf(o, await products()), u = link(o);
    const xurl = (e, i) => ({ name: e.name, title: e.title ? `${e.n}. ${e.title}` : "", size: e.size, url: `${u}&x=${i}` });
    Object.assign(out, { download: u, kind: (await products()).find((x) => x.id === o.listing)?.kind === "music" ? "music" : "score", extras: pk.extras.map((e, i) => [e, i]).filter(([e]) => !pk.variants.some((v) => v.id === e.v)).map(([e, i]) => xurl(e, i)),
      variants: await Promise.all(pk.variants.map(async (v) => ({ id: v.id, label: v.label || "", url: `${u}&v=${v.id}`, extras: pk.extras.map((e, i) => [e, i]).filter(([e]) => e.v === v.id).map(([e, i]) => xurl(e, i)),
        files: ((await bundleInfo(v.id).catch(() => null))?.files || []).map((f) => ({ name: f.name, size: f.size, url: `${u}&v=${v.id}&f=${encodeURIComponent(f.name)}` })) }))) });
  }
  res.status(200).json(out);
}
/** Whatever happens to the listing afterwards (withdrawn, even refused on a later review), a paid order always downloads.
 *  No extra parameters: the first version as a .maestropro bundle. v: a version's bundle. v and f: one file out of it (for use outside Maestro Pro). x: an extra file. */
async function download(req, res) {
  let o = await owned(req);
  if (!o) return fail(res, 404, "Order not found.");
  o = await sync(o);
  if (o.status !== "paid") return fail(res, 402, "This order hasn't been paid.");
  const pk = packageOf(o, await products()), { v, f, x } = req.query;
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (x !== undefined) {
    const e = pk.extras[Number(x)], r = e && (await get(e.path, { access: bucket(), useCache: false }).catch(() => null));
    if (!r || r.statusCode !== 200) return fail(res, 404, "The file is missing. Email support@maestro-pro.app.");
    res.setHeader("Content-Type", TYPES[ext(e.name)] || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName(e.name)}"`);
    if (r.blob.size) res.setHeader("Content-Length", r.blob.size);
    return Readable.fromWeb(r.stream).pipe(res);
  }
  const variant = v ? pk.variants.find((a) => a.id === v) : pk.variants[0];
  if (!variant) return fail(res, 404, "Not found.");
  if (f) {   // a single file from the bundle, buffered (the largest is a recording)
    const file = (await bundleInfo(variant.id))?.files.find((a) => a.name === f);
    const buf = file && (await readRange(variant.id, file.offset, file.offset + file.size));
    if (!buf) return fail(res, 404, "Not found.");
    res.setHeader("Content-Type", TYPES[ext(file.name)] || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName(file.name)}"`);
    return res.status(200).send(buf);
  }
  const r = await get(BUNDLE(variant.id), { access: bucket(), useCache: false });
  if (!r || r.statusCode !== 200) return fail(res, 404, "The file is missing. Email support@maestro-pro.app.");
  const name = safeName(o.title) + (variant.label ? ` (${safeName(variant.label)})` : "");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.maestropro"`);
  if (r.blob.size) res.setHeader("Content-Length", r.blob.size);
  Readable.fromWeb(r.stream).pipe(res);   // streamed: bundles with audio are bigger than a normal response may be
}

// ---- Merchant accounts
/** Starts the £5 technology fee on the platform's Mollie account. */
async function startFee(m, wallet) {   // wallet: a card or Apple Pay token from the page, so the payment is made there instead of on Mollie's own page
  const p = await mollie("POST", "/payments", process.env.MOLLIE_API_KEY, {
    ...wallet,
    amount: { currency: "GBP", value: feeFor(m) }, description: m.reactivating ? "Maestro Pro Marketplace technology fee (reactivation)" : "Maestro Pro Marketplace technology fee (one-time)",
    redirectUrl: `${SITE}/marketplace/onboard/?m=${m.id}`, webhookUrl: `${API}/api/marketplace-fee-webhook?m=${m.id}`, metadata: { merchant: m.id, kind: "fee" },
  });
  const url = p.data?._links?.checkout?.href;
  if (wallet ? p.status >= 300 : !url) throw new Error(p.data?.detail || "Couldn't start the payment.");
  return { url, fee: { paymentId: p.data.id, status: "open", created: Date.now() } };
}

const DEBUG_FEE = () => ({ paymentId: "debug", status: "paid", paidAt: Date.now(), debug: true });
async function signup(req, res) {
  const { name, email, agree } = req.body || {};
  const em = String(email ?? "").trim().toLowerCase();
  if (clip(name, 80).length < 2) return fail(res, 400, "Enter your name or your business's name.");
  if (!EMAIL.test(em)) return fail(res, 400, "Enter a valid email address.");
  if (!agree) return fail(res, 400, "Please agree to the Merchant Content Review Guidelines.");
  const old = await readJson(BY_EMAIL(em)).then((x) => x && readJson(SELLER(x.id)));
  if (old?.closed && old.permanent) return fail(res, 403, "The Merchant Account for that email address was closed permanently. It can't be reopened, and the email address can't be used for a new one.");
  if (old?.closed) {   // a closed account can be reopened (not replaced) once a month has passed
    const on = (old.closedAt || 0) + REOPEN_DAYS * 864e5;
    if (Date.now() < on) return fail(res, 409, `The Merchant Account for that email address was closed on ${day(old.closedAt)}. It can be reopened from ${day(on)}: sign up again with the same email address then.`);
    return res.status(200).json({ reactivate: true, name: old.name, feeGBP: REOPEN_FEE_GBP });
  }
  if (old?.fee?.status === "paid") return fail(res, 409, "There is already a Merchant Account for that email address. Ask for a sign-in link instead.");
  const secret = rand(24), m = { ...old, id: old?.id || rand(8), name: clip(name, 80), email: em, keyHash: sha(secret), created: old?.created || Date.now(), agreedAt: Date.now() };
  const debug = debugOK(req.body);   // testing only: the debug code skips the fee
  if (debug) m.fee = DEBUG_FEE();
  await writeRaw(SELLER(m.id), m);
  await writeRaw(BY_EMAIL(em), { id: m.id });
  res.status(200).json({ key: `${m.id}.${secret}`, ...(debug && { url: `${SITE}/marketplace/onboard/` }) });   // otherwise the page opens the payment box
}

/** The merchant's fee payment, brought up to date. The first time it is paid, the welcome email goes out. */
async function syncFee(m) {
  if (!m.fee || m.fee.status === "paid") return m;
  const p = await mollie("GET", `/payments/${m.fee.paymentId}`, process.env.MOLLIE_API_KEY);
  const s = p.data?.status;
  if (!s || s === m.fee.status) return m;
  m = { ...(await readJson(SELLER(m.id))), fee: { ...m.fee, status: s, ...(s === "paid" && { paidAt: Date.now() }) } };
  await writeRaw(SELLER(m.id), m);
  if (s === "paid" && m.reactivating) {   // reactivation fee paid: what was withdrawn comes back, to be reviewed again
    await reopen(m);
    m = { ...m, reactivating: undefined };
    await writeRaw(SELLER(m.id), m);
  } else if (s === "paid") await sendMail({ to: m.email, idem: `mp-fee-${m.id}`, subject: "Your Merchant Account is open",
    mail: buildEmail({ name: first(m.name), label: "Merchant account", reply: `Thank you. Your technology fee has been paid and your Maestro Pro Merchant Account is open.\n\nThe next step is to set up your payout details, so that your share of every sale is paid to you. After that you can add content. Every item is checked before it goes on sale, so please read the [Merchant Content Review Guidelines](guidelines) first.`, buttons: [["Open your merchant account", LINKS.merchant]] }) });
  return m;
}
async function feeWebhook(req, res) {
  const m = /^[0-9a-f]{16}$/.test(req.query.m || "") && (await readJson(SELLER(req.query.m)));
  if (m) await syncFee(m).catch(() => {});
  res.status(200).end();
}
/** Paying the fee on the page, the way a purchase is paid: a signed quote, then Apple Pay or a card typed into Mollie Components. */
async function feePay(req, res) {
  const me = await who(req);
  if (!me || me.admin) return fail(res, 401, "Not signed in.");
  if (me.fee?.status === "paid") return fail(res, 409, "The technology fee is already paid.");
  const b = req.body || {}, total = String(feeFor(me));
  if (b.quote) {
    const prof = (await mollie("GET", "/profiles/me", process.env.MOLLIE_API_KEY).catch(() => null))?.data;
    return res.status(200).json({ profileId: process.env.MOLLIE_PROFILE_ID || prof?.id, statement: prof?.name || "", testmode: !live(), currency: "GBP", total, token: sign({ m: me.id, total, exp: Date.now() + 10 * 60e3 }) });
  }
  const q = unsign(b.quoteToken);
  if (!q || q.m !== me.id || q.exp < Date.now() || q.total !== total) return fail(res, 400, "The price has expired. Try again.");
  const wallet = b.applePayToken ? { method: "applepay", applePayPaymentToken: b.applePayToken } : b.cardToken ? { method: "creditcard", cardToken: b.cardToken } : null;
  if (!wallet) return fail(res, 400, "Choose how to pay.");
  const f = await startFee(me, wallet).catch((e) => ({ error: e.message }));
  if (f.error) return fail(res, 502, f.error);
  const m = await syncFee({ ...me, fee: f.fee }).catch(() => ({ ...me, fee: f.fee }));
  if (m.fee === f.fee) await writeRaw(SELLER(me.id), m);   // not looked up yet: keep the payment so the webhook can find it
  res.status(200).json({ status: m.fee.status, ...(m.fee.status === "open" && f.url && { url: f.url }) });   // a card that needs 3-D Secure goes to the bank's check at the url
}
async function feeRetry(req, res) {
  const me = await who(req);
  if (!me || me.admin) return fail(res, 401, "Not signed in.");
  if (me.fee?.status === "paid") return fail(res, 409, "The technology fee is already paid.");
  const f = debugOK(req.body) ? { url: `${SITE}/marketplace/onboard/`, fee: DEBUG_FEE() } : await startFee(me);
  await writeRaw(SELLER(me.id), { ...me, fee: f.fee });
  res.status(200).json({ url: f.url });
}

/** Emails a fresh sign-in link. The old link stops working, so a link can be asked for at most every ten minutes. Always answers the same, so it can't be used to find out who has an account. */
async function signin(req, res) {
  const em = String(req.body?.email ?? "").trim().toLowerCase();
  const m = EMAIL.test(em) && (await readJson(BY_EMAIL(em)).then((x) => x && readJson(SELLER(x.id))).then((x) => (x?.closed ? null : x)));
  if (m && !(m.signinAt > Date.now() - 600e3)) {
    const token = rand(24);   // one-time: it is swapped for a session key the first time it is used, and expires after 15 minutes
    await modify(SELLER(m.id), (x) => (x ? { ...x, linkHash: sha(token), linkExp: Date.now() + 900e3, signinAt: Date.now() } : undefined));
    await sendMail({ to: m.email, idem: `mp-signin-${m.id}-${Date.now()}`, subject: "Your Maestro Pro merchant sign-in link",
      mail: buildEmail({ name: first(m.name), label: "Merchant account", reply: "Here is your sign-in link. This link works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.", buttons: [["Sign in", `${LINKS.merchant}#t=${m.id}.${token}`]] }) });
  }
  res.status(200).json({ ok: true });
}

/** The Maestro Pro app signs a merchant in with a 6-digit code emailed to them (like the buyer's), instead of a link. */
async function sellerCode(req, res) {
  const em = String(req.body?.email ?? "").trim().toLowerCase();
  const m = EMAIL.test(em) && (await readJson(BY_EMAIL(em)).then((x) => x && readJson(SELLER(x.id))).then((x) => (x?.closed ? null : x)));
  if (!m) return fail(res, 404, "There is no Merchant Account for that email address.");
  if (m.codeAt > Date.now() - 60e3) return fail(res, 429, "Wait a minute before asking for another code.");
  const code = String(crypto.randomInt(100000, 1000000));
  await modify(SELLER(m.id), (x) => (x ? { ...x, codeHash: sha(code + em), codeExp: Date.now() + 600e3, tries: 0, codeAt: Date.now() } : undefined));
  await sendMail({ to: m.email, idem: `mp-scode-${m.id}-${Date.now()}`, subject: "Your Maestro Pro merchant sign-in code",
    mail: buildEmail({ name: first(m.name), label: "Merchant account", reply: `Your merchant sign-in code is **${code}**.\n\nIt works for 10 minutes. If you didn't ask for it, you can ignore this email.` }) });
  res.status(200).json({ ok: true });
}
async function sellerVerify(req, res) {
  const em = String(req.body?.email ?? "").trim().toLowerCase(), code = String(req.body?.code ?? "").trim();
  const m = EMAIL.test(em) && (await readJson(BY_EMAIL(em)).then((x) => x && readJson(SELLER(x.id))).then((x) => (x?.closed ? null : x)));
  if (!m?.codeHash || m.codeExp < Date.now() || m.tries >= 5) return fail(res, 400, "That code has expired. Ask for a new one.");
  if (m.codeHash !== sha(code + em)) { await modify(SELLER(m.id), (x) => (x ? { ...x, tries: (x.tries || 0) + 1 } : undefined)); return fail(res, 400, "That code isn't right."); }
  const secret = rand(24);
  await modify(SELLER(m.id), (x) => (x ? { ...x, keyHash: sha(secret), codeHash: undefined } : undefined));
  res.status(200).json({ key: `${m.id}.${secret}` });
}

/** Swaps the one-time link from the email for a session key. The link stops working the moment it is used. */
async function signinVerify(req, res) {
  const [id, token] = String(req.body?.t ?? "").split(".");
  if (!/^[0-9a-f]{16}$/.test(id || "") || !token) return fail(res, 400, "That sign-in link isn't valid.");
  const secret = rand(24);
  let ok = false;
  await modify(SELLER(id), (m) => {
    if (!m?.linkHash || m.linkExp < Date.now() || m.linkHash !== sha(token)) return undefined;
    if (m.closed && Date.now() < (m.closedAt || 0) + REOPEN_DAYS * 864e5) return undefined;
    ok = true;
    return { ...m, keyHash: sha(secret), linkHash: undefined, linkExp: undefined, ...(m.closed && { closed: undefined, closedAt: undefined, reopenedAt: Date.now(), agreedAt: Date.now(), reactivating: true, fee: { status: "none" } }) };   // open again, but nothing goes back on sale until the reactivation fee is paid
  });
  if (!ok) return fail(res, 400, "That sign-in link has already been used or has expired. Ask for a new one.");
  res.status(200).json({ key: `${id}.${secret}` });
}

// Register this redirect URL on the Mollie app: https://maestro-marketplace-api.vercel.app/api/marketplace-callback
async function connectStart(req, res) {
  const me = await who(req);
  if (!me || me.admin) return fail(res, 401, "Not signed in.");
  const m = await syncFee(me);
  if (m.fee?.status !== "paid") return fail(res, 402, "Pay the technology fee first.");
  if (!process.env.MOLLIE_CLIENT_ID || !process.env.MARKETPLACE_SECRET) return fail(res, 503, "Payout set-up isn't switched on yet.");
  const q = new URLSearchParams({
    client_id: process.env.MOLLIE_CLIENT_ID, redirect_uri: `${API}/api/marketplace-callback`, response_type: "code", approval_prompt: req.body?.change ? "force" : "auto",   // changing asks Mollie to show the account choice again
   
    scope: "payments.read payments.write refunds.read refunds.write profiles.read organizations.read onboarding.read", state: sign({ m: m.id, ts: Date.now() }),
  });
  res.status(200).json({ url: `${AUTHORIZE}?${q}` });
}
async function callback(req, res) {
  const st = unsign(req.query.state);
  const back = (msg) => res.redirect(302, `${SITE}/marketplace/onboard/?error=${encodeURIComponent(msg)}`);
  const m = st && Date.now() - st.ts < 3600e3 && (await readJson(SELLER(st.m)));
  if (!m || m.fee?.status !== "paid") return back("That link expired. Please start the payout set-up again.");
  if (req.query.error) return back("You didn't finish setting up your payouts. Nothing has changed, and you can carry on whenever you're ready.");   // they backed out of the payout set-up
  if (!req.query.code) return back("The payout set-up didn't complete. Please try again.");
  const t = await oauth({ grant_type: "authorization_code", code: req.query.code, redirect_uri: `${API}/api/marketplace-callback` });
  if (!t.data.access_token) return back("The payout set-up was refused. Please try again.");
  const tok = t.data.access_token;
  const [org, me] = await Promise.all([mollie("GET", "/organizations/me", tok), mollie("GET", "/profiles/me", tok)]);
  let profile = me.data.id ? me.data : null;
  if (!profile) profile = (await mollie("GET", "/profiles?limit=1", tok)).data?._embedded?.profiles?.[0] || null;   // a new account may not have a "current" profile yet
  if (!org.data.id || !profile?.id) {
    console.error("callback: unreadable payout account", org.status, org.data?.detail, me.status, me.data?.detail);
    return back("Your payout account isn't ready yet. Finish creating your business profile there (it can take a few minutes to be approved), then set up payouts again.");
  }
  // Moving to a different Mollie account keeps the old connection, so refunds and payment checks for earlier sales still go to the account that took them.
  const previous = m.access && m.mollieOrg !== org.data.id ? [...(m.previous || []), { mollieOrg: m.mollieOrg, profileId: m.profileId, access: m.access, refresh: m.refresh, exp: m.exp, from: m.connectedAt || 0, until: Date.now() }] : m.previous;
  await writeRaw(SELLER(m.id), { ...m, previous, mollieOrg: org.data.id, profileId: profile.id, access: t.data.access_token, refresh: t.data.refresh_token, exp: Date.now() + t.data.expires_in * 1e3, connectedAt: Date.now() });
  res.redirect(302, `${SITE}/marketplace/seller/`);
}

/** The merchant's account page: where they are, their products with the review result, and their sales. Also moves a product in review one step on. */
async function merchant(req, res) {
  let me = await who(req);
  if (!me) return fail(res, 401, "Not signed in.");
  if (!me.admin) me = await syncFee(me);
  const waiting = (await products()).find((p) => p.sellerId === me.id && inReview(p));
  if (waiting) await step(waiting.id);
  const mine = (await products()).filter((p) => p.sellerId === me.id), every = (await readJson(SALES(me.id))) || [], sales = every.filter((x) => !x.refunded);
  const per = (id) => sales.filter((s) => s.listing === id), back = (id) => every.filter((s) => s.refunded && (!id || s.listing === id));
  const gross = sales.reduce((n, s) => n + s.usd, 0), share = me.admin ? 1 : 1 - CUT, charged = (list) => (me.admin ? 0 : list.reduce((n, s) => n + (s.usd + (s.tipUSD || 0)) * CUT, 0));   // the marketplace share of a refunded sale is charged back
  const allDisputes = await disputes(), allProducts = await products();
  res.status(200).json({
    id: me.id, name: me.name, email: me.email, admin: Boolean(me.admin),
    fee: me.admin ? "paid" : me.fee?.status || "none", feeGBP: feeFor(me), reopened: Boolean(me.reopenedAt), connected: Boolean(me.admin || me.access), canPublish: ready(me),
    products: mine.slice().reverse().map((p) => ({
      id: p.id, code: code(p), title: p.title, composer: p.composer, priceUSD: p.priceUSD, regions: p.regions || [], status: p.status, withdrawn: Boolean(p.withdrawn), release: p.release || { mode: "auto" }, awaiting: awaiting(p), created: p.created,
      files: p.review?.files ? { done: p.review.files.filter((f) => f.scan.status === "clean").length, total: p.review.files.length } : undefined,
      reason: ["refused", "escalated"].includes(p.status) ? p.review?.reason : undefined, refusals: p.refusals || 0, final: Boolean(p.final), versions: variantsOf(p).map((v) => v.label).filter(Boolean),
      ...(["ready", "refused"].includes(p.status) && !p.final && { editable: true, edit: { genres: p.genres || [], release: p.release || { mode: "auto" }, kind: p.kind === "music" ? "music" : "score", format: p.format, description: p.description, variants: variantsOf(p), extras: p.extras || [], proof: p.proof || { text: "", files: [] } } }), removable: removable(p), canAppeal: p.status === "refused" && !p.final && (p.refusals || 0) < MAX_REFUSALS,
      guidelines: ["refused", "escalated"].includes(p.status) ? (p.review?.ids || []).map((i) => ({ id: i, title: GUIDELINE[i]?.title, text: GUIDELINE[i]?.text })) : undefined,
      sold: per(p.id).length, earnedUSD: Math.round((per(p.id).reduce((n, s) => n + s.usd, 0) * share - charged(back(p.id))) * 100) / 100,
    })),
    sales: { tipsUSD: Math.round(sales.reduce((n, s) => n + (s.tipUSD || 0), 0) * share * 100) / 100, tipCount: sales.filter((s) => s.tipUSD).length, count: sales.length, refunded: every.length - sales.length, grossUSD: Math.round(gross * 100) / 100, earnedUSD: Math.round((gross * share - charged(back())) * 100) / 100, recent: sales.slice(-15).reverse().map((s) => ({ t: s.t, title: s.title, usd: s.usd, tip: Math.round((s.tipUSD || 0) * share * 100) / 100 })) },
    cut: CUT, maxRefusals: MAX_REFUSALS, strikes: (me.strikes || []).length, maxStrikes: STRIKES, barred: Boolean(me.barred), respondDays: RESPOND_DAYS,
    disputes: allDisputes.filter((d) => me.admin || d.sellerId === me.id).reverse().map((d) => ({ id: d.id, created: d.created, status: d.status, title: d.productTitle, claimant: d.claimant.name + (d.claimant.org ? `, ${d.claimant.org}` : ""), ...(me.admin && { email: d.claimant.email, via: d.via }), code: allProducts.find((p) => p.id === d.productId)?.id.slice(0, 8).toUpperCase(), files: d.files || [], work: d.work, details: d.details, respondBy: d.respondBy, response: d.response, decision: d.decision, appeal: d.appeal, canAppeal: !me.admin && appealState(d, { sellerId: me.id }).ok, appealUntil: d.decision && d.decision.at + APPEAL_DAYS * 864e5 })),
    ...(me.admin && { escalations: (await products()).filter((p) => p.status === "escalated").map((p) => ({ id: p.id, title: p.title, composer: p.composer, description: p.description, priceUSD: p.priceUSD, seller: p.sellerName, history: p.history || [] })) }),
  });
}

/** Puts an accepted item that is awaiting distribution on sale now. */
async function release(req, res) {
  const me = await who(req);
  if (!me) return fail(res, 401, "Not signed in.");
  const p = await updateProduct(String(req.body?.id), (x) => (x.sellerId === me.id && x.status === "ready" && !x.withdrawn && !released(x) ? { ...x, released: true, releasedAt: Date.now() } : undefined));
  if (!p || p.sellerId !== me.id || !released(p)) return fail(res, 409, "This item isn't awaiting distribution.");
  res.status(200).json({ ok: true });
}
async function withdraw(req, res) {
  const me = await who(req);
  if (!me) return fail(res, 401, "Not signed in.");
  const { id, withdrawn } = req.body || {};
  const p = await updateProduct(String(id), (x) => (x.sellerId === me.id && x.status === "ready" ? { ...x, withdrawn: Boolean(withdrawn) } : undefined));
  if (!p || p.sellerId !== me.id) return fail(res, 404, "Product not found.");
  res.status(200).json({ ok: true, withdrawn: Boolean(p.withdrawn) });   // only stops new sales: buyers keep their downloads
}

/** A submission that never went on sale can be cancelled or removed: while it is in review, after a refusal, or while it waits for a final decision. */
const removable = (p) => ["scanning", "reviewing", "refused", "escalated"].includes(p.status) && !p.final && !p.hold && !p.published && !p.withdrawn;
async function remove(req, res) {
  const me = await who(req);
  if (!me) return fail(res, 401, "Not signed in.");
  let gone = null;
  await modify(INDEX, (all) => {
    const p = (all || []).find((x) => x.id === String(req.body?.id));
    if (!p || p.sellerId !== me.id || !removable(p)) return undefined;
    gone = p;
    return all.filter((x) => x.id !== p.id);
  });
  if (!gone) return fail(res, 409, "This can't be removed. Items that have been on sale can only be withdrawn from sale.");
  try {   // tidy up the uploaded files
    const { del } = await import("@vercel/blob");
    await del([...variantsOf(gone).map((v) => BUNDLE(v.id)), ...(gone.extras || []).map((e) => e.path), ...(gone.proof?.files || []).map((f) => f.path), ...(gone.appeal?.files || []).map((f) => f.path)]);
  } catch { /* leftover files are harmless */ }
  res.status(200).json({ ok: true });
}

/** A merchant closes their own account. Their content comes off the Marketplace: anything that never went on sale is deleted, everything else is withdrawn from sale,
 *  so buyers keep their downloads (a paid order always downloads). Nothing about orders, sales, tax or refunds is deleted, and the Mollie connection stays so refunds still work.
 *  The account can no longer sign in, and the email address cannot sign up again without contacting support. */
async function closeAccount(req, res) {
  const me = await who(req);
  if (!me) return fail(res, 401, "Not signed in.");
  if (me.admin) return fail(res, 403, "The owner account can't be closed here.");
  if (String(req.body?.confirm ?? "").trim().toLowerCase() !== String(me.email).toLowerCase()) return fail(res, 400, "Type the email address of your Merchant Account to confirm.");
  const gone = [];
  await modify(INDEX, (all) => {
    const mine = (all || []).filter((x) => x.sellerId === me.id);
    if (!mine.length) return undefined;
    gone.push(...mine.filter(removable));
    return all.filter((x) => !gone.includes(x)).map((x) => (x.sellerId === me.id ? { ...x, withdrawn: true, closedWithAccount: true } : x));
  });
  try {   // tidy up the files of what was never on sale
    const { del } = await import("@vercel/blob");
    const paths = gone.flatMap((p) => [...variantsOf(p).map((v) => BUNDLE(v.id)), ...(p.extras || []).map((e) => e.path), ...(p.proof?.files || []).map((f) => f.path), ...(p.appeal?.files || []).map((f) => f.path)]);
    if (paths.length) await del(paths);
  } catch { /* leftover files are harmless */ }
  const permanent = Boolean(me.reopenedAt);   // closing an account that was reopened is for good
  await modify(SELLER(me.id), (x) => (x ? { ...x, closed: true, ...(permanent && { permanent: true }), closedAt: Date.now(), keyHash: undefined, linkHash: undefined, linkExp: undefined } : undefined));
  await sendMail({ to: me.email, idem: `mp-closed-${me.id}-${Date.now()}`, subject: "Your Merchant Account is closed",
    mail: buildEmail({ name: first(me.name), label: "Merchant account", reply: `Your Maestro Pro Merchant Account has been closed, as you asked.\n\n- Your content has been taken off the Marketplace.\n- People who already bought your items keep their downloads.\n- We keep the records of your orders, sales, tax and refunds, and your responsibilities for them continue.\n\n${permanent ? "Because this account had been reopened before, closing it is permanent: it can't be reopened, and this email address can't be used for a new Merchant Account." : `You can reopen the account from ${day(Date.now() + REOPEN_DAYS * 864e5)} by signing up again with this email address and paying a £${Number(REOPEN_FEE_GBP)} reactivation fee. Anything you had for sale will be off sale until it has been reviewed again. If you reopen it and close it again, that is permanent.`}\n\nIf you didn't close your account, email ${SUPPORT} straight away.` }) }).catch(() => {});
  res.status(200).json({ ok: true });
}

/** A closed account's email address asked to reopen it: a one-time link goes to that address, and using it signs them in and reopens the account. */
async function reactivate(req, res) {
  const em = String(req.body?.email ?? "").trim().toLowerCase();
  const m = EMAIL.test(em) && (await readJson(BY_EMAIL(em)).then((x) => x && readJson(SELLER(x.id))));
  if (!m?.closed) return fail(res, 404, "There is no closed Merchant Account for that email address.");
  if (m.permanent) return fail(res, 403, "This Merchant Account was closed permanently. It can't be reopened.");
  const on = (m.closedAt || 0) + REOPEN_DAYS * 864e5;
  if (Date.now() < on) return fail(res, 409, `This account can be reopened from ${day(on)}.`);
  if (m.signinAt > Date.now() - 600e3) return fail(res, 429, "We've just emailed you a link. Check your inbox, or try again in a few minutes.");
  const token = rand(24);
  await modify(SELLER(m.id), (x) => (x ? { ...x, linkHash: sha(token), linkExp: Date.now() + 900e3, signinAt: Date.now() } : undefined));
  await sendMail({ to: m.email, idem: `mp-reopen-${m.id}-${Date.now()}`, subject: "Reopen your Maestro Pro Merchant Account",
    mail: buildEmail({ name: first(m.name), label: "Merchant account", reply: "Here is the link to reopen your Merchant Account and sign in. Reopening costs a £15 technology fee, which you pay after signing in, and if you close the account again later that is permanent. The link works once and expires in 15 minutes. Anything you had for sale will be off sale until it has been reviewed again. If you didn't ask for this, you can ignore this email.", buttons: [["Reopen and sign in", `${LINKS.merchant}#t=${m.id}.${token}`]] }) });
  res.status(200).json({ ok: true });
}

/** Reopening: what was withdrawn when the account closed comes back, but anything that was on sale must pass review again before it can be sold. */
async function reopen(m) {
  await modify(INDEX, (all) => (all || []).some((x) => x.sellerId === m.id && x.closedWithAccount)
    ? all.map((x) => (x.sellerId === m.id && x.closedWithAccount
      ? { ...x, withdrawn: false, closedWithAccount: undefined, ...(x.status === "ready" && { published: x.published || { variants: variantsOf(x), extras: x.extras || [] }, status: "scanning", released: undefined, lock: 0, appeal: undefined, review: { rightsConfirmed: x.review?.rightsConfirmed || Date.now() } }) }
      : x))
    : undefined);
  await sendMail({ to: m.email, idem: `mp-reopened-${m.id}-${Date.now()}`, subject: "Your Merchant Account is open again",
    mail: buildEmail({ name: first(m.name), label: "Merchant account", reply: "Welcome back. Your reactivation fee is paid and your Merchant Account is open again, with your payout details as they were. If you close it again, that is permanent.\n\nEverything you had for sale is off sale and is being reviewed again, as it would be for a new item. It goes on sale when it is accepted.", buttons: [["Open your merchant account", LINKS.merchant]] }) }).catch(() => {});
}

// ---- Appeals (guideline 5.3): a refused item gets a statement and evidence files, which are scanned and assessed again. The third refusal goes to the owner.
const EVID = /^marketplace\/evidence\/([0-9a-f-]{36})\/[0-9a-f-]{36}-[\w.\- ()]{1,100}$/;
const DEV = /^marketplace\/dispute-evidence\/([0-9a-f-]{36})\/[0-9a-f-]{36}-[\w.\- ()]{1,100}$/;   // evidence a rights holder uploads with a dispute
const DR = /^marketplace\/dispute-response\/([0-9a-f-]{36})\/[0-9a-f-]{36}-[\w.\- ()]{1,100}$/;   // evidence a merchant uploads with a response
const AP = /^marketplace\/dispute-appeal\/([0-9a-f-]{36})\/[0-9a-f-]{36}-[\w.\- ()]{1,100}$/;   // evidence with an appeal
const EVID_EXT = new Set(["pdf", "png", "jpg", "jpeg", "txt"]);
const bad = (m) => Object.assign(new Error(m), { safe: true });   // an error whose message the merchant may read
const EXTRA = /^marketplace\/extras\/([0-9a-f-]{36})\/[0-9a-f-]{36}-[\w.\- ()]{1,100}$/;   // downloads that go with an item (printable PDFs and so on)
async function appeal(req, res) {
  const me = await who(req);
  if (!me) return fail(res, 401, "Not signed in.");
  const b = req.body || {}, text = clip(b.text, 2000);
  if (text.length < 20) return fail(res, 400, "Explain your case in a few sentences.");
  const files = [];
  for (const path of (Array.isArray(b.files) ? b.files : []).slice(0, 5).map(String)) {
    const m = EVID.exec(path);
    if (!m || m[1] !== b.id || !EVID_EXT.has(ext(path))) return fail(res, 400, "One of the evidence files isn't allowed.");
    const r = await get(path, { access: process.env.BLOB_ACCESS === "public" ? "public" : "private", useCache: false }).catch(() => null);
    if (!r || r.statusCode !== 200) return fail(res, 400, "An evidence file didn't upload properly. Try again.");
    r.stream.cancel().catch(() => {});
    files.push({ name: path.split("/").pop().slice(37), size: r.blob.size, path, scan: { status: "queued" } });
  }
  const p = await updateProduct(String(b.id), (x) => (x.sellerId === me.id && x.status === "refused" && !x.final && (x.refusals || 0) < MAX_REFUSALS
    ? { ...x, status: "scanning", lock: 0, appeal: { at: Date.now(), text, files }, review: { ...x.review, tries: 0, error: undefined } } : undefined));
  if (!p || p.status !== "scanning") return fail(res, 409, "This product can't be appealed.");
  res.status(200).json({ ok: true });
}
/** The owner's final decision on an escalated item (admin key only). */
async function escalation(req, res) {
  if (!isAdmin(String(req.headers["x-mp-key"] || ""))) return fail(res, 401, "No.");
  const b = req.body || {}, r = await ownerDecide(String(b.id), b.accept === true, clip(b.note, 600));
  if (!r.decided) return fail(res, 404, "There is nothing waiting for a decision on that item.");
  res.status(200).json({ ok: true, status: r.product.status });
}
/** An evidence file, for the owner to read (admin key only). */
async function evidenceFile(req, res) {
  const path = String(req.query.path || "");
  if (!EVID.test(path) && !DEV.test(path) && !DR.test(path) && !AP.test(path)) return fail(res, 401, "No.");
  if (!isAdmin(String(req.headers["x-mp-key"] || ""))) {
    const me = await who(req);
    if (!me || EVID.test(path) || !(await disputes()).some((d) => d.sellerId === me.id && [...(d.files || []), ...(d.response?.files || []), ...(d.appeal?.files || [])].some((f) => f.path === path))) return fail(res, 401, "No.");
  }
  const buf = await readBlob(path);
  if (!buf) return fail(res, 404, "Not found.");
  res.setHeader("Content-Type", { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain; charset=utf-8" }[ext(path)] || "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(200).send(buf);
}

// ---- Dispute Resolution Centre (guideline 8)
/** Anyone may file (a rights holder on the website, or the support bot from an email). Nothing is decided by filing: the item goes on hold and a person decides. */
async function disputeFile(req, res) {
  const b = req.body || {};
  if (b.website) return res.status(200).json({ ok: true });   // a field only a robot fills in
  let evidence = [];
  if (Array.isArray(b.files) && b.files.length) {
    const u = await uploaded(b.files, DEV, String(b.claim || ""), EVID_EXT, 5);
    if (u.error) return fail(res, 400, u.error);
    evidence = u.files;
  }
  const r = await fileDispute({ ...b, evidence });
  if (r.error) return fail(res, r.code || 400, r.error);
  res.status(200).json({ ok: true, id: r.id });
}
async function disputeRespond(req, res) {
  const me = await who(req);
  if (!me) return fail(res, 401, "Not signed in.");
  const text = clip(req.body?.text, 2000);
  if (text.length < 10) return fail(res, 400, "Write your response.");
  const id = String(req.body?.id);
  let files = [];
  if (Array.isArray(req.body?.files) && req.body.files.length) {
    const u = await uploaded(req.body.files, DR, id, EVID_EXT, 5);
    if (u.error) return fail(res, 400, u.error);
    files = u.files;
  }
  if (!(await respondDispute(me.id, id, text, files))) return fail(res, 404, "That dispute can't be answered.");
  res.status(200).json({ ok: true });
}
/** An appeal against a decision: by the merchant (signed in) or by the rights holder (the key in their email's link). Evidence is required. */
async function disputeAppeal(req, res) {
  const b = req.body || {}, k = b.k ? String(b.k) : "", id = String(b.id);
  const me = k ? null : await who(req);
  if (!k && (!me || me.admin)) return fail(res, 401, "Not signed in.");
  let files = [];
  if (Array.isArray(b.files) && b.files.length) {
    const u = await uploaded(b.files, AP, id, EVID_EXT, 5);
    if (u.error) return fail(res, 400, u.error);
    files = u.files;
  }
  const r = await fileAppeal({ id, sellerId: me?.id, key: k, text: b.text, files });
  if (r.error) return fail(res, r.code || 400, r.error);
  res.status(200).json({ ok: true });
}
/** What the rights holder's appeal page needs: whether the decision can still be appealed. The key in the link is the only proof needed. */
async function disputeAppealInfo(req, res) {
  const d = (await disputes()).find((x) => x.id === String(req.query.d || ""));
  const s = d ? appealState(d, { key: String(req.query.k || "") }) : { ok: false, why: "We couldn't find that dispute." };
  res.status(200).json({ ok: s.ok, why: s.why, days: APPEAL_DAYS, ...(s.side && { title: d.productTitle, ref: d.id.slice(0, 8).toUpperCase(), note: d.decision?.note }) });
}
async function disputeAppealDecide(req, res) {
  if (!isAdmin(String(req.headers["x-mp-key"] || ""))) return fail(res, 401, "No.");
  const b = req.body || {};
  if (!(await decideAppeal(String(b.id), b.overturn === true, clip(b.note, 600)))) return fail(res, 404, "Nothing waiting for a decision.");
  res.status(200).json({ ok: true });
}
/** The tax ledger: every sale with the tax collected, for the owner's returns (admin key only). */
async function taxReport(req, res) {
  if (!isAdmin(String(req.headers["x-mp-key"] || ""))) return fail(res, 401, "No.");
  res.status(200).json({ rows: await Promise.all(((await readJson(LEDGER)) || []).slice().reverse().map(inLocal)) });
}
/** Every dispute with everything the owner needs to decide it (owner only). */
async function disputeList(req, res) {
  if (!isAdmin(String(req.headers["x-mp-key"] || ""))) return fail(res, 401, "No.");
  const all = await disputes(), prods = await products(), strikes = {};
  for (const id of new Set(all.map((d) => d.sellerId))) strikes[id] = id === "platform" ? 0 : ((await readJson(SELLER(id)))?.strikes || []).length;
  res.status(200).json({ max: STRIKES, disputes: all.slice().reverse().map((d) => {
    const p = prods.find((x) => x.id === d.productId);
    return { id: d.id, created: d.created, status: d.status, title: d.productTitle, code: p && code(p), itemStatus: p ? (p.withdrawn ? "withdrawn" : p.hold ? "on hold" : p.status) : "deleted", seller: p?.sellerName || "", strikes: strikes[d.sellerId] ?? 0, claimant: d.claimant, via: d.via, work: d.work, details: d.details, files: d.files || [], respondBy: d.respondBy, response: d.response, decision: d.decision, appeal: d.appeal };
  }) });
}
async function disputeDecide(req, res) {
  if (!isAdmin(String(req.headers["x-mp-key"] || ""))) return fail(res, 401, "No.");
  const b = req.body || {};
  if (!(await decideDispute(String(b.id), b.uphold === true, clip(b.note, 600)))) return fail(res, 404, "Nothing waiting for a decision.");
  res.status(200).json({ ok: true });
}

// ---- Adding content (a merchant with their key, or the site owner with the admin key)
async function upload(req, res) {
  const me = await who(req).catch(() => null);
  const { handleUpload } = await import("@vercel/blob/client");   // loaded only here, so the other routes never depend on it
  const json = await handleUpload({
    body: req.body, request: req,
    onBeforeGenerateToken: async (pathname, payload) => {
      if (AP.test(pathname)) {   // the merchant (upheld) or the rights holder with their link's key (dismissed), once, within 14 days
        const pl = JSON.parse(payload || "{}"), user = pl.k ? null : me || (await who({ headers: { "x-mp-key": pl.key } }));
        const d = (await disputes()).find((x) => x.id === AP.exec(pathname)[1]);
        if (!d || user?.admin || !EVID_EXT.has(ext(pathname)) || !appealState(d, { sellerId: user?.id, key: String(pl.k || "") }).ok) throw bad("You can't attach files to an appeal for this decision. Use PDF, PNG, JPG or TXT files.");
        return { maximumSizeInBytes: 15e6, allowOverwrite: false, addRandomSuffix: false };
      }
      if (DR.test(pathname)) {   // only the merchant a dispute is against, while it is open
        const user = me || (await who({ headers: { "x-mp-key": JSON.parse(payload || "{}").key } }));
        const id = DR.exec(pathname)[1];
        if (!user || user.admin || !EVID_EXT.has(ext(pathname)) || !(await disputes()).some((d) => d.id === id && d.sellerId === user.id && (d.status === "open" || d.status === "responded"))) throw bad("You can't upload to this dispute. Use PDF, PNG, JPG or TXT files.");
        return { maximumSizeInBytes: 15e6, allowOverwrite: false, addRandomSuffix: false };
      }
      if (DEV.test(pathname)) {   // anyone may attach evidence to a claim: small PDF, PNG, JPG or TXT files only
        if (!EVID_EXT.has(ext(pathname))) throw bad("That file type isn't allowed. Use PDF, PNG, JPG or TXT.");
        return { maximumSizeInBytes: 15e6, allowOverwrite: false, addRandomSuffix: false };
      }
      const user = me || (await who({ headers: { "x-mp-key": JSON.parse(payload || "{}").key } }));
      if (!user || !ready(user)) throw bad("Not signed in.");
      const evid = EVID.test(pathname) && EVID_EXT.has(ext(pathname)), extra = EXTRA.test(pathname) && (ALLOWED.has(ext(pathname)) || COVER.has(ext(pathname)));
      if (!evid && !extra && !/^marketplace\/bundles\/[0-9a-f-]{36}\.maestropro$/.test(pathname)) throw bad(pathname.startsWith("marketplace/evidence/") ? "That file type isn't allowed. Use PDF, PNG, JPG or TXT." : "That file isn't allowed.");
      return { maximumSizeInBytes: evid ? 25e6 : extra ? 120e6 : 150e6, allowOverwrite: false, addRandomSuffix: false };
    },
  });
  res.status(200).json(json);
}

const bucket = () => (process.env.BLOB_ACCESS === "public" ? "public" : "private");
/** The files a merchant names must already be uploaded to this product's own folder. Returns { name, size, path } for each. */
async function uploaded(paths, pattern, id, exts, max) {
  const files = [];
  for (const path of (Array.isArray(paths) ? paths : []).slice(0, max).map(String)) {
    const m = pattern.exec(path);
    if (!m || m[1] !== id || !exts.has(ext(path))) return { error: "One of the files isn't allowed." };
    const r = await get(path, { access: bucket(), useCache: false }).catch(() => null);
    if (!r || r.statusCode !== 200) return { error: "A file didn't upload properly. Try again." };
    r.stream.cancel().catch(() => {});
    files.push({ name: path.split("/").pop().slice(37), size: r.blob.size, path });
  }
  return { files };
}
/** Checks everything a merchant sends for a new item or an edit. Returns { error } or { fields }. */
async function content(b) {
  const usd = price(b.priceUSD);
  if (!usd) return { error: "The price must be from $1.00 to $999.75 and end in .00, .25, .50 or .75. No other cent amount is allowed." };
  const regions = cleanRegions(b.regions);
  if (!regions) return { error: "Choose the countries from the list, or sell worldwide." };
  const rel = releaseOf(b.release);
  if (rel.error) return { error: rel.error };
  if (b.rights !== true) return { error: "Confirm that you own the rights to sell this content." };
  const title = clip(b.title, 100);
  if (title.length < 2) return { error: "Give the piece a title." };
  if (!/^[0-9a-f-]{36}$/.test(b.id || "")) return { error: "Bad item." };
  if (b.kind === "music") {   // a single, EP or album: audio files, no .maestropro bundles (guideline 3.5)
    const range = { single: [1, 3], ep: [1, 60], album: [1, 60] }[b.format];
    if (!range) return { error: "Choose single, EP or album." };
    const ts = (Array.isArray(b.tracks) ? b.tracks : []).slice(0, 60).map((t) => ({ path: String(t?.path || ""), title: clip(t?.title, 100) }));
    if (ts.length < range[0] || ts.length > range[1]) return { error: b.format === "single" ? "A single has 1 to 3 tracks." : "Add at least one track." };
    if (ts.some((t) => !t.title)) return { error: "Give every track a title." };
    const audio = await uploaded(ts.map((t) => t.path), EXTRA, b.id, new Set("mp3 m4a wav flac aac aif aiff".split(" ")), 60);
    const art = b.cover ? await uploaded([String(b.cover)], EXTRA, b.id, COVER, 1) : { files: [] };
    const proof = await uploaded(b.proof?.files, EVID, b.id, EVID_EXT, 5);
    if (audio.error || art.error || proof.error) return { error: audio.error || art.error || proof.error };
    const extras = [...audio.files.map((f, i) => ({ ...f, title: ts[i].title, n: i + 1 })), ...art.files.map((f) => ({ ...f, cover: true }))];
    return { fields: { genres: cleanGenres(b.genres), release: rel.release, kind: "music", format: b.format, title, composer: clip(b.composer, 100), description: clip(b.description, 600), priceUSD: usd, contents: `${TYPE[b.format]}, ${ts.length} track${ts.length > 1 ? "s" : ""}`, regions, variants: [], extras, proof: { text: clip(b.proof?.text, 1500), files: proof.files } } };
  }
  const variants = (Array.isArray(b.variants) ? b.variants : []).slice(0, 12).map((v) => ({ id: String(v?.id || ""), label: clip(v?.label, 40) }));
  if (!variants.length || variants.some((v) => !/^[0-9a-f-]{36}$/.test(v.id)) || new Set(variants.map((v) => v.id)).size !== variants.length) return { error: "Add at least one version." };
  if (variants.length > 1 && variants.some((v) => !v.label)) return { error: "Name each version, for example the key or the instrument." };
  for (const v of variants) if (!(await bundleOK(v.id))) return { error: "A version didn't upload properly. Try again." };
  const xs = (Array.isArray(b.extras) ? b.extras : []).slice(0, 10).map((e) => (typeof e === "string" ? { path: e } : { path: String(e?.path || ""), v: String(e?.v || "") }));
  const extras = await uploaded(xs.map((e) => e.path), EXTRA, b.id, ALLOWED, 10), proof = await uploaded(b.proof?.files, EVID, b.id, EVID_EXT, 5);
  if (extras.error || proof.error) return { error: extras.error || proof.error };
  extras.files = extras.files.map((f, i) => (variants.some((v) => v.id === xs[i].v) ? { ...f, v: xs[i].v } : f));   // each download belongs to one version
  return { fields: { title, composer: clip(b.composer, 100), description: clip(b.description, 600), priceUSD: usd, genres: cleanGenres(b.genres), release: rel.release, kind: undefined, format: undefined, contents: clip(b.contents, 200), regions, variants, extras: extras.files, proof: { text: clip(b.proof?.text, 1500), files: proof.files } } };
}

/** Testing only: the code in MARKETPLACE_DEBUG_CODE makes a submission skip scanning and review and be accepted. Off while the variable is unset. */
const debugOK = (b) => Boolean(process.env.MARKETPLACE_DEBUG_CODE) && typeof b?.debugCode === "string" && sha(b.debugCode) === sha(process.env.MARKETPLACE_DEBUG_CODE);
async function publish(req, res) {
  const me = await who(req);
  if (!me) return fail(res, 401, "Not signed in.");
  if (me.barred) return fail(res, 403, "Your Merchant Account has been closed.");
  if (!ready(me)) return fail(res, 403, me.fee?.status === "paid" ? "Set up your payout details before adding content." : "Pay the technology fee before adding content.");
  const b = req.body || {}, c = await content(b);
  if (c.error) return fail(res, 400, c.error);
  const all = await products();
  if (all.some((x) => x.id === b.id)) return fail(res, 409, "Already submitted.");
  if (all.filter((x) => x.sellerId === me.id && inReview(x)).length >= 10) return fail(res, 429, "You have 10 items waiting for review. Wait for some to finish first.");
  await addProduct({ id: b.id, ...c.fields, sellerId: me.id, sellerName: me.name, created: Date.now(), status: "scanning", ...(debugOK(b) && { debug: true }), review: { rightsConfirmed: Date.now() } });
  res.status(200).json({ id: b.id, status: "scanning" });
}

/** Editing sends the whole item back through review (guideline 5.5). Buyers keep the last accepted version meanwhile. */
async function edit(req, res) {
  const me = await who(req);
  if (!me) return fail(res, 401, "Not signed in.");
  if (me.barred) return fail(res, 403, "Your Merchant Account has been closed.");
  if (!ready(me)) return fail(res, 403, "Your Merchant Account isn't set up to add content.");
  const b = req.body || {}, c = await content(b);
  if (c.error) return fail(res, 400, c.error);
  let done = false;
  await updateProduct(String(b.id), (x) => {
    if (x.sellerId !== me.id || !["ready", "refused"].includes(x.status) || x.final) return undefined;
    done = true;
    return { ...x, ...c.fields, published: x.published || (x.status === "ready" ? { variants: variantsOf(x), extras: x.extras || [] } : undefined), status: "scanning", released: undefined, lock: 0, appeal: undefined, debug: debugOK(b) || undefined, review: { rightsConfirmed: Date.now() } };
  });
  if (!done) return fail(res, 409, "This product can't be edited right now.");
  res.status(200).json({ ok: true });
}

// The daily safety net: moves anything still in review on, and sends any outcome email that didn't go.
async function sweepRoute(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return fail(res, 401, "No.");
  await sweep();
  res.status(200).json({ ok: true });
}

// ---- Buyer accounts: an email address, proved with a code sent to it. The account lists everything bought with that address, for the website and the app.
const buyerId = (email) => sha(email).slice(0, 16);
async function buyerWho(req) {
  const [id, secret] = String(req.headers["x-mp-buyer"] || "").split(".");
  if (!/^[0-9a-f]{16}$/.test(id || "") || !secret) return null;
  const b = await readJson(BUYER(id));
  return b?.keys?.includes(sha(secret)) ? b : null;
}
async function buyerCode(req, res) {
  const em = String(req.body?.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(em)) return fail(res, 400, "Enter a valid email address.");
  let b = await readJson(BUYER(buyerId(em)));
  if (!b) {
    if (!req.body?.create) return fail(res, 404, "There is no buyer account for that email address.");
    b = { id: buyerId(em), email: em, created: Date.now(), keys: [] };
  }
  if (b.codeAt > Date.now() - 60e3) return fail(res, 429, "Wait a minute before asking for another code.");
  const code = String(crypto.randomInt(100000, 1000000));
  await writeRaw(BUYER(b.id), { ...b, codeHash: sha(code + em), codeExp: Date.now() + 600e3, tries: 0, codeAt: Date.now() });
  await sendMail({ to: em, idem: `mp-code-${b.id}-${Date.now()}`, subject: "Your Maestro Pro sign-in code",
    mail: buildEmail({ name: "there", label: "Buyer account", reply: `Your sign-in code is **${code}**.\n\nIt works for 10 minutes. If you didn't ask for it, you can ignore this email.` }) });
  res.status(200).json({ ok: true });
}
async function buyerVerify(req, res) {
  const em = String(req.body?.email ?? "").trim().toLowerCase(), code = String(req.body?.code ?? "").trim();
  const b = EMAIL.test(em) && (await readJson(BUYER(buyerId(em))));
  if (!b?.codeHash || b.codeExp < Date.now() || b.tries >= 5) return fail(res, 400, "That code has expired. Ask for a new one.");
  if (b.codeHash !== sha(code + em)) { await writeRaw(BUYER(b.id), { ...b, tries: (b.tries || 0) + 1 }); return fail(res, 400, "That code isn't right."); }
  const secret = rand(24);
  await writeRaw(BUYER(b.id), { ...b, keys: [...(b.keys || []), sha(secret)].slice(-10), codeHash: undefined, verifiedAt: Date.now() });   // other devices stay signed in
  res.status(200).json({ key: `${b.id}.${secret}`, email: em });
}

/** Every paid (or refunded) order an email has, newest first, with unpaid ones brought up to date. */
async function ordersOf(email) {
  const out = [];
  for (const e of ((await readJson(ORDERS_OF(email))) || []).slice(-50).reverse()) {
    let o = await readJson(ORDER(e.order));
    if (!o) continue;
    if (o.status !== "paid" && o.status !== "refunded" && Date.now() - o.created < 3 * 864e5) o = await sync(o).catch(() => o);
    if (o.status === "paid" || o.status === "refunded") out.push(o);
  }
  return out;
}
const refundedBefore = (all, o) => all.some((x) => x.id !== o.id && x.listing === o.listing && x.status === "refunded" && (x.refundedAt || 0) <= (o.paidAt || o.created));   // an earlier purchase of this item was refunded
async function buyerPurchases(req, res) {
  const b = await buyerWho(req);
  if (!b) return fail(res, 401, "Not signed in.");
  const all = await ordersOf(b.email), prods = await products();
  res.status(200).json({ email: b.email, purchases: all.map((o) => {
    const paidAt = o.paidAt || o.created;
    return { variants: packageOf(o, prods).variants.map((a) => ({ id: a.id, label: a.label || "" })), order: o.id, token: o.token, listing: o.listing, title: o.title, paidAt, status: o.status, refundable: refundable({ status: o.status, paidAt, refundedBefore: refundedBefore(all, o) }), refundBy: paidAt + REFUND_DAYS * 864e5 };
  }) });
}

/** The 14-day right to cancel (guideline 7). The refund and Mollie's refund fee are charged to the merchant's own Mollie account. */
async function refund(req, res) {
  const o = await owned({ query: { o: req.body?.o, t: req.body?.t } });
  if (!o) return fail(res, 404, "Order not found.");
  const before = refundedBefore(await ordersOf(o.email.toLowerCase()), o), paidAt = o.paidAt || o.created;
  if (!refundable({ status: o.status, paidAt, refundedBefore: before })) {
    return fail(res, 403, o.status === "refunded" ? "This purchase has already been refunded." : before ? "You were refunded for this item before, so the right to cancel no longer applies to this purchase (guideline 7.2)." : `The ${REFUND_DAYS} days to cancel this purchase have passed.`);
  }
  const pay = await payee(o.sellerId, o.created);
  const r = await mollie("POST", `/payments/${o.paymentId}/refunds`, pay.token, { amount: { currency: o.currency, value: o.amount }, description: `Refund: ${o.title}`, ...(pay.seller && { testmode: !live() }) });
  if (r.status >= 300) return fail(res, 502, r.data?.detail || "The refund couldn't be processed. Email support@maestro-pro.app.");
  await writeRaw(ORDER(o.id), { ...o, status: "refunded", refundedAt: Date.now(), refundId: r.data.id });
  await modify(SALES(o.sellerId || "platform"), (a) => (a || []).map((x) => (x.id === o.id ? { ...x, refunded: true } : x))).catch(() => {});
  await refundTax(o.id).catch(() => {});
  const m = o.sellerId === "platform" ? { email: OWNER, name: "Maestro Pro" } : await readJson(SELLER(o.sellerId));
  await sendMail({ to: o.email, idem: `mp-refund-${o.id}`, subject: `Refund for ${o.title}`,
    mail: buildEmail({ name: "there", label: "Marketplace", reply: `Your purchase of **${o.title}** has been refunded in full (${o.amount} ${o.currency}). The money goes back to the payment method you used and can take a few days to arrive.\n\nYour access to this item has ended.` }) });
  if (m?.email) await sendMail({ to: m.email, idem: `mp-refund-m-${o.id}`, subject: `A buyer cancelled: ${o.title}`,
    mail: buildEmail({ name: String(m.name).split(" ")[0], label: "Merchant account", reply: `A buyer has cancelled their purchase of **${o.title}** within ${REFUND_DAYS} days and been refunded ${o.amount} ${o.currency}.\n\nUnder [guideline 7.3](${LINKS.guidelines}#g7-3), the full refund, including Maestro Pro's 30% share of the sale, and the refund fee Mollie charges for it are taken from your Mollie account. Maestro Pro keeps its share of the sale.` }) });
  res.status(200).json({ ok: true });
}

const routes = { reactivate, "close-account": closeAccount, "apple-pay-session": applePaySession, "seller-code": sellerCode, "seller-verify": sellerVerify, "tax-report": taxReport, "dispute-appeal": disputeAppeal, "dispute-appeal-info": disputeAppealInfo, "dispute-appeal-decide": disputeAppealDecide, release, "dispute-list": disputeList, item, preview, remove, "signin-verify": signinVerify, "dispute-file": disputeFile, "dispute-respond": disputeRespond, "dispute-decide": disputeDecide, edit, appeal, escalation, "evidence-file": evidenceFile, "buyer-code": buyerCode, "buyer-verify": buyerVerify, "buyer-purchases": buyerPurchases, refund, list, guidelines: guidelinesInfo, buy, webhook, order, download, signup, "fee-webhook": feeWebhook, "fee-retry": feeRetry, "fee-pay": feePay, signin, "connect-start": connectStart, callback, merchant, withdraw, upload, publish, sweep: sweepRoute };
export default async function handler(req, res) {
  if (cors(req, res)) return;
  const fn = routes[req.query?.fn];
  if (!fn) return fail(res, 404, "Not found.");
  try { await fn(req, res); } catch (e) { console.error(req.query?.fn, e); if (!res.headersSent) fail(res, 500, e?.safe || e?.message?.startsWith("Seller") ? e.message : "Something went wrong. Please try again."); }
}
