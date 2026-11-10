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

// 6. Versions, downloads and proof: every file of every version is scanned and the reviewer sees all of it; the accepted state is what buyers get.
const put = async (path, text) => store.set(path, { data: Buffer.from(text), etag: "p" });
const bundleAt = async (id, title, score) => { const b = await makeBundle({ title, score }); store.set(`marketplace/bundles/${id}.maestropro`, { data: Buffer.from(await b.arrayBuffer()), etag: "b" }); };
const run = async (id) => { for (let i = 0; i < 10; i++) { await step(id); const q = (await products()).find((x) => x.id === id); if (!["scanning", "reviewing"].includes(q.status)) return q; } return (await products()).find((x) => x.id === id); };
const base = { composer: "Sam Lee", description: "d", priceUSD: 3, sellerId: "aaaaaaaaaaaaaaaa", sellerName: "Sam Lee", contents: "2 versions", status: "scanning", review: {} };
const V1 = "a1111111-1111-1111-1111-111111111111", V2 = "a2222222-2222-2222-2222-222222222222", P1 = "b1111111-1111-1111-1111-111111111111";
await bundleAt(V1, "Etude", xml("Etude in C", "<rights>" + "x".repeat(700) + "</rights>")); await bundleAt(V2, "Etude (Bb trumpet)", xml("Etude in D"));
await put(`marketplace/extras/${P1}/c1111111-1111-1111-1111-111111111111-print.txt`, "A printable copy of the etude.");
await put(`marketplace/evidence/${P1}/c2222222-2222-2222-2222-222222222222-licence.txt`, "I, Sam Lee, am the composer of Etude and hold all rights.");
llm.answer = '{"decision":"accept","guidelines":[],"reason":"Original."}';
await addProduct({ ...base, id: P1, title: "Etude", created: 10, variants: [{ id: V1, label: "Concert pitch" }, { id: V2, label: "Bb trumpet" }],
  extras: [{ name: "print.txt", size: 30, path: `marketplace/extras/${P1}/c1111111-1111-1111-1111-111111111111-print.txt` }],
  proof: { text: "I wrote it.", files: [{ name: "licence.txt", size: 50, path: `marketplace/evidence/${P1}/c2222222-2222-2222-2222-222222222222-licence.txt` }] } });
let q = await run(P1);
assert.equal(q.status, "ready");
assert.ok(q.review.files.some((f) => f.bundle === V2) && q.review.files.some((f) => f.proof) && q.review.files.some((f) => f.name === "print.txt"));
assert.equal(q.published.variants.length, 2); assert.equal(q.published.extras.length, 1);
const prompt = llm.last.messages[1].content;
assert.match(prompt, /Bb trumpet/); assert.match(prompt, /Etude in D/); assert.match(prompt, /composer of Etude and hold all rights/); assert.match(prompt, /print\.txt/);
// the same file again as a new item is spam (10.1), and nothing reaches the reviewer
llm.last = null; const V3 = "a3333333-3333-3333-3333-333333333333", P2 = "b2222222-2222-2222-2222-222222222222";
await bundleAt(V3, "Etude again", xml("Etude in C"));
store.set(`marketplace/bundles/${V3}.maestropro`, { ...store.get(`marketplace/bundles/${V1}.maestropro`) });   // byte for byte the same bundle
await addProduct({ ...base, id: P2, title: "Etude again", created: 20, variants: [{ id: V3, label: "" }] });
q = await run(P2);
assert.equal(q.status, "refused"); assert.deepEqual(q.review.ids, ["10.1"]); assert.equal(llm.last, null);
// an edit puts the whole product back in review but buyers keep the accepted files
await updateProduct(P1, (x) => ({ ...x, status: "scanning", review: {}, extras: [], published: x.published }));
llm.answer = no; q = await run(P1);
assert.equal(q.status, "refused"); assert.equal(q.published.extras.length, 1); assert.equal(q.refusals, 1);

// 7. Disputes: filing puts the item on hold, an upheld dispute removes it and gives a strike, the third strike bars the merchant and withdraws everything.
const { fileDispute, respond, decide, disputes } = await import("../marketplace-api/api/_disputes.js");
const mk = async (id, t) => addProduct({ ...base, id, title: t, created: 100, status: "ready", published: { variants: [{ id }], extras: [] } });
const D = ["d1111111-1111-1111-1111-111111111111", "d2222222-2222-2222-2222-222222222222", "d3333333-3333-3333-3333-333333333333", "d4444444-4444-4444-4444-444444444444"];
await mk(D[0], "Song One"); await mk(D[1], "Song Two"); await mk(D[2], "Song Three"); await mk(D[3], "Song Four");
const claim = { name: "Rae Hill", email: "rae@example.com", work: "My song", details: "I wrote this song and it is copied here.", goodFaith: true };
assert.equal((await fileDispute({ ...claim, listing: "nothing", goodFaith: true })).code, 404);
assert.equal((await fileDispute({ ...claim, listing: D[0], goodFaith: false })).code, 400);
const f1 = await fileDispute({ ...claim, listing: `https://maestro-pro.app/marketplace/item/?id=${D[0]}`, via: "support" });
assert.ok(f1.id); assert.equal((await fileDispute({ ...claim, listing: D[0] })).id, f1.id);   // the same claim is not filed twice
assert.ok((await products()).find((x) => x.id === D[0]).hold);
assert.ok(emails.some((m) => /^Copyright dispute: Song One/.test(m.subject)) && emails.some((m) => /We have your copyright dispute/.test(m.subject)));
assert.equal((await respond("aaaaaaaaaaaaaaaa", f1.id, "I hold the licence.")).status, "responded");
assert.equal(await respond("someoneelse0000000", f1.id, "x"), null);
await decide(f1.id, false, "Licence checked.");   // dismissed: back on sale
assert.equal((await products()).find((x) => x.id === D[0]).hold, undefined);
for (const [i, id] of [D[1], D[2], D[3]].entries()) {
  const f = await fileDispute({ ...claim, listing: id }); await decide(f.id, true, "");
  const m = JSON.parse(store.get("marketplace/sellers/aaaaaaaaaaaaaaaa.json").data.toString());
  assert.equal(m.strikes.length, i + 1); assert.equal(Boolean(m.barred), i === 2);
}
const all = await products();
assert.equal(all.find((x) => x.id === D[1]).final, true);
assert.ok(all.filter((x) => x.sellerId === "aaaaaaaaaaaaaaaa").every((x) => x.withdrawn));   // barred: everything withdrawn, even the dismissed one
assert.ok(emails.some((m) => /Merchant Account has been closed/.test(m.subject)));
// 8. the debug code: a flagged submission skips scanning and review and is accepted
{
  const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await addProduct({ id, title: "Debug", composer: "Sam Lee", description: "d", priceUSD: 4.25, sellerId: "aaaaaaaaaaaaaaaa", sellerName: "Sam Lee", contents: "Score", created: 1, status: "scanning", debug: true, review: {} });
  llm.answer = '{"decision":"refuse","guidelines":["1.1"],"reason":"No."}';
  await step(id);
  assert.equal((await products()).find((x) => x.id === id).status, "ready");
}
console.log("ok");
