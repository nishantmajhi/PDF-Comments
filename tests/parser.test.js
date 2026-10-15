/* Core parsing: which annotations are found, which page they land on, and
 * how replies are threaded under their parents. */

const test = require("node:test");
const assert = require("node:assert/strict");

const PDFParser = require("../pdf-parser.js");
const { buildPdf, toArrayBuffer, catalog, pagesNode, page, annot } = require("./pdfbuild.js");

/** Build, parse, and hand back the thread roots. */
async function parseObjects(objects, opts) {
  return PDFParser.parse(toArrayBuffer(buildPdf(objects, opts)));
}

/** Every annotation in the result, roots and replies alike, page order. */
function flatten(threads) {
  const out = [];
  for (const t of threads) {
    out.push(t);
    for (const r of t.replies) out.push(r);
  }
  return out;
}

test("a one-page PDF with one sticky note yields one comment", async () => {
  const { threads } = await parseObjects([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4])],
    [4, annot({ author: "(Alice)", contents: "(Looks good to me)" })],
  ]);

  assert.equal(threads.length, 1);
  assert.equal(threads[0].author, "Alice");
  assert.equal(threads[0].contents, "Looks good to me");
  assert.equal(threads[0].subtype, "Text");
  assert.equal(threads[0].page, 1);
});

test("page numbers come from the /Kids order, not the object numbers", async () => {
  // Object 3 is the *second* page and object 5 is the first. A parser that
  // sorted by object number would swap them.
  const { threads } = await parseObjects([
    [1, catalog()],
    [2, pagesNode([5, 3])],
    [3, page([4])],
    [4, annot({ contents: "(on the second page)" })],
    [5, page([6])],
    [6, annot({ contents: "(on the first page)" })],
  ]);

  const byText = Object.fromEntries(threads.map((t) => [t.contents, t.page]));
  assert.equal(byText["on the first page"], 1);
  assert.equal(byText["on the second page"], 2);
});

test("a nested /Pages tree is flattened in document order", async () => {
  const { threads } = await parseObjects([
    [1, catalog()],
    [2, pagesNode([10, 11], { count: 3 })],
    [10, pagesNode([3, 5], { count: 2 })],
    [11, pagesNode([7], { count: 1 })],
    [3, page([4], { parent: 10 })],
    [4, annot({ contents: "(first)" })],
    [5, page([6], { parent: 10 })],
    [6, annot({ contents: "(second)" })],
    [7, page([8], { parent: 11 })],
    [8, annot({ contents: "(third)" })],
  ]);

  const byText = Object.fromEntries(threads.map((t) => [t.contents, t.page]));
  assert.deepEqual(byText, { first: 1, second: 2, third: 3 });
});

test("replies are nested under the annotation they answer", async () => {
  const { threads } = await parseObjects([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4, 5, 6])],
    [4, annot({ author: "(Alice)", contents: "(Is this right?)" })],
    [5, annot({ author: "(Bob)", contents: "(Yes)", irt: 4 })],
    [6, annot({ author: "(Carol)", contents: "(Agreed)", irt: 4 })],
  ]);

  assert.equal(threads.length, 1, "replies must not appear as roots");
  assert.equal(threads[0].author, "Alice");
  assert.deepEqual(threads[0].replies.map((r) => r.author), ["Bob", "Carol"]);
});

test("a reply whose parent was skipped is promoted to a root", async () => {
  // Object 4 is a Popup — not a comment type — so nothing threads under it.
  const { threads } = await parseObjects([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4, 5])],
    [4, annot({ subtype: "Popup", author: "(Alice)", contents: "(ignored)" })],
    [5, annot({ author: "(Bob)", contents: "(orphan reply)", irt: 4 })],
  ]);

  assert.equal(threads.length, 1);
  assert.equal(threads[0].contents, "orphan reply");
});

test("Popup and Widget annotations are skipped", async () => {
  const { threads } = await parseObjects([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4, 5, 6])],
    [4, annot({ subtype: "Popup", contents: "(popup)" })],
    [5, annot({ subtype: "Widget", contents: "(form field)" })],
    [6, annot({ subtype: "Highlight", contents: "(a real one)" })],
  ]);

  assert.deepEqual(threads.map((t) => t.contents), ["a real one"]);
});

test("Square and Circle annotations are treated as comments", async () => {
  // COMMENT_TYPES has always listed them; the fallback scan and the README
  // did not. All three should now agree.
  const { threads } = await parseObjects([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4, 5])],
    [4, annot({ subtype: "Square", contents: "(boxed)" })],
    [5, annot({ subtype: "Circle", contents: "(circled)" })],
  ]);

  assert.deepEqual(threads.map((t) => t.subtype).sort(), ["Circle", "Square"]);
});

test("an annotation with neither author nor text is dropped", async () => {
  const { threads } = await parseObjects([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4, 5])],
    [4, annot({ subtype: "Highlight", author: null, contents: "()" })],
    [5, annot({ subtype: "Highlight", author: "(Alice)", contents: "()" })],
  ]);

  assert.equal(threads.length, 1, "a bare highlight with no note is not a comment");
  assert.equal(threads[0].author, "Alice");
});

test("an /Annots array reached through an indirect reference still maps to its page", async () => {
  const { threads } = await parseObjects([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots 9 0 R >>"],
    [9, "[ 4 0 R ]"],
    [4, annot({ contents: "(indirect annots)" })],
  ]);

  assert.equal(threads.length, 1);
  assert.equal(threads[0].page, 1);
});

test("an annotation no page claims is still reported, with page null", async () => {
  const { threads } = await parseObjects([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([])],
    [4, annot({ contents: "(stranded)" })],
  ]);

  assert.equal(threads.length, 1);
  assert.equal(threads[0].page, null);
});

test("comments are ordered by page, then by date", async () => {
  const { threads } = await parseObjects([
    [1, catalog()],
    [2, pagesNode([3, 5])],
    [3, page([7, 8])],
    [5, page([9])],
    [7, annot({ contents: "(page 1, later)", date: "20240102000000Z" })],
    [8, annot({ contents: "(page 1, earlier)", date: "20240101000000Z" })],
    [9, annot({ contents: "(page 2)", date: "20200101000000Z" })],
  ]);

  assert.deepEqual(threads.map((t) => t.contents), [
    "page 1, earlier",
    "page 1, later",
    "page 2",
  ]);
});

test("/C colour arrays become CSS rgb() strings", async () => {
  const { threads } = await parseObjects([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4, 5, 6])],
    [4, annot({ contents: "(rgb)", extra: "/C [1 0 0]" })],
    [5, annot({ contents: "(grey)", extra: "/C [0.5]" })],
    [6, annot({ contents: "(none)" })],
  ]);

  const byText = Object.fromEntries(flatten(threads).map((t) => [t.contents, t.color]));
  assert.equal(byText.rgb, "rgb(255,0,0)");
  assert.equal(byText.grey, "rgb(128,128,128)");
  assert.equal(byText.none, null);
});

test("a PDF with no catalog still finds its pages", async () => {
  const { threads } = await parseObjects([
    [2, pagesNode([3])],
    [3, page([4])],
    [4, annot({ contents: "(no catalog)" })],
  ]);

  assert.equal(threads.length, 1);
  assert.equal(threads[0].page, 1);
});

test("a PDF with no annotations at all parses to nothing, not an error", async () => {
  const { threads } = await parseObjects([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([])],
  ]);

  assert.deepEqual(threads, []);
});
