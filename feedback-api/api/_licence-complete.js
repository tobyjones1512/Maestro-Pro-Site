// After the customer returns from GoCardless: creates the subscription once (idempotent) and returns the licence key.
import { gc, cors, makeKey, PRICES } from "./_gc.js";

export default async function handler(req, res) {
  if (cors(req, res, "GET")) return;
  const r = String(req.query.r ?? "");
  if (!/^BRQ[A-Z0-9]+$/.test(r)) return res.status(400).json({ error: "Missing or invalid reference." });

  try {
    const br = await gc("GET", `/billing_requests/${r}`);
    const b = br.data.billing_requests;
    if (!b) return res.status(404).json({ error: "We couldn't find that application." });
    const mandate = b.links?.mandate_request_mandate;
    if (b.status !== "fulfilled" || !mandate) return res.status(409).json({ error: "The Direct Debit set-up isn't finished yet." });

    const { institution, urn, plan } = b.metadata || {};
    const price = PRICES[plan];
    if (!price) return res.status(500).json({ error: "This application has no plan." });

    const sub = await gc("POST", "/subscriptions", {
      subscriptions: {
        amount: price.amount,
        currency: "GBP",
        name: `Whiskers' Word Quest licence: ${institution}`.slice(0, 255),
        interval_unit: price.unit,
        interval: 1,
        links: { mandate },
        metadata: { institution, urn, billing_request: r },
      },
    }, `wwq-${r}`);
    // A repeat visit hits the idempotency key and points at the subscription made the first time.
    const id = sub.data.subscriptions?.id || sub.data.error?.errors?.[0]?.links?.conflicting_resource_id;
    if (!id) return res.status(502).json({ error: sub.data.error?.message || "Couldn't create the licence." });
    res.status(200).json({ key: makeKey(id), institution, plan });
  } catch {
    res.status(502).json({ error: "Couldn't reach the payment provider." });
  }
}
