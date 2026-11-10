// Reads a .maestropro bundle from the Blob store without loading all of it: "PLAYALONG1", a 4-byte little-endian header length, the JSON header
// (the item and the names and sizes of its files), then the files one after another.
import { get } from "@vercel/blob";

const MAGIC = "PLAYALONG1";
export const BUNDLE = (id) => `marketplace/bundles/${id}.maestropro`;
export const ALLOWED = new Set("musicxml mxl xml pdf mid midi kar cdg lrc txt mp3 m4a wav aif aiff caf aac flac".split(" "));
export const ext = (n) => String(n).split(".").pop().toLowerCase();

const open = async (id) => {
  const r = await get(BUNDLE(id), { access: process.env.BLOB_ACCESS === "public" ? "public" : "private", useCache: false }).catch(() => null);
  return r && r.statusCode === 200 ? r : null;
};

/** The bytes from `start` up to (not including) `end`, or null if the bundle isn't there. Stops reading once it has them. */
export async function readRange(id, start, end) {
  const r = await open(id);
  if (!r) return null;
  const reader = r.stream.getReader(), out = [];
  let pos = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const from = pos; pos += value.length;
    if (pos > start && from < end) out.push(value.subarray(Math.max(start - from, 0), Math.min(end, pos) - from));
    if (pos >= end) { reader.cancel().catch(() => {}); break; }
  }
  return Buffer.concat(out);
}

/** { files: [{ name, size, offset }], item, size } for a well-formed bundle, otherwise null. */
export async function bundleInfo(id) {
  const r = await open(id);
  const head = r && (await readRange(id, 0, 14));
  if (!head || head.length < 14 || head.subarray(0, MAGIC.length).toString() !== MAGIC) return null;
  const n = head.readUInt32LE(10);
  if (n < 2 || n > 1e6) return null;
  let j;
  try { j = JSON.parse((await readRange(id, 14, 14 + n)).toString()); } catch { return null; }
  if (!Array.isArray(j.files)) return null;
  let offset = 14 + n;
  const files = [];
  for (const f of j.files) {
    const size = Number(f?.size);
    if (typeof f?.name !== "string" || !Number.isInteger(size) || size < 0) return null;
    files.push({ name: f.name, size, offset });
    offset += size;
  }
  if (r.blob.size && r.blob.size !== offset) return null;   // the files don't add up to the bundle
  return { files, item: j.item || {}, size: offset };
}
