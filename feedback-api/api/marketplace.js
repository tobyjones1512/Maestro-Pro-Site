// The Maestro Pro marketplace: one function (Vercel's free plan allows only 12), picked by ?fn=. vercel.json rewrites /api/marketplace-<fn>.
// Listings live in one index file in the Blob store, each bundle (a .maestropro file) is a private blob, orders and sellers are small JSON files.
// Payments are Mollie: listings added by the site owner are paid to the platform account; sellers' sales are charged on their own Mollie
// account (Mollie Connect) with a 30% application fee that Mollie moves to the platform.
import { Readable } from "node:stream";
import { get } from "@vercel/blob";
import { readVersioned, writeVersioned, writeRaw } from "./_threads.js";
import { SITE, API, CUT, cors, rand, sha, isAdmin, sign, unsign, currencyFor, rate, minor, fmt, wholePrice, live, mollie, oauth } from "./_mp.js";

const INDEX = "marketplace/index.json";
const ORDER = (id) => `marketplace/orders/${id}.json`;
const SELLER = (id) => `marketplace/sellers/${id}.json`;
const BUNDLE = (id) => `marketplace/bundles/${id}.maestropro`;
const MAGIC = "PLAYALONG1";
const AUTHORIZE = "https://my.mollie.com/oauth2/authorize";

const readJson = async (p) => (await readVersioned(p)).data;
const listings = async () => (await readJson(INDEX)) || [];
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const fail = (res, code, error) => res.status(code).json({ error });

async function who(req) {
  const key = String(req.headers["x-mp-key"] || "");
  if (isAdmin(key)) return { id: "platform", name: "Maestro Pro", admin: true };
  const [id, secret] = key.split(".");
  const seller = id && secret && (await readJson(SELLER(id)));
  return seller && seller.keyHash === sha(secret) ? seller : null;
}

async function addListing(l) {
  for (let i = 0; i < 5; i++) {
    const { data, etag } = await readVersioned(INDEX);
    if (await writeVersioned(INDEX, [...(data || []), l], etag)) return;
  }
  throw new Error("busy");
}

/** The bundle must be there and really be a .maestropro file, not whatever a seller chose to upload. */
async function bundleOK(id) {
  const r = await get(BUNDLE(id), { access: "private", useCache: false }).catch(() => null);
  if (!r || r.statusCode !== 200) return false;
  const reader = r.stream.getReader();
  const { value } = await reader.read();
  reader.cancel().catch(() => {});
  return Boolean(value) && Buffer.from(value.slice(0, MAGIC.length)).toString() === MAGIC;
}

// ---- Public
async function list(req, res) {
  const cur = currencyFor(req.headers["x-vercel-ip-country"]);
  const r = await rate(cur);
  res.status(200).json({ listings: (await listings()).slice().reverse(), currency: r ? cur : "USD", rate: r || 1, cut: CUT });
}

async function sellerToken(s) {
  if (s.exp > Date.now() + 60e3) return s.access;
  const r = await oauth({ grant_type: "refresh_token", refresh_token: s.refresh });
  if (!r.data.access_token) throw new Error("Seller's Mollie connection has expired.");
  Object.assign(s, { access: r.data.access_token, exp: Date.now() + r.data.expires_in * 1e3, refresh: r.data.refresh_token || s.refresh });
  await writeRaw(SELLER(s.id), s);
  return s.access;
}
/** Who gets paid for an order: the platform itself, or a connected seller. */
async function payee(listing) {
  if (listing.sellerId === "platform") return { token: process.env.MOLLIE_API_KEY, extra: "" };
  const s = await readJson(SELLER(listing.sellerId));
  if (!s) throw new Error("Seller not found.");
  return { token: await sellerToken(s), seller: s, extra: live() ? "" : "?testmode=true" };
}

async function buy(req, res) {
  const { id, email } = req.body || {};
  const l = (await listings()).find((x) => x.id === id);
  if (!l) return fail(res, 404, "That piece isn't for sale any more.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email ?? "").trim())) return fail(res, 400, "Enter a valid email address.");
  const order = { id: rand(), token: rand(), listing: l.id, title: l.title, email: String(email).trim(), usd: l.priceUSD, status: "open", created: Date.now() };
  const pay = await payee(l);
  let cur = currencyFor(req.headers["x-vercel-ip-country"]), r = await rate(cur);
  if (!r) { cur = "USD"; r = 1; }
  const create = (currency, rt) => {
    const m = minor(l.priceUSD, currency, rt);
    return mollie("POST", "/payments", pay.token, {
      amount: { currency, value: fmt(m, currency) },
      description: `${l.title} (Maestro Pro marketplace)`,
      redirectUrl: `${SITE}/marketplace/thanks/?o=${order.id}&t=${order.token}`,
      webhookUrl: `${API}/api/marketplace-webhook?o=${order.id}`,
      metadata: { order: order.id, listing: l.id },
      ...(pay.seller && { profileId: pay.seller.profileId, testmode: !live(), applicationFee: { amount: { currency, value: fmt(Math.max(1, Math.round(m * CUT)), currency) }, description: "Maestro Pro marketplace fee (30%)" } }),
    });
  };
  let p = await create(cur, r);
  if (p.status === 422 && cur !== "USD") { cur = "USD"; p = await create("USD", 1); }   // a currency this account can't take: charge dollars
  const url = p.data?._links?.checkout?.href;
  if (!url) return fail(res, 502, p.data?.detail || "Couldn't start the payment.");
  order.paymentId = p.data.id; order.currency = cur; order.amount = p.data.amount.value;
  await writeRaw(ORDER(order.id), order);
  res.status(200).json({ url });
}

/** Asks Mollie where the payment stands, and emails the download link the first time it is paid. */
async function sync(order) {
  if (order.status === "paid") return order;
  const l = (await listings()).find((x) => x.id === order.listing);
  const pay = await payee(l);
  const p = await mollie("GET", `/payments/${order.paymentId}${pay.extra}`, pay.token);
  const s = p.data?.status;
  if (!s || s === order.status) return order;
  order.status = s;
  await writeRaw(ORDER(order.id), order);
  if (s === "paid" && process.env.RESEND_API_KEY) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `mp-${order.id}` },
      body: JSON.stringify({
        from: process.env.KEY_FROM || "Maestro Pro <noreply@maestro-pro.app>", to: order.email, subject: `Your download: ${order.title}`,
        text: `Thank you for your purchase.\n\nDownload "${order.title}" here, then open the file in Maestro Pro:\n${link(order)}\n\nThis inbox is not monitored. If you need help, email support@maestro-pro.app.`,
      }),
    }).catch(() => {});
  }
  return order;
}
const link = (o) => `${API}/api/marketplace-download?o=${o.id}&t=${o.token}`;

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

async function download(req, res) {
  let o = await owned(req);
  if (!o) return fail(res, 404, "Order not found.");
  o = await sync(o);
  if (o.status !== "paid") return fail(res, 402, "This order hasn't been paid.");
  const r = await get(BUNDLE(o.listing), { access: "private", useCache: false });
  if (!r || r.statusCode !== 200) return fail(res, 404, "The file is missing. Email support@maestro-pro.app.");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${o.title.replace(/[^\w .()-]/g, "").trim() || "score"}.maestropro"`);
  if (r.blob.size) res.setHeader("Content-Length", r.blob.size);
  Readable.fromWeb(r.stream).pipe(res);   // streamed: bundles with audio are bigger than a normal response may be
}

// ---- Selling (the site owner with the admin key, or a connected seller with their seller key)
async function upload(req, res) {
  const me = await who(req).catch(() => null);
  const { handleUpload } = await import("@vercel/blob/client");   // loaded only here, so the other routes never depend on it
  const json = await handleUpload({
    body: req.body, request: req,
    onBeforeGenerateToken: async (pathname, payload) => {
      const user = me || (await who({ headers: { "x-mp-key": JSON.parse(payload || "{}").key } }));
      if (!user) throw new Error("Not signed in.");
      if (!/^marketplace\/bundles\/[0-9a-f-]{36}\.maestropro$/.test(pathname)) throw new Error("Bad file name.");
      return { maximumSizeInBytes: 150e6, allowOverwrite: false, addRandomSuffix: false };
    },
  });
  res.status(200).json(json);
}

async function publish(req, res) {
  const me = await who(req);
  if (!me) return fail(res, 401, "Not signed in.");
  const b = req.body || {};
  const price = wholePrice(b.priceUSD);
  if (!price) return fail(res, 400, "The price must be a whole number of US dollars, from 1 to 999. Cents are not allowed.");
  const title = clip(b.title, 100);
  if (title.length < 2) return fail(res, 400, "Give the piece a title.");
  if (!/^[0-9a-f-]{36}$/.test(b.id || "") || !(await bundleOK(b.id))) return fail(res, 400, "The bundle didn't upload properly. Try again.");
  if ((await listings()).some((x) => x.id === b.id)) return fail(res, 409, "Already published.");
  const l = { id: b.id, title, composer: clip(b.composer, 100), description: clip(b.description, 600), priceUSD: price, sellerId: me.id, sellerName: me.name, contents: clip(b.contents, 200), created: Date.now() };
  await addListing(l);
  res.status(200).json({ listing: l });
}

async function seller(req, res) {
  const me = await who(req);
  if (!me) return fail(res, 401, "Not signed in.");
  res.status(200).json({ id: me.id, name: me.name, admin: Boolean(me.admin), listings: (await listings()).filter((l) => l.sellerId === me.id) });
}

// ---- Onboarding: Mollie Connect (OAuth). Register this redirect URL on the Mollie app: https://fider-feedback-api.vercel.app/api/marketplace-callback
async function onboardStart(req, res) {
  const { name, email, agree } = req.body || {};
  if (clip(name, 80).length < 2) return fail(res, 400, "Enter your name or your business's name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email ?? "").trim())) return fail(res, 400, "Enter a valid email address.");
  if (!agree) return fail(res, 400, "Please agree to the seller terms.");
  if (!process.env.MOLLIE_CLIENT_ID || !process.env.MARKETPLACE_SECRET) return fail(res, 503, "Seller sign-up isn't switched on yet.");
  const q = new URLSearchParams({
    client_id: process.env.MOLLIE_CLIENT_ID, redirect_uri: `${API}/api/marketplace-callback`, response_type: "code", approval_prompt: "auto",
    scope: "payments.read payments.write profiles.read organizations.read onboarding.read",
    state: sign({ name: clip(name, 80), email: String(email).trim(), ts: Date.now() }),
  });
  res.status(200).json({ url: `${AUTHORIZE}?${q}` });
}

async function callback(req, res) {
  const st = unsign(req.query.state);
  const back = (msg) => res.redirect(302, `${SITE}/marketplace/onboard/?error=${encodeURIComponent(msg)}`);
  if (!st || Date.now() - st.ts > 3600e3) return back("That sign-up link expired. Please start again.");
  if (!req.query.code) return back("Mollie didn't connect. Please try again.");
  const t = await oauth({ grant_type: "authorization_code", code: req.query.code, redirect_uri: `${API}/api/marketplace-callback` });
  if (!t.data.access_token) return back("Mollie refused the connection. Please try again.");
  const [org, profile] = await Promise.all([mollie("GET", "/organizations/me", t.data.access_token), mollie("GET", "/profiles/me", t.data.access_token)]);
  if (!org.data.id || !profile.data.id) return back("Couldn't read your Mollie account. Finish setting it up in Mollie, then try again.");
  const secret = rand(24), old = await readJson(SELLER(org.data.id));
  await writeRaw(SELLER(org.data.id), {
    ...old, id: org.data.id, name: st.name, email: st.email, profileId: profile.data.id, access: t.data.access_token, refresh: t.data.refresh_token,
    exp: Date.now() + t.data.expires_in * 1e3, keyHash: sha(secret), created: old?.created || Date.now(),
  });
  res.redirect(302, `${SITE}/marketplace/seller/#k=${encodeURIComponent(`${org.data.id}.${secret}`)}`);   // in the fragment: never sent to a server or logged
}

const routes = { list, buy, webhook, order, download, upload, publish, seller, "onboard-start": onboardStart, callback };
export default async function handler(req, res) {
  if (cors(req, res)) return;
  const fn = routes[req.query?.fn];
  if (!fn) return fail(res, 404, "Not found.");
  try { await fn(req, res); } catch (e) { if (!res.headersSent) fail(res, 500, e?.message?.startsWith("Seller") ? e.message : "Something went wrong. Please try again."); }
}
