// Run: node tools/test-marketplace.mjs  (the bundle layout, the quarter-dollar price rule, the guidelines the bot quotes, and the emails)
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { makeBundle, validPrice } from "../assets/marketplace.js";
import { price, currencyFor, minor, fmt, cleanRegions, availableIn, refundable } from "../marketplace-api/api/_mp.js";
import { verdictFrom } from "../marketplace-api/api/_vt.js";
import { buildEmail, resolve } from "../marketplace-api/api/_email.js";
import { GUIDELINE, tidy } from "../marketplace-api/api/_review.js";
import guidelines from "../marketplace-api/lib/guidelines.js";

// Prices: $1.00 to $999.75 in steps of a quarter, nothing else.
for (const v of ["1", "1.00", "4.25", "4.5", "4.50", "4.75", "999.75", "12", "0.25", "0.50", "0.75"]) { assert.ok(validPrice(v), v); assert.ok(price(v), v); }
for (const v of ["4.10", "4.99", "4.01", "4.26", "0", "0.10", "0.24", "0.99", "-1", "1e1", "", "1000", "999.76", "4.255", "abc", "4,25"]) { assert.equal(validPrice(v), false, v); assert.equal(price(v), null, v); }
assert.equal(price("4.5"), 4.5); assert.equal(price("4.75"), 4.75);
assert.equal(currencyFor("GB"), "GBP"); assert.equal(currencyFor("DE"), "EUR"); assert.equal(currencyFor("US"), "USD"); assert.equal(currencyFor(undefined), "USD");
assert.equal(fmt(minor(5, "JPY", 150.3), "JPY"), "752"); assert.equal(fmt(minor(4.25, "GBP", 0.75), "GBP"), "3.19"); assert.equal(fmt(minor(4.25, "USD", 1), "USD"), "4.25");

// Where an item is sold
assert.deepEqual(cleanRegions(undefined), []); assert.deepEqual(cleanRegions(["gb", "GB", "de"]), ["GB", "DE"]);
for (const v of ["GB", ["GBR"], ["g"], [1], "x"]) assert.equal(cleanRegions(v), null, String(v));
assert.ok(availableIn([], "JP")); assert.ok(availableIn(undefined, undefined)); assert.ok(availableIn(["GB"], "gb")); assert.equal(availableIn(["GB"], "US"), false); assert.equal(availableIn(["GB"], undefined), false);

// Refunds: 14 days, once per item (buying it again, even after a refund, loses the right)
const T = Date.now(), D = 864e5;
assert.ok(refundable({ status: "paid", paidAt: T - 13 * D, same: 1 }, T));
assert.equal(refundable({ status: "paid", paidAt: T - 15 * D, same: 1 }, T), false);
assert.equal(refundable({ status: "paid", paidAt: T, same: 2 }, T), false);
assert.equal(refundable({ status: "refunded", paidAt: T, same: 1 }, T), false);
assert.equal(refundable({ status: "open", paidAt: T, same: 1 }, T), false);

// VirusTotal verdicts
assert.equal(verdictFrom({ harmless: 60, undetected: 10 }).status, "clean");
assert.equal(verdictFrom({ harmless: 60, suspicious: 1 }).status, "flagged");
assert.equal(verdictFrom({}).total, 0);

// The guidelines: every item has an id, a title and text, ids are unique, and the ones the code names exist.
const ids = guidelines.sections.flatMap((s) => s.items.map((i) => i.id));
assert.equal(new Set(ids).size, ids.length);
for (const i of ["1.1", "1.2", "3.2", "2.1", "5.3", "6.1"]) assert.ok(GUIDELINE[i]?.text, i);
for (const s of JSON.stringify(guidelines).split("")) assert.ok(s !== "—" && s !== "–", "no dashes");
assert.equal(tidy("Fine — but see https://x.test/a now"), "Fine, but see now");

// Emails: noreply wording, the guidelines link resolves, only our own links get through.
const m = buildEmail({ name: "Sam", reply: "**Song** was **Refused**.\n\nSee the [guidelines](guidelines) and [evil](https://evil.test).", cards: [{ label: "Guideline 2.1", title: "2.1 Rights", url: resolve("guidelines") + "#g2-1", text: "“quote”" }] });
assert.match(m.html, /marketplace\/guidelines\/"/); assert.ok(!m.html.includes("evil.test")); assert.match(m.text, /not monitored/);

// The bundle
const b = await makeBundle({ title: "Test", score: new File(["<score/>"], "t.musicxml"), tracks: [new File(["aa"], "a.mp3"), new File(["bbb"], "b.mp3"), new File(["c"], "a.mp3")], lyrics: new File(["la"], "t.lrc") });
const buf = Buffer.from(await b.arrayBuffer());
assert.equal(buf.subarray(0, 10).toString(), "PLAYALONG1");
const n = buf.readUInt32LE(10), head = JSON.parse(buf.subarray(14, 14 + n).toString());
assert.deepEqual(head.files.map((f) => f.name), ["t.musicxml", "a.mp3", "b.mp3", "a-2.mp3", "t.lrc"]);
assert.equal(head.files.reduce((s, f) => s + f.size, 0), buf.length - 14 - n);
assert.equal(head.item.track, "a.mp3"); assert.equal(head.item.extraTracks.length, 2); assert.equal(head.item.lyrics, "t.lrc");
await assert.rejects(makeBundle({ title: "x", score: new File(["x"], "evil.exe") }));
await assert.rejects(makeBundle({ title: "x", score: new File(["x"], "a.xml"), tracks: [new File(["x"], "a.exe")] }));
console.log("ok");
