// The Maestro Pro marketplace server (its own Vercel project, separate from the support desk). One function, picked by ?fn=; vercel.json rewrites /api/marketplace-<fn>.
//
// Merchants: sign up and pay the one-time £5 technology fee (Mollie), connect a Mollie account for payouts (Mollie Connect), then add content.
// Every product is reviewed before it can be sold (see _review.js): VirusTotal on each file, then the AI reviewer against the guidelines.
// Buyers pay in their own currency (Mollie). A merchant's sales are charged on their own Mollie account with a 30% application fee that Mollie moves to the platform.
// Nothing here deletes a bundle or an order: once someone has paid they can download again, whatever happens to the listing.
import { Readable } from "node:stream";
import { get } from "@vercel/blob";
import { readJson, writeRaw, modify, products, addProduct, updateProduct } from "./_blob.js";
import crypto from "node:crypto";
import { SITE, API, CUT, FEE_GBP, cors, rand, sha, isAdmin, sign, unsign, currencyFor, rate, minor, fmt, price, cleanRegions, availableIn, refundable, REFUND_DAYS, live, mollie, oauth, OWNER } from "./_mp.js";
import { BUNDLE } from "./_bundle.js";
import { step, sweep, GUIDELINE } from "./_review.js";
import { buildEmail, sendMail, LINKS } from "./_email.js";
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
const onSale = (p) => p.status === "ready" && !p.withdrawn;
const first = (name) => String(name || "").split(" ")[0] || "there";

async function who(req) {
  const key = String(req.headers["x-mp-key"] || "");
  if (isAdmin(key)) return { id: "platform", name: "Maestro Pro", admin: true };
  const [id, secret] = key.split(".");
  if (!/^[0-9a-f]{16}$/.test(id || "") || !secret) return null;
  const m = await readJson(SELLER(id));
  return m && m.keyHash === sha(secret) ? m : null;
}
/** A merchant may add content once the fee is paid and a Mollie account is connected. */
const ready = (m) => Boolean(m.admin || (m.fee?.status === "paid" && m.access));

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
const pub = (p) => ({ id: p.id, title: p.title, composer: p.composer, description: p.description, priceUSD: p.priceUSD, sellerName: p.sellerName, contents: p.contents, created: p.created, regions: p.regions || [] });
const country = (req) => req.headers["x-vercel-ip-country"];
async function list(req, res) {
  const cur = currencyFor(req.headers["x-vercel-ip-country"]);
  const r = await rate(cur);
  res.status(200).json({ listings: (await products()).filter((p) => onSale(p) && availableIn(p.regions, country(req))).reverse().map(pub), currency: r ? cur : "USD", rate: r || 1, cut: CUT });
}
const guidelinesInfo = (req, res) => res.status(200).json(guidelines);

// ---- Paying
async function sellerToken(s) {
  if (s.exp > Date.now() + 60e3) return s.access;
  const r = await oauth({ grant_type: "refresh_token", refresh_token: s.refresh });
  if (!r.data.access_token) throw new Error("Seller's Mollie connection has expired.");
  Object.assign(s, { access: r.data.access_token, exp: Date.now() + r.data.expires_in * 1e3, refresh: r.data.refresh_token || s.refresh });
  await writeRaw(SELLER(s.id), s);
  return s.access;
}
/** Who gets paid for an order: the platform itself, or a connected merchant. */
async function payee(sellerId) {
  if (sellerId === "platform") return { token: process.env.MOLLIE_API_KEY, extra: "" };
  const s = await readJson(SELLER(sellerId));
  if (!s?.access) throw new Error("Seller not found.");
  return { token: await sellerToken(s), seller: s, extra: live() ? "" : "?testmode=true" };
}

async function buy(req, res) {
  const { id, email, method } = req.body || {};
  const l = (await products()).find((x) => x.id === id);
  if (!l || !onSale(l)) return fail(res, 404, "That piece isn't for sale any more.");
  if (!availableIn(l.regions, country(req))) return fail(res, 403, "This piece isn't available in your country.");
  if (!EMAIL.test(String(email ?? "").trim())) return fail(res, 400, "Enter a valid email address.");
  const order = { id: rand(), token: rand(), listing: l.id, sellerId: l.sellerId, title: l.title, email: String(email).trim(), usd: l.priceUSD, status: "open", created: Date.now() };
  const pay = await payee(l.sellerId);
  let cur = currencyFor(req.headers["x-vercel-ip-country"]), r = await rate(cur);
  if (!r) { cur = "USD"; r = 1; }
  const create = (currency, rt, how) => {
    const m = minor(l.priceUSD, currency, rt);
    return mollie("POST", "/payments", pay.token, {
      amount: { currency, value: fmt(m, currency) },
      description: `${l.title} (Maestro Pro marketplace)`,
      redirectUrl: `${SITE}/marketplace/thanks/?o=${order.id}&t=${order.token}${req.body?.app ? "&app=1" : ""}`,
      webhookUrl: `${API}/api/marketplace-webhook?o=${order.id}`,
      metadata: { order: order.id, listing: l.id },
      ...(how && { method: how }),
      ...(pay.seller && { profileId: pay.seller.profileId, testmode: !live(), applicationFee: { amount: { currency, value: fmt(Math.max(1, Math.round(m * CUT)), currency) }, description: "Maestro Pro marketplace fee (30%)" } }),
    });
  };
  // Apple Pay first when asked; then any method; then dollars, for a currency this account can't take.
  const tries = [...(method === "applepay" ? [[cur, r, "applepay"]] : []), [cur, r], ...(cur !== "USD" ? [["USD", 1]] : [])];
  let p, used = cur;
  for (const [c, rt, how] of tries) { used = c; p = await create(c, rt, how); if (p.status !== 422) break; }
  const url = p.data?._links?.checkout?.href;
  if (!url) return fail(res, 502, p.data?.detail || "Couldn't start the payment.");
  order.paymentId = p.data.id; order.currency = used; order.amount = p.data.amount.value;
  await writeRaw(ORDER(order.id), order);
  await modify(ORDERS_OF(order.email.toLowerCase()), (a) => [...(a || []), { order: order.id, token: order.token, listing: l.id, title: l.title, t: order.created }]).catch(() => {});
  res.status(200).json({ url, order: order.id, token: order.token });
}

const link = (o) => `${API}/api/marketplace-download?o=${o.id}&t=${o.token}`;
/** Asks Mollie where the payment stands, and the first time it is paid: records the sale and emails the download link. */
async function sync(order) {
  if (order.status === "paid" || order.status === "refunded") return order;
  const pay = await payee(order.sellerId || (await products()).find((x) => x.id === order.listing)?.sellerId);
  const p = await mollie("GET", `/payments/${order.paymentId}${pay.extra}`, pay.token);
  const s = p.data?.status;
  if (!s || s === order.status) return order;
  order.status = s;
  if (s === "paid") order.paidAt = Date.now();
  await writeRaw(ORDER(order.id), order);
  if (s === "paid") {
    const sale = { id: order.id, t: Date.now(), listing: order.listing, title: order.title, usd: order.usd, currency: order.currency, amount: order.amount };
    await modify(SALES(order.sellerId || "platform"), (a) => ((a || []).some((x) => x.id === sale.id) ? undefined : [...(a || []), sale])).catch(() => {});
    await sendMail({ to: order.email, idem: `mp-${order.id}`, subject: `Your download: ${order.title}`,
      mail: buildEmail({ name: "there", label: "Marketplace", reply: `Thank you for your purchase.\n\nYour download of **${order.title}** is ready. Download it, then open the file in Maestro Pro. It is yours to keep, and you can use this link to download it again at any time.`, buttons: [["Download", link(order)]] }) });
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
async function order(req, res) {
  let o = await owned(req);
  if (!o) return fail(res, 404, "Order not found.");
  o = await sync(o);
  res.status(200).json({ status: o.status, title: o.title, ...(o.status === "paid" && { download: link(o) }) });
}
/** Whatever happens to the listing afterwards (withdrawn, even refused on a later review), a paid order always downloads. */
async function download(req, res) {
  let o = await owned(req);
  if (!o) return fail(res, 404, "Order not found.");
  o = await sync(o);
  if (o.status !== "paid") return fail(res, 402, "This order hasn't been paid.");
  const r = await get(BUNDLE(o.listing), { access: process.env.BLOB_ACCESS === "public" ? "public" : "private", useCache: false });
  if (!r || r.statusCode !== 200) return fail(res, 404, "The file is missing. Email support@maestro-pro.app.");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${o.title.replace(/[^\w .()-]/g, "").trim() || "score"}.maestropro"`);
  if (r.blob.size) res.setHeader("Content-Length", r.blob.size);
  Readable.fromWeb(r.stream).pipe(res);   // streamed: bundles with audio are bigger than a normal response may be
}

// ---- Merchant accounts
/** Starts the £5 technology fee on the platform's Mollie account. */
async function startFee(m) {
  const p = await mollie("POST", "/payments", process.env.MOLLIE_API_KEY, {
    amount: { currency: "GBP", value: FEE_GBP }, description: "Maestro Pro Marketplace technology fee (one-time)",
    redirectUrl: `${SITE}/marketplace/onboard/?m=${m.id}`, webhookUrl: `${API}/api/marketplace-fee-webhook?m=${m.id}`, metadata: { merchant: m.id, kind: "fee" },
  });
  const url = p.data?._links?.checkout?.href;
  if (!url) throw new Error(p.data?.detail || "Couldn't start the payment.");
  return { url, fee: { paymentId: p.data.id, status: "open", created: Date.now() } };
}

async function signup(req, res) {
  const { name, email, agree } = req.body || {};
  const em = String(email ?? "").trim().toLowerCase();
  if (clip(name, 80).length < 2) return fail(res, 400, "Enter your name or your business's name.");
  if (!EMAIL.test(em)) return fail(res, 400, "Enter a valid email address.");
  if (!agree) return fail(res, 400, "Please agree to the Merchant Content Review Guidelines.");
  const old = await readJson(BY_EMAIL(em)).then((x) => x && readJson(SELLER(x.id)));
  if (old?.fee?.status === "paid") return fail(res, 409, "There is already a Merchant Account for that email address. Ask for a sign-in link instead.");
  const secret = rand(24), m = { ...old, id: old?.id || rand(8), name: clip(name, 80), email: em, keyHash: sha(secret), created: old?.created || Date.now(), agreedAt: Date.now() };
  const f = await startFee(m).catch((e) => ({ error: e.message }));
  if (f.error) return fail(res, 502, f.error);
  m.fee = f.fee;
  await writeRaw(SELLER(m.id), m);
  await writeRaw(BY_EMAIL(em), { id: m.id });
  res.status(200).json({ url: f.url, key: `${m.id}.${secret}` });
}

/** The merchant's fee payment, brought up to date. The first time it is paid, the welcome email goes out. */
async function syncFee(m) {
  if (!m.fee || m.fee.status === "paid") return m;
  const p = await mollie("GET", `/payments/${m.fee.paymentId}`, process.env.MOLLIE_API_KEY);
  const s = p.data?.status;
  if (!s || s === m.fee.status) return m;
  m = { ...(await readJson(SELLER(m.id))), fee: { ...m.fee, status: s, ...(s === "paid" && { paidAt: Date.now() }) } };
  await writeRaw(SELLER(m.id), m);
  if (s === "paid") await sendMail({ to: m.email, idem: `mp-fee-${m.id}`, subject: "Your Merchant Account is open",
    mail: buildEmail({ name: first(m.name), label: "Merchant account", reply: `Thank you. Your technology fee has been paid and your Maestro Pro Merchant Account is open.\n\nThe next step is to set up your payout details with Mollie, so that your share of every sale is paid to you. After that you can add content. Every item is checked before it goes on sale, so please read the [Merchant Content Review Guidelines](guidelines) first.`, buttons: [["Open your merchant account", LINKS.merchant]] }) });
  return m;
}
async function feeWebhook(req, res) {
  const m = /^[0-9a-f]{16}$/.test(req.query.m || "") && (await readJson(SELLER(req.query.m)));
  if (m) await syncFee(m).catch(() => {});
  res.status(200).end();
}
async function feeRetry(req, res) {
  const me = await who(req);
  if (!me || me.admin) return fail(res, 401, "Not signed in.");
  if (me.fee?.status === "paid") return fail(res, 409, "The technology fee is already paid.");
  const f = await startFee(me);
  await writeRaw(SELLER(me.id), { ...me, fee: f.fee });
  res.status(200).json({ url: f.url });
}

/** Emails a fresh sign-in link. The old link stops working, so a link can be asked for at most every ten minutes. Always answers the same, so it can't be used to find out who has an account. */
async function signin(req, res) {
  const em = String(req.body?.email ?? "").trim().toLowerCase();
  const m = EMAIL.test(em) && (await readJson(BY_EMAIL(em)).then((x) => x && readJson(SELLER(x.id))));
  if (m && !(m.signinAt > Date.now() - 600e3)) {
    const secret = rand(24);
    await writeRaw(SELLER(m.id), { ...m, keyHash: sha(secret), signinAt: Date.now() });
    await sendMail({ to: m.email, idem: `mp-signin-${m.id}-${Date.now()}`, subject: "Your Maestro Pro merchant sign-in link",
      mail: buildEmail({ name: first(m.name), label: "Merchant account", reply: "Here is your sign-in link. Keep it private: anyone with it can manage your products. Asking for a new link signs out the old one.", buttons: [["Sign in", `${LINKS.merchant}#k=${m.id}.${secret}`]] }) });
  }
  res.status(200).json({ ok: true });
}

// Register this redirect URL on the Mollie app: https://maestro-marketplace-api.vercel.app/api/marketplace-callback
async function connectStart(req, res) {
  const me = await who(req);
  if (!me || me.admin) return fail(res, 401, "Not signed in.");
  const m = await syncFee(me);
  if (m.fee?.status !== "paid") return fail(res, 402, "Pay the technology fee first.");
  if (!process.env.MOLLIE_CLIENT_ID || !process.env.MARKETPLACE_SECRET) return fail(res, 503, "Payout set-up isn't switched on yet.");
  const q = new URLSearchParams({
    client_id: process.env.MOLLIE_CLIENT_ID, redirect_uri: `${API}/api/marketplace-callback`, response_type: "code", approval_prompt: "auto",
    scope: "payments.read payments.write refunds.read refunds.write profiles.read organizations.read onboarding.read", state: sign({ m: m.id, ts: Date.now() }),
  });
  res.status(200).json({ url: `${AUTHORIZE}?${q}` });
}
async function callback(req, res) {
  const st = unsign(req.query.state);
  const back = (msg) => res.redirect(302, `${SITE}/marketplace/onboard/?error=${encodeURIComponent(msg)}`);
  const m = st && Date.now() - st.ts < 3600e3 && (await readJson(SELLER(st.m)));
  if (!m || m.fee?.status !== "paid") return back("That link expired. Please start the payout set-up again.");
  if (req.query.error) return back("You didn't finish setting up your payouts. Nothing has changed, and you can carry on whenever you're ready.");   // they backed out at Mollie
  if (!req.query.code) return back("Mollie didn't connect. Please try again.");
  const t = await oauth({ grant_type: "authorization_code", code: req.query.code, redirect_uri: `${API}/api/marketplace-callback` });
  if (!t.data.access_token) return back("Mollie refused the connection. Please try again.");
  const [org, profile] = await Promise.all([mollie("GET", "/organizations/me", t.data.access_token), mollie("GET", "/profiles/me", t.data.access_token)]);
  if (!org.data.id || !profile.data.id) return back("Couldn't read your Mollie account. Finish setting it up in Mollie, then try again.");
  await writeRaw(SELLER(m.id), { ...m, mollieOrg: org.data.id, profileId: profile.data.id, access: t.data.access_token, refresh: t.data.refresh_token, exp: Date.now() + t.data.expires_in * 1e3, connectedAt: Date.now() });
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
  const gross = sales.reduce((n, s) => n + s.usd, 0), share = me.admin ? 1 : 1 - CUT, charged = (list) => (me.admin ? 0 : list.reduce((n, s) => n + s.usd * CUT, 0));   // the marketplace share of a refunded sale is charged back
  res.status(200).json({
    id: me.id, name: me.name, email: me.email, admin: Boolean(me.admin),
    fee: me.admin ? "paid" : me.fee?.status || "none", feeGBP: FEE_GBP, connected: Boolean(me.admin || me.access), canPublish: ready(me),
    products: mine.slice().reverse().map((p) => ({
      id: p.id, title: p.title, composer: p.composer, priceUSD: p.priceUSD, regions: p.regions || [], status: p.status, withdrawn: Boolean(p.withdrawn), created: p.created,
      files: p.review?.files ? { done: p.review.files.filter((f) => f.scan.status === "clean").length, total: p.review.files.length } : undefined,
      reason: p.status === "refused" ? p.review?.reason : undefined,
      guidelines: p.status === "refused" ? (p.review?.ids || []).map((i) => ({ id: i, title: GUIDELINE[i]?.title, text: GUIDELINE[i]?.text })) : undefined,
      sold: per(p.id).length, earnedUSD: Math.round((per(p.id).reduce((n, s) => n + s.usd, 0) * share - charged(back(p.id))) * 100) / 100,
    })),
    sales: { count: sales.length, refunded: every.length - sales.length, grossUSD: Math.round(gross * 100) / 100, earnedUSD: Math.round((gross * share - charged(back())) * 100) / 100, recent: sales.slice(-15).reverse().map((s) => ({ t: s.t, title: s.title, usd: s.usd })) },
    cut: CUT,
  });
}

async function withdraw(req, res) {
  const me = await who(req);
  if (!me) return fail(res, 401, "Not signed in.");
  const { id, withdrawn } = req.body || {};
  const p = await updateProduct(String(id), (x) => (x.sellerId === me.id && x.status === "ready" ? { ...x, withdrawn: Boolean(withdrawn) } : undefined));
  if (!p || p.sellerId !== me.id) return fail(res, 404, "Product not found.");
  res.status(200).json({ ok: true, withdrawn: Boolean(p.withdrawn) });   // only stops new sales: buyers keep their downloads
}

// ---- Adding content (a merchant with their key, or the site owner with the admin key)
async function upload(req, res) {
  const me = await who(req).catch(() => null);
  const { handleUpload } = await import("@vercel/blob/client");   // loaded only here, so the other routes never depend on it
  const json = await handleUpload({
    body: req.body, request: req,
    onBeforeGenerateToken: async (pathname, payload) => {
      const user = me || (await who({ headers: { "x-mp-key": JSON.parse(payload || "{}").key } }));
      if (!user || !ready(user)) throw new Error("Not signed in.");
      if (!/^marketplace\/bundles\/[0-9a-f-]{36}\.maestropro$/.test(pathname)) throw new Error("Bad file name.");
      return { maximumSizeInBytes: 150e6, allowOverwrite: false, addRandomSuffix: false };
    },
  });
  res.status(200).json(json);
}

async function publish(req, res) {
  const me = await who(req);
  if (!me) return fail(res, 401, "Not signed in.");
  if (!ready(me)) return fail(res, 403, me.fee?.status === "paid" ? "Set up your payout details with Mollie before adding content." : "Pay the technology fee before adding content.");
  const b = req.body || {};
  const usd = price(b.priceUSD);
  if (!usd) return fail(res, 400, "The price must be from $0.25 to $999.75 and end in .00, .25, .50 or .75. No other cent amount is allowed.");
  const regions = cleanRegions(b.regions);
  if (!regions) return fail(res, 400, "Choose the countries from the list, or sell worldwide.");
  if (b.rights !== true) return fail(res, 400, "Confirm that you own the rights to sell this content.");
  const title = clip(b.title, 100);
  if (title.length < 2) return fail(res, 400, "Give the piece a title.");
  if (!/^[0-9a-f-]{36}$/.test(b.id || "") || !(await bundleOK(b.id))) return fail(res, 400, "The bundle didn't upload properly. Try again.");
  const all = await products();
  if (all.some((x) => x.id === b.id)) return fail(res, 409, "Already submitted.");
  if (all.filter((x) => x.sellerId === me.id && inReview(x)).length >= 10) return fail(res, 429, "You have 10 items waiting for review. Wait for some to finish first.");
  await addProduct({ id: b.id, title, composer: clip(b.composer, 100), description: clip(b.description, 600), priceUSD: usd, sellerId: me.id, sellerName: me.name, contents: clip(b.contents, 200), regions, created: Date.now(), status: "scanning", review: { rightsConfirmed: Date.now() } });
  res.status(200).json({ id: b.id, status: "scanning" });
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
  const all = await ordersOf(b.email);
  res.status(200).json({ email: b.email, purchases: all.map((o) => {
    const paidAt = o.paidAt || o.created;
    return { order: o.id, token: o.token, listing: o.listing, title: o.title, paidAt, status: o.status, refundable: refundable({ status: o.status, paidAt, refundedBefore: refundedBefore(all, o) }), refundBy: paidAt + REFUND_DAYS * 864e5 };
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
  const pay = await payee(o.sellerId);
  const r = await mollie("POST", `/payments/${o.paymentId}/refunds`, pay.token, { amount: { currency: o.currency, value: o.amount }, description: `Refund: ${o.title}`, ...(pay.seller && { testmode: !live() }) });
  if (r.status >= 300) return fail(res, 502, r.data?.detail || "The refund couldn't be processed. Email support@maestro-pro.app.");
  await writeRaw(ORDER(o.id), { ...o, status: "refunded", refundedAt: Date.now(), refundId: r.data.id });
  await modify(SALES(o.sellerId || "platform"), (a) => (a || []).map((x) => (x.id === o.id ? { ...x, refunded: true } : x))).catch(() => {});
  const m = o.sellerId === "platform" ? { email: OWNER, name: "Maestro Pro" } : await readJson(SELLER(o.sellerId));
  await sendMail({ to: o.email, idem: `mp-refund-${o.id}`, subject: `Refund for ${o.title}`,
    mail: buildEmail({ name: "there", label: "Marketplace", reply: `Your purchase of **${o.title}** has been refunded in full (${o.amount} ${o.currency}). The money goes back to the payment method you used and can take a few days to arrive.\n\nYour access to this item has ended.` }) });
  if (m?.email) await sendMail({ to: m.email, idem: `mp-refund-m-${o.id}`, subject: `A buyer cancelled: ${o.title}`,
    mail: buildEmail({ name: String(m.name).split(" ")[0], label: "Merchant account", reply: `A buyer has cancelled their purchase of **${o.title}** within ${REFUND_DAYS} days and been refunded ${o.amount} ${o.currency}.\n\nUnder [guideline 7.3](${LINKS.guidelines}#g7-3), the full refund, including Maestro Pro's 30% share of the sale, and the refund fee Mollie charges for it are taken from your Mollie account. Maestro Pro keeps its share of the sale.` }) });
  res.status(200).json({ ok: true });
}

const routes = { "buyer-code": buyerCode, "buyer-verify": buyerVerify, "buyer-purchases": buyerPurchases, refund, list, guidelines: guidelinesInfo, buy, webhook, order, download, signup, "fee-webhook": feeWebhook, "fee-retry": feeRetry, signin, "connect-start": connectStart, callback, merchant, withdraw, upload, publish, sweep: sweepRoute };
export default async function handler(req, res) {
  if (cors(req, res)) return;
  const fn = routes[req.query?.fn];
  if (!fn) return fail(res, 404, "Not found.");
  try { await fn(req, res); } catch (e) { if (!res.headersSent) fail(res, 500, e?.message?.startsWith("Seller") ? e.message : "Something went wrong. Please try again."); }
}
