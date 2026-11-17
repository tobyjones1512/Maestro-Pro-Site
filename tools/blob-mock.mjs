// An in-memory stand-in for @vercel/blob, for tools/test-review.mjs.
export class BlobPreconditionFailedError extends Error {}
export const store = new Map();
let n = 0;
export async function put(path, body, o = {}) {
  const have = store.get(path);
  if (have && !o.allowOverwrite) throw new BlobPreconditionFailedError("already exists");
  if (have && o.ifMatch && o.ifMatch !== have.etag) throw new BlobPreconditionFailedError("precondition");
  const data = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
  store.set(path, { data, etag: String(++n) });
  return { pathname: path };
}
export async function get(path) {
  const b = store.get(path);
  if (!b) return null;
  const parts = []; for (let i = 0; i < b.data.length; i += 7) parts.push(b.data.subarray(i, i + 7));   // small chunks, to test the range reader
  const stream = new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(new Uint8Array(p))); c.close(); } });
  return { statusCode: 200, stream, blob: { size: b.data.length, etag: b.etag } };
}
export const del = async (p) => store.delete(p);
export const head = async (path) => { const b = store.get(path); return b ? { etag: b.etag } : null; };
