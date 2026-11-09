// The licence key email, in the same design as the support emails (see buildEmail in support-inbound.js).
import { buildEmail } from "./support-inbound.js";

export const KEY_FROM = () => process.env.KEY_FROM || "Maestro Pro <noreply@maestro-pro.app>";
export const TESTFLIGHT = "https://testflight.apple.com/join/rPBpRCu9";
export const KEY_SUBJECT = "Your Maestro Pro licence key";
const NOTE = "This inbox is not monitored, so please do not reply to this email. If you need help, email support@maestro-pro.app.";

/** `found` is a list of {key, plans[]}, one per active licence for the email address. Returns {subject, html, text}. */
export function buildKeyEmail(found) {
  const one = found.length === 1;
  const keys = found.map((f) => (one ? `\`${f.key}\`` : `**${(f.plans || []).join(", ") || "Maestro Pro"}**\n\`${f.key}\``)).join("\n\n");
  const reply = [
    one ? "Here is your Maestro Pro licence key:" : `We found ${found.length} active Maestro Pro licence keys for this email address:`,
    keys,
    `In the app, tap **Already have a licence key?** on the paywall and enter ${one ? "this key" : "the key for the plan you want to use"}. A licence works on up to 3 devices, and you can [remove a device](https://maestro-pro.app/key/devices/) at any time.`,
    "To install Maestro Pro, use the TestFlight button below.",
  ].join("\n\n");
  const { html, text } = buildEmail({
    name: null, reply, label: "Licence", signoff: "Maestro Pro Team", footnote: NOTE,
    buttons: [["Install Maestro Pro with TestFlight", TESTFLIGHT]],
    resolve: (t) => (/^https:\/\/[^\s"<>]+$/.test(String(t).trim()) ? String(t).trim() : null),
  });
  return { subject: KEY_SUBJECT, html, text };
}
