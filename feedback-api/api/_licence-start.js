// Starts a Direct Debit set-up on GoCardless and returns the hosted page to send the customer to.
import { gc, cors, PRICES } from "./_gc.js";

const SITE = "https://whiskerswordquest.app";

export default async function handler(req, res) {
  if (cors(req, res, "POST")) return;
  const b = req.body || {};
  const institution = String(b.institution ?? "").trim().replace(/\s+/g, " ");
  const urn = String(b.urn ?? "").trim();
  const email = String(b.email ?? "").trim();
  if (institution.length < 3 || institution.length > 120) return res.status(400).json({ error: "Enter the institution's full name." });
  if (!/^\d{5,10}$/.test(urn)) return res.status(400).json({ error: "Enter the institution's URN or UKPRN (5 to 10 digits)." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!PRICES[b.plan]) return res.status(400).json({ error: "Choose monthly or yearly." });
  if (!b.registered) return res.status(400).json({ error: "Please confirm the institution is a registered UK educational institution." });

  try {
    const br = await gc("POST", "/billing_requests", {
      billing_requests: {
        mandate_request: { scheme: "bacs", currency: "GBP" },
        metadata: { institution, urn, plan: b.plan },
      },
    });
    const id = br.data.billing_requests?.id;
    if (!id) return res.status(502).json({ error: br.data.error?.message || "The payment provider refused it." });
    const flow = await gc("POST", "/billing_request_flows", {
      billing_request_flows: {
        redirect_uri: `${SITE}/licence-thanks.html?r=${id}`,
        exit_uri: `${SITE}/licence.html`,
        prefilled_customer: { email, company_name: institution },
        links: { billing_request: id },
      },
    });
    const url = flow.data.billing_request_flows?.authorisation_url;
    if (!url) return res.status(502).json({ error: flow.data.error?.message || "Couldn't start the payment page." });
    res.status(200).json({ url });
  } catch {
    res.status(502).json({ error: "Couldn't reach the payment provider." });
  }
}
