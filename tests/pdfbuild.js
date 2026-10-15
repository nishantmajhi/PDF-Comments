/* A small PDF assembler, for building fixtures byte by byte.
 *
 * Real-world PDFs are a poor test corpus: they are large, they are hard to
 * shrink without breaking them, and the interesting cases (a cyclic page
 * tree, a comment whose text contains a closing parenthesis, an author name
 * in UTF-16) are exactly the ones you cannot conjure by exporting from Word.
 * So the fixtures here are written out longhand.
 *
 * The parser never reads the cross-reference table — it scans the whole file
 * for `N G obj` — so the xref written here is a plausible shape rather than a
 * byte-accurate index, and objects packed into an object stream are simply
 * absent from it. That is a deliberate limitation of the fixtures, not of the
 * format: it keeps the builder short, and no assertion depends on it.
 */

const zlib = require("node:zlib");

/** PDF structure is byte-oriented; latin1 is the lossless text view of it. */
function bytes(str) {
  return Buffer.from(str, "latin1");
}

/**
 * A stream object: dictionary, then raw (already-encoded) stream data.
 * `dict` must not include /Length — it is computed here.
 */
function streamObject(dict, data, { omitLength = false } = {}) {
  const body = Buffer.isBuffer(data) ? data : bytes(data);
  const withLength = omitLength ? dict : `${dict.replace(/>>\s*$/, "")} /Length ${body.length} >>`;
  return { stream: true, dict: withLength, data: body };
}

/**
 * Pack object bodies into a /Type /ObjStm, the compressed container that
 * every modern PDF writer uses. Layout is: an integer header of
 * `objnum offset` pairs, then the bodies, concatenated, at those offsets
 * relative to /First.
 */
function objectStream(entries, { compress = true, extraDict = "" } = {}) {
  let offsets = "";
  let payload = "";
  for (const [num, body] of entries) {
    offsets += `${num} ${payload.length} `;
    payload += `${body} `;
  }
  const first = offsets.length;
  const raw = bytes(offsets + payload);
  const data = compress ? zlib.deflateSync(raw) : raw;
  const filter = compress ? " /Filter /FlateDecode" : "";
  const dict = `<< /Type /ObjStm /N ${entries.length} /First ${first}${filter}${extraDict} >>`;
  return streamObject(dict, data);
}

/**
 * Assemble a complete file.
 *
 * `objects` is an array of [objNum, body], where body is either a string (the
 * text that sits between `obj` and `endobj`) or the result of streamObject().
 */
function buildPdf(objects, { version = "1.7", root = 1, trailer = "" } = {}) {
  const parts = [bytes(`%PDF-${version}\n%\xE2\xE3\xCF\xD3\n`)];
  const offsets = new Map();
  let at = parts[0].length;

  for (const [num, body] of objects) {
    offsets.set(num, at);
    let chunk;
    if (body && body.stream) {
      chunk = Buffer.concat([
        bytes(`${num} 0 obj\n${body.dict}\nstream\n`),
        body.data,
        bytes("\nendstream\nendobj\n"),
      ]);
    } else {
      chunk = bytes(`${num} 0 obj\n${body}\nendobj\n`);
    }
    parts.push(chunk);
    at += chunk.length;
  }

  const maxNum = Math.max(...objects.map(([n]) => n));
  let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxNum; n++) {
    const off = offsets.get(n);
    xref += off === undefined
      ? "0000000000 65535 f \n"
      : `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  parts.push(bytes(`${xref}trailer\n<< /Size ${maxNum + 1} /Root ${root} 0 R ${trailer}>>\nstartxref\n${at}\n%%EOF\n`));

  return Buffer.concat(parts);
}

/** The arrayBuffer the parser actually receives. */
function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/* ── Ready-made pieces, so the tests read as what they are testing ── */

function catalog(pagesNum = 2) {
  return `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`;
}

function pagesNode(kids, { count = kids.length } = {}) {
  return `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${count} >>`;
}

function page(annots = [], { parent = 2 } = {}) {
  const a = annots.length ? ` /Annots [${annots.map((n) => `${n} 0 R`).join(" ")}]` : "";
  return `<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 612 792]${a} >>`;
}

/**
 * A markup annotation. `fields` values are written verbatim, so a test can
 * hand over a raw hex string, a malformed date, or anything else it needs.
 */
function annot({ subtype = "Text", author = "(Alice)", contents = "(A comment)", date = null, irt = null, extra = "" } = {}) {
  let d = `<< /Type /Annot /Subtype /${subtype}`;
  if (author !== null) d += ` /T ${author}`;
  if (contents !== null) d += ` /Contents ${contents}`;
  if (date !== null) d += ` /M (${date})`;
  if (irt !== null) d += ` /IRT ${irt} 0 R`;
  if (extra) d += ` ${extra}`;
  return `${d} >>`;
}

module.exports = {
  bytes,
  streamObject,
  objectStream,
  buildPdf,
  toArrayBuffer,
  catalog,
  pagesNode,
  page,
  annot,
};
