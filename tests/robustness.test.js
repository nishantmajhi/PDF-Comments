/* What happens when the PDF is wrong.
 *
 * The input to this parser is arbitrary files from the open web, opened in a
 * browser tab, parsed the moment the user clicks the toolbar button. Malformed
 * is the normal case, not the exceptional one, so every one of these has to
 * end in a result rather than in a thrown error or a wedged popup.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const PDFParser = require("../pdf-parser.js");
const {
  buildPdf, toArrayBuffer, bytes, streamObject,
  catalog, pagesNode, page, annot,
} = require("./pdfbuild.js");

test("a page tree that points back at itself does not blow the stack", async () => {
  // /Kids [2 0 R] on object 2. Following it without a visited set recurses
  // until the JavaScript stack is exhausted and the popup shows an error
  // instead of the comments.
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, "<< /Type /Pages /Kids [2 0 R] /Count 1 >>"],
    [4, annot({ contents: "(still reachable by fallback)" })],
  ])));

  assert.equal(threads.length, 1);
});

test("a two-node cycle in the page tree terminates", async () => {
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, "<< /Type /Pages /Kids [10 0 R] /Count 1 >>"],
    [10, "<< /Type /Pages /Kids [2 0 R] /Count 1 >>"],
    [4, annot({ contents: "(cycle survivor)" })],
  ])));

  assert.equal(threads.length, 1);
});

test("a page reachable twice is counted once", async () => {
  // A diamond: both branches lead to page object 3. It is one page, and the
  // annotation on it belongs to page 1 — not page 1 and again page 2.
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, pagesNode([10, 11], { count: 2 })],
    [10, pagesNode([3], { count: 1 })],
    [11, pagesNode([3], { count: 1 })],
    [3, page([4], { parent: 10 })],
    [4, annot({ contents: "(shared page)" })],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].page, 1);
});

test("a very deep page tree stops at the depth cap rather than recursing forever", async () => {
  // 5000 nested /Pages nodes, no cycle — legal but absurd, and deep enough to
  // exhaust the stack on its own.
  const objects = [[1, catalog()]];
  const DEPTH = 5000;
  for (let i = 0; i < DEPTH; i++) {
    objects.push([2 + i, `<< /Type /Pages /Kids [${3 + i} 0 R] /Count 1 >>`]);
  }
  objects.push([2 + DEPTH, "<< /Type /Page /Parent 1 0 R >>"]);

  const result = await PDFParser.parse(toArrayBuffer(buildPdf(objects)));
  assert.ok(Array.isArray(result.threads), "parse must return, not throw");
});

test("a self-referential /Annots indirect reference terminates", async () => {
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, "<< /Type /Page /Parent 2 0 R /Annots 9 0 R >>"],
    [9, "[ 9 0 R 4 0 R ]"],
    [4, annot({ contents: "(reached anyway)" })],
  ])));

  assert.equal(threads.length, 1);
});

test("an empty file parses to nothing", async () => {
  const result = await PDFParser.parse(new ArrayBuffer(0));
  assert.deepEqual(result.threads, []);
});

test("a file that is not a PDF at all parses to nothing", async () => {
  const junk = bytes("Just some text that happens to be in a tab.");
  const result = await PDFParser.parse(toArrayBuffer(junk));
  assert.deepEqual(result.threads, []);
});

test("an object whose dictionary is never closed does not break the parse", async () => {
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, pagesNode([3])],
    // No closing >>, and /Type /Page is the last thing in the body.
    [3, "<< /MediaBox [0 0 612 792] /Annots [4 0 R] /Type /Page"],
    [4, annot({ contents: "(truncated page dict)" })],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].page, 1, "a Page whose body ends at /Page is still a Page");
});

test("/Type/Pages is never mistaken for /Type/Page", async () => {
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, "<< /Type/Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type/Page /Parent 2 0 R /Annots [4 0 R] >>"],
    [4, annot({ contents: "(one page only)" })],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].page, 1);
});

test("a comment annotation not listed on any page is still found by the fallback scan", async () => {
  // Every comment type must be in the fallback list, not just the first eight:
  // Square and Circle were missing from it while being in COMMENT_TYPES.
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([])],
    [4, annot({ subtype: "Square", contents: "(unlisted square)" })],
    [5, annot({ subtype: "Circle", contents: "(unlisted circle)" })],
    [6, annot({ subtype: "Caret", contents: "(unlisted caret)" })],
  ])));

  assert.deepEqual(
    threads.map((t) => t.contents).sort(),
    ["unlisted caret", "unlisted circle", "unlisted square"],
  );
});

test("the whole file is decoded in one pass, not one character at a time", async () => {
  // Building the text with `text += String.fromCharCode(b)` costs about a
  // second of blocked main thread per twelve megabytes; a TextDecoder does the
  // same twelve in about forty milliseconds. The budget here is deliberately
  // loose — it is there to catch a return to the quadratic shape, not to
  // measure the machine.
  const FILLER = 12 * 1024 * 1024;
  const padding = bytes("%" + "PDF filler. ".repeat(FILLER / 12) + "\n");
  const doc = buildPdf([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4])],
    [4, annot({ contents: "(in a large file)" })],
  ]);
  const big = Buffer.concat([doc, padding]);

  const started = Date.now();
  const { threads } = await PDFParser.parse(toArrayBuffer(big));
  const elapsed = Date.now() - started;

  assert.equal(threads.length, 1);
  assert.ok(elapsed < 600, `parsing ${big.length} bytes took ${elapsed}ms`);
});

test("binary bytes anywhere in the file are decoded losslessly", async () => {
  // Latin-1 is the only decoding under which every byte round-trips to a
  // distinct character; UTF-8 would replace anything invalid and shift every
  // offset after it.
  const highBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const doc = buildPdf([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4])],
    [7, streamObject("<< /Type /XObject >>", highBytes)],
    [4, annot({ contents: "(after the binary)" })],
  ]);

  const { threads } = await PDFParser.parse(toArrayBuffer(doc));
  assert.equal(threads.length, 1);
  assert.equal(threads[0].contents, "after the binary");
});

test("PDF keywords inside a comment's text are not read as syntax", async () => {
  // Found while fixing the object scan: looking for the `stream` keyword
  // anywhere after an object header finds it in the annotation's own text and
  // truncates the object there. The keyword only means anything immediately
  // after a dictionary.
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4, 5])],
    [4, annot({ contents: "(the video stream is corrupt)" })],
    [5, annot({ contents: "(this endobj thing again)" })],
  ])));

  assert.deepEqual(
    threads.map((t) => t.contents).sort(),
    ["the video stream is corrupt", "this endobj thing again"],
  );
});

test("a dictionary key quoted inside a comment does not override the real one", async () => {
  // A regex for `/T` finds one in the comment text as readily as in the
  // dictionary; walking the dictionary's own entries cannot.
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4])],
    [4, annot({ author: "(Alice)", contents: "(try writing /T (Bob) instead)" })],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].author, "Alice");
  assert.equal(threads[0].contents, "try writing /T (Bob) instead");
});

test("a page whose /Annots lists itself does not become its own comment", async () => {
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, "<< /Type /Page /Parent 2 0 R /Annots [3 0 R 4 0 R] >>"],
    [4, annot({ contents: "(the only one)" })],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].contents, "the only one");
});

test("an annotation that replies to itself is a root, not a lost comment", async () => {
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4])],
    [4, annot({ contents: "(self reply)", irt: 4 })],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].contents, "self reply");
});

test("the result does not carry the whole file back with it", async () => {
  // The parser used to return `originalBytes` — the entire PDF — for a
  // writer feature that was never built, pinning it in memory for as long as
  // the popup stayed open.
  const result = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4])],
    [4, annot({ contents: "(x)" })],
  ])));

  assert.equal(result.originalBytes, undefined);
  assert.equal(result.annotMeta, undefined);
  assert.equal(result.threads[0].deleted, undefined);
});
