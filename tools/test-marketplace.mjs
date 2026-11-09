// Run: node tools/test-marketplace.mjs  (checks the bundle layout and the whole-dollar price rule)
import assert from "node:assert/strict";
import { makeBundle, wholeDollars } from "../assets/marketplace.js";
import { wholePrice, currencyFor, minor, fmt } from "../feedback-api/api/_mp.js";

for (const v of ["4.50", "4.0", "0", "-1", "1e1", "", "1000", "abc"]) { assert.equal(wholeDollars(v), false, v); assert.equal(wholePrice(v), null, v); }
for (const v of ["1", "12", "999"]) { assert.ok(wholeDollars(v), v); assert.equal(wholePrice(v), Number(v)); }
assert.equal(currencyFor("GB"), "GBP"); assert.equal(currencyFor("DE"), "EUR"); assert.equal(currencyFor("US"), "USD"); assert.equal(currencyFor(undefined), "USD");
assert.equal(fmt(minor(5, "JPY", 150.3), "JPY"), "752"); assert.equal(fmt(minor(5, "GBP", 0.7501), "GBP"), "3.76");

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
import("node:fs").then((fs) => fs.writeFileSync(process.env.HEADER_OUT || "/dev/null", JSON.stringify(head)));
