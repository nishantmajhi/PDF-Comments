/* Compressed object streams.
 *
 * Since PDF 1.5 (2003) writers pack indirect objects into Flate-compressed
 * /Type /ObjStm streams. Word, recent Acrobat, LibreOffice and Chrome's own
 * "print to PDF" all do it by default. A parser that only scans the raw bytes
 * for `N G obj` cannot see any of those objects, so the annotations inside
 * them are invisible and the popup reports "no comments found" — which sends
 * the user looking for a problem in their PDF rather than in this extension.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

const PDFParser = require("../pdf-parser.js");
const {
  buildPdf, toArrayBuffer, objectStream, streamObject, bytes,
  catalog, pagesNode, page, annot,
} = require("./pdfbuild.js");

test("annotations inside a compressed object stream are found", async () => {
  // The catalog, the page tree and the annotation all live inside object 9;
  // nothing but the object stream itself is visible in the raw bytes.
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [9, objectStream([
      [1, catalog()],
      [2, pagesNode([3])],
      [3, page([4])],
      [4, annot({ author: "(Alice)", contents: "(compressed comment)" })],
    ])],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].author, "Alice");
  assert.equal(threads[0].contents, "compressed comment");
  assert.equal(threads[0].page, 1);
});

test("a hybrid file mixes compressed and uncompressed objects", async () => {
  // The common real shape: structure compressed, annotations added later by
  // an incremental update and therefore written out plainly.
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [9, objectStream([
      [1, catalog()],
      [2, pagesNode([3, 5])],
      [3, page([4])],
      [5, page([6])],
    ])],
    [4, annot({ contents: "(plain, page 1)" })],
    [6, annot({ contents: "(plain, page 2)" })],
  ])));

  const byText = Object.fromEntries(threads.map((t) => [t.contents, t.page]));
  assert.deepEqual(byText, { "plain, page 1": 1, "plain, page 2": 2 });
});

test("several object streams in one file are all read", async () => {
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [8, objectStream([[1, catalog()], [2, pagesNode([3])]])],
    [9, objectStream([[3, page([4])], [4, annot({ contents: "(two streams)" })]])],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].page, 1);
});

test("an uncompressed object stream is read too", async () => {
  // /Filter is optional; a stream with none is stored verbatim.
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [9, objectStream([
      [1, catalog()],
      [2, pagesNode([3])],
      [3, page([4])],
      [4, annot({ contents: "(stored, not deflated)" })],
    ], { compress: false })],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].contents, "stored, not deflated");
  // The page number is the tell: without real object-stream support the
  // container itself gets mistaken for the annotation, and has no page.
  assert.equal(threads[0].page, 1);
});

test("the object stream container is never itself reported as a comment", async () => {
  // Its dictionary and payload contain /Subtype, /T and /Contents, so a
  // parser that treats the container as one big object finds a phantom.
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [9, objectStream([
      [1, catalog()],
      [2, pagesNode([3])],
      [3, page([4])],
      [4, annot({ author: "(Alice)", contents: "(the only comment)" })],
    ], { compress: false })],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, "4");
});

test("an object written plainly wins over the same number inside a stream", async () => {
  // An incremental update rewrites an object; the later, plain definition is
  // the live one. Nothing should be able to resurrect the stale copy.
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [9, objectStream([
      [1, catalog()],
      [2, pagesNode([3])],
      [3, page([4])],
      [4, annot({ contents: "(stale)" })],
    ])],
    [4, annot({ contents: "(revised)" })],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].contents, "revised");
});

test("a corrupt object stream does not stop the rest of the file parsing", async () => {
  const garbage = streamObject(
    "<< /Type /ObjStm /N 2 /First 10 /Filter /FlateDecode >>",
    bytes("this is not deflate data at all"),
  );

  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [9, garbage],
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4])],
    [4, annot({ contents: "(survived the corrupt stream)" })],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].contents, "survived the corrupt stream");
});

test("a truncated object stream header yields what it can", async () => {
  // /N claims five objects; the header only holds two pairs.
  const header = "1 0 2 40 ";
  const payload = `${catalog()} ${pagesNode([3])} `;
  const raw = bytes(header + payload);
  const truncated = streamObject(
    `<< /Type /ObjStm /N 5 /First ${header.length} /Filter /FlateDecode >>`,
    zlib.deflateSync(raw),
  );

  const result = await PDFParser.parse(toArrayBuffer(buildPdf([
    [9, truncated],
    [3, page([4])],
    [4, annot({ contents: "(still here)" })],
  ])));

  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].contents, "still here");
});

test("a file whose objects are all unreachable is reported, not silently empty", async () => {
  // An object stream this parser cannot decode — an encrypted file's, or one
  // using a filter it does not implement. The user needs to be told that the
  // file was unreadable rather than that it has no comments.
  const opaque = streamObject(
    "<< /Type /ObjStm /N 3 /First 12 /Filter /Crypt >>",
    bytes("\x01\x02\x03\x04opaque bytes"),
  );

  const result = await PDFParser.parse(toArrayBuffer(buildPdf([[9, opaque]])));

  assert.deepEqual(result.threads, []);
  assert.equal(result.unreadableObjectStreams, 1,
    "the parser must say it could not read an object stream");
});

test("a readable file reports no unreadable streams", async () => {
  const result = await PDFParser.parse(toArrayBuffer(buildPdf([
    [9, objectStream([[1, catalog()], [2, pagesNode([3])], [3, page([4])]])],
    [4, annot({ contents: "(fine)" })],
  ])));

  assert.equal(result.unreadableObjectStreams, 0);
});

test("stream data that looks like an object definition does not shadow a real one", async () => {
  // Compressed bytes are arbitrary and will eventually contain the sequence
  // `N G obj`. A whole-file regex scan treats that as a real object and, since
  // later definitions overwrite earlier ones, loses the genuine object 3.
  const decoy = streamObject(
    "<< /Type /XObject /Subtype /Image >>",
    bytes("\x89PNG junk endobj junk 3 0 obj\n<< /Type /Page /MediaBox [0 0 1 1] >>\nendobj more junk"),
  );

  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4])],
    [4, annot({ contents: "(real page 1)" })],
    [7, decoy],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].page, 1, "the decoy page must not replace the real one");
});

test("an `endobj` inside stream data does not truncate the object", async () => {
  // The old scan ended an object at the first `endobj` after it, wherever
  // that fell — including in the middle of binary stream data.
  const sneaky = objectStream([[4, annot({ contents: "(after a fake endobj)" })]]);
  // Put a literal "endobj" in an earlier object's stream data.
  const noisy = streamObject("<< /Type /XObject >>", bytes("binary endobj binary"));

  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4])],
    [6, noisy],
    [9, sneaky],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].contents, "after a fake endobj");
});
