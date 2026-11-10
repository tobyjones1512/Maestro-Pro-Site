// Run: node tools/test-review.mjs  (the whole review: bundle -> VirusTotal -> the AI -> status and email, with the outside services faked)
import assert from "node:assert/strict";
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, n) { return s === "@vercel/blob" ? { url: ${JSON.stringify(new URL("./blob-mock.mjs", import.meta.url).href)}, shortCircuit: true } : n(s, c); }`));
process.env.VIRUSTOTAL_API_KEY = "vt"; process.env.LLM_API_KEY = "llm"; process.env.RESEND_API_KEY = "re"; process.env.BLOB_READ_WRITE_TOKEN = "x";
const { makeBundle } = await import("../assets/marketplace.js");
const { store } = await import("./blob-mock.mjs");
const { addProduct, products, updateProduct } = await import("../marketplace-api/api/_blob.js");
const { step, ownerDecide } = await import("../marketplace-api/api/_review.js");

const emails = [], vt = { verdict: { harmless: 60, undetected: 5 } }, llm = { answer: null };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
  if (url.includes("virustotal.com/api/v3/files/") && !init.method) return json({}, 404);                       // never seen: upload it
  if (url.endsWith("/api/v3/files")) return json({ data: { id: "an1" } });
  if (url.includes("/analyses/")) return json({ data: { attributes: { status: "completed", stats: vt.verdict } } });
  if (url.includes("/chat/completions")) { llm.last = JSON.parse(init.body); return json({ choices: [{ message: { content: llm.answer } }] }); }
  if (url.includes("api.resend.com")) { emails.push(JSON.parse(init.body)); return json({ id: "e" }); }
  throw new Error("unexpected " + url);
};
store.set("marketplace/sellers/aaaaaaaaaaaaaaaa.json", { data: Buffer.from(JSON.stringify({ id: "aaaaaaaaaaaaaaaa", name: "Sam Lee", email: "sam@example.com" })), etag: "0" });

async function submit(id, title, files, answer) {
  const b = await makeBundle({ title, score: files.score, tracks: files.tracks || [] });
  store.set(`marketplace/bundles/${id}.maestropro`, { data: Buffer.from(await b.arrayBuffer()), etag: "b" });
  await addProduct({ id, title, composer: "Sam Lee", description: "d", priceUSD: 4.25, sellerId: "aaaaaaaaaaaaaaaa", sellerName: "Sam Lee", contents: "Score", created: 1, status: "scanning", review: {} });
  llm.answer = answer;
  for (let i = 0; i < 8; i++) { await step(id); const p = (await products()).find((x) => x.id === id); if (!["scanning", "reviewing"].includes(p.status)) return p; }
  return (await products()).find((x) => x.id === id);
}
const xml = (t, rights = "") => new File([`<score-partwise><work><work-title>${t}</work-title></work><identification><creator type="composer">Sam Lee</creator>${rights}</identification></score-partwise>`], "s.musicxml");

// 1. Original work: accepted, "Ready For Distribution", one email to the merchant that replies to noreply.
let p = await submit("11111111-1111-1111-1111-111111111111", "My Waltz", { score: xml("My Waltz") }, '{"decision":"accept","guidelines":[],"reason":"Looks original."}');
assert.equal(p.status, "ready"); assert.equal(p.review.notified, true);
assert.equal(emails.length, 1); assert.equal(emails[0].reply_to, "noreply@maestro-pro.app"); assert.match(emails[0].subject, /^Accepted/); assert.deepEqual(emails[0].to, ["sam@example.com"]);
assert.match(llm.last.messages[1].content, /work-title: My Waltz|work title: My Waltz/);   // the reviewer was shown the file's own metadata

// 2. A copyrighted work: refused, the reason quotes the guideline from the guidelines file (not the model), and the email links it.
p = await submit("22222222-2222-2222-2222-222222222222", "Hit Song", { score: xml("Hit Song", "<rights>(c) 2019 Big Music Publishing. All rights reserved.</rights>") }, '{"decision":"refuse","guidelines":["2.2","9.9"],"reason":"The file carries a publisher copyright line \\u2014 so it is not yours to sell."}');
assert.equal(p.status, "refused"); assert.deepEqual(p.review.ids, ["2.2"]); assert.ok(!p.review.reason.includes("—"));
const e = emails.at(-1); assert.match(e.subject, /^Refused/); assert.equal(e.reply_to, "noreply@maestro-pro.app");
assert.match(e.html, /marketplace\/guidelines\/#g2-2/); assert.doesNotMatch(e.text, /A new arrangement, transcription/); assert.doesNotMatch(e.html, /A new arrangement, transcription/);

// 3. VirusTotal flags a file: refused under 1.1 without asking the AI.
vt.verdict = { malicious: 3, harmless: 50 }; llm.last = null;
p = await submit("33333333-3333-3333-3333-333333333333", "Bad", { score: xml("Bad") }, "{}");
assert.equal(p.status, "refused"); assert.deepEqual(p.review.ids, ["1.1"]); assert.equal(llm.last, null);
vt.verdict = { harmless: 60 };

// 4. An unusable answer leaves the item in review (never accepted by default), and a later good answer decides it.
p = await submit("66666666-6666-6666-6666-666666666666", "Maybe", { score: xml("Maybe") }, "I cannot decide");
assert.equal(p.status, "reviewing");
llm.answer = '{"decision":"accept","guidelines":[],"reason":"Fine."}'; await step(p.id);
assert.equal((await products()).find((x) => x.id === p.id).status, "ready");

// 5. Appeals: evidence is scanned with VirusTotal and the item assessed again; the third refusal goes to the owner, whose word is final.
const appeal = async (id, text) => {
  const path = `marketplace/evidence/${id}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-licence.txt`;
  store.set(path, { data: Buffer.from("Licence granted by the publisher to Sam Lee."), etag: "e" });
  await updateProduct(id, (x) => ({ ...x, status: "scanning", lock: 0, appeal: { at: 1, text, files: [{ name: "licence.txt", size: 40, path, scan: { status: "queued" } }] } }));
  for (let i = 0; i < 8; i++) { await step(id); const q = (await products()).find((x) => x.id === id); if (!["scanning", "reviewing"].includes(q.status)) return q; }
};
const no = '{"decision":"refuse","guidelines":["2.2"],"reason":"Looks like a published song."}';
let a = await submit("77777777-7777-7777-7777-777777777777", "Pop Song", { score: xml("Pop Song") }, no);
assert.equal(a.status, "refused"); assert.equal(a.refusals, 1);
llm.answer = no; a = await appeal(a.id, "I hold a licence, see the attached letter.");
assert.match(llm.last.messages[1].content, /Licence granted by the publisher/); assert.match(llm.last.messages[1].content, /I hold a licence/);
assert.equal(a.status, "refused"); assert.equal(a.refusals, 2); assert.equal(a.history.length, 2); assert.equal(a.appeal, undefined);
const before = emails.length;
a = await appeal(a.id, "Here is more proof of the licence.");
assert.equal(a.status, "escalated"); assert.equal(a.refusals, 3);
assert.ok(emails.slice(before).some((m) => /^Final review/.test(m.subject))); assert.ok(emails.slice(before).some((m) => /needs your decision/.test(m.subject)));
let r = await ownerDecide(a.id, false, "Not convinced.");
assert.ok(r.decided); assert.equal(r.product.status, "refused"); assert.equal(r.product.final, true); assert.match(emails.at(-1).subject, /^Final decision/);
assert.equal((await ownerDecide(a.id, true, "")).decided, false);   // decided once only
// flagged evidence counts as a refusal; an accepted appeal puts the item on sale
a = await submit("88888888-8888-8888-8888-888888888888", "Old Song", { score: xml("Old Song") }, no);
vt.verdict = { malicious: 4, harmless: 40 }; a = await appeal(a.id, "A licence document is attached here.");
assert.equal(a.status, "refused"); assert.deepEqual(a.review.ids, ["1.1"]); vt.verdict = { harmless: 60 };
llm.answer = '{"decision":"accept","guidelines":[],"reason":"The licence covers it."}'; a = await appeal(a.id, "A better copy of the licence.");
assert.equal(a.status, "ready");
r = await ownerDecide((await submit("99999999-9999-9999-9999-999999999999", "Q", { score: xml("Q") }, no)).id, true, ""); assert.equal(r.decided, false);
console.log("ok");
