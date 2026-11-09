// Used by the app: a key is valid while its subscription is active and the institution name matches exactly.
import { gc, cors, norm, parseKey } from "./_gc.js";

export default async function handler(req, res) {
  if (cors(req, res, "POST")) return;
  const { key, name } = req.body || {};
  const id = parseKey(key);
  if (!id) return res.status(200).json({ valid: false, error: "That licence key isn't valid." });
  try {
    const s = (await gc("GET", `/subscriptions/${id}`)).data.subscriptions;
    if (!s) return res.status(200).json({ valid: false, error: "That licence key isn't valid." });
    if (norm(s.metadata?.institution) !== norm(name)) return res.status(200).json({ valid: false, error: "The institution name doesn't match this licence." });
    if (s.status !== "active") return res.status(200).json({ valid: false, error: "This licence is no longer active." });
    res.status(200).json({ valid: true, institution: s.metadata.institution, plan: s.interval_unit });
  } catch {
    res.status(502).json({ valid: false, error: "Couldn't check the licence. Try again online." });
  }
}
