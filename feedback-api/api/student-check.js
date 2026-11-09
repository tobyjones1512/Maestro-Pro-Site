// Used by the Maestro Pro app: valid when the key is genuine and that GoCardless customer's latest bill is paid, and (except for Education
// licences) the key is in use on no more than 3 devices. The app sends only the key, so devices are told apart by a cookie (see _devices.js).
import { parseStudentKey, studentHasPaid } from "./_gc.js";
import { deviceGate, cookieHeader } from "./_devices.js";
import devicesPage from "./_devices-page.js";

export default async function handler(req, res) {
  // The website's devices page (maestro-pro.app/key/devices/) shares this endpoint; the app only ever sends {key}.
  if (req.method === "OPTIONS" || ["list", "remove", "remove-all"].includes(req.body?.action)) return devicesPage(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "POST only." });
  const id = parseStudentKey(req.body?.key);
  if (!id) return res.status(200).json({ valid: false, error: "That licence key isn't valid." });
  try {
    if (!(await studentHasPaid(id))) return res.status(200).json({ valid: false, error: "We can't find a current payment for this licence." });
    const gate = await deviceGate({ key: req.body.key, customerId: id, headers: req.headers });
    if (!gate.ok) return res.status(200).json({ valid: false, error: gate.error });
    if (gate.setCookie) res.setHeader("Set-Cookie", cookieHeader(gate.setCookie));
    res.status(200).json({ valid: true });
  } catch (e) {
    console.error("student-check", e?.message);
    res.status(502).json({ valid: false, error: "Couldn't check the licence. Try again online." });
  }
}
