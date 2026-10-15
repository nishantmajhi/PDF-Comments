/* String, date and dictionary decoding.
 *
 * Everything the user actually reads — the author's name, the text of the
 * comment, the timestamp — comes out of these three functions, so they get
 * tested directly rather than through a whole file.
 *
 * A note on backslashes: PDF escapes and JavaScript escapes use the same
 * character, and it is very easy to write a test whose JavaScript literal
 * has already done the decoding the parser was supposed to do. The helper
 * `lit()` below builds the raw bytes from character codes so that what the
 * parser sees is unambiguous.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const PDFParser = require("../pdf-parser.js");
const { buildPdf, toArrayBuffer, catalog, pagesNode, page, annot } = require("./pdfbuild.js");
const { decodePDFString, parsePDFDate, extractDictValue } = PDFParser;

const BS = String.fromCharCode(0x5c); // a single backslash, unambiguously

/** Build a PDF literal string, writing `\` as BS so the source stays readable. */
function lit(inner) {
  return "(" + inner + ")";
}

/** One annotation, parsed; returns the single thread root. */
async function parseOneAnnot(fields) {
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4])],
    [4, annot(fields)],
  ])));
  assert.equal(threads.length, 1, "fixture should produce exactly one comment");
  return threads[0];
}

/* ── Literal strings ─────────────────────────────────────────────── */

test("a plain literal string decodes as itself", () => {
  assert.equal(decodePDFString("(hello)"), "hello");
});

test("escaped delimiters decode to bare parentheses", () => {
  assert.equal(decodePDFString(lit("a" + BS + "(b" + BS + ")c")), "a(b)c");
});

test("escaped control characters decode", () => {
  assert.equal(decodePDFString(lit("line1" + BS + "nline2")), "line1\nline2");
  assert.equal(decodePDFString(lit("tab" + BS + "there")), "tab\there");
  assert.equal(decodePDFString(lit("a" + BS + "rb")), "a\rb");
});

test("a doubled backslash decodes to one backslash", () => {
  assert.equal(decodePDFString(lit("back" + BS + BS + "slash")), "back" + BS + "slash");
});

test("a comment containing balanced parentheses is not truncated", async () => {
  // PDF literal strings may contain unescaped parens so long as they balance,
  // and writers do emit them. The old regex stopped at the first `)`.
  const c = await parseOneAnnot({ contents: "(fix this (see above) please)" });
  assert.equal(c.contents, "fix this (see above) please");
});

test("nested balanced parentheses survive", async () => {
  const c = await parseOneAnnot({ contents: "(a (b (c) d) e)" });
  assert.equal(c.contents, "a (b (c) d) e");
});

test("an escaped closing paren does not end the string early", async () => {
  const c = await parseOneAnnot({ contents: lit("smiley " + BS + ") end") });
  assert.equal(c.contents, "smiley ) end");
});

test("a following dictionary key is not swallowed into the string", async () => {
  // The risk in a paren-depth scanner is the mirror image of the old bug:
  // running past the real end of the string and eating the rest of the dict.
  const c = await parseOneAnnot({ author: "(Alice)", contents: "(short)" });
  assert.equal(c.author, "Alice");
  assert.equal(c.contents, "short");
});

test("three-digit octal escapes decode to their characters", () => {
  // \251 is the copyright sign in PDFDocEncoding and Latin-1 alike.
  assert.equal(decodePDFString(lit("Copyright " + BS + "251 2024")), "Copyright © 2024");
  assert.equal(decodePDFString(lit(BS + "101" + BS + "102" + BS + "103")), "ABC");
});

test("one- and two-digit octal escapes decode too", () => {
  assert.equal(decodePDFString(lit("null" + BS + "0end")), "null" + String.fromCharCode(0) + "end");
  assert.equal(decodePDFString(lit(BS + "53")), "+");
});

test("an octal escape stops after three digits", () => {
  // \0601 is character \060 ('0') followed by the digit '1', not \0601.
  assert.equal(decodePDFString(lit(BS + "0601")), "01");
});

test("a backslash before a newline continues the line", () => {
  assert.equal(decodePDFString(lit("one" + BS + "\ntwo")), "onetwo");
});

test("an unknown escape drops the backslash, per the spec", () => {
  assert.equal(decodePDFString(lit("a" + BS + "qb")), "aqb");
});

test("a literal string holding UTF-8 bytes is decoded as UTF-8", async () => {
  // "café" as UTF-8: 63 61 66 C3 A9
  const c = await parseOneAnnot({ author: "(caf\xC3\xA9)", contents: "(x)" });
  assert.equal(c.author, "café");
});

test("a literal string holding Latin-1 bytes is not mangled", async () => {
  // The same word in PDFDocEncoding: 63 61 66 E9, which is not valid UTF-8.
  const c = await parseOneAnnot({ author: "(caf\xE9)", contents: "(x)" });
  assert.equal(c.author, "café");
});

/* ── Hex strings ─────────────────────────────────────────────────── */

test("a plain hex string decodes byte by byte", () => {
  assert.equal(decodePDFString("<48656C6C6F>"), "Hello");
});

test("a UTF-16BE hex string with a BOM decodes as UTF-16", () => {
  assert.equal(decodePDFString("<FEFF0041006C0069006300650301>"), "Alicé");
});

test("a UTF-16BE surrogate pair round-trips", () => {
  // U+1F44D THUMBS UP = D83D DC4D
  assert.equal(decodePDFString("<FEFFD83DDC4D>"), "\u{1F44D}");
});

test("whitespace inside a hex string is ignored", () => {
  assert.equal(decodePDFString("<48 65 6C\n6C 6F>"), "Hello");
});

test("an odd-length hex string is padded with a trailing zero, per the spec", () => {
  // <4A4> means bytes 4A 40, i.e. "J@" — not 4A 04.
  assert.equal(decodePDFString("<4A4>"), "J@");
});

test("a hex string holding UTF-8 bytes is decoded as UTF-8", () => {
  // No BOM, so these are 8-bit bytes: 63 61 66 C3 A9
  assert.equal(decodePDFString("<636166C3A9>"), "café");
});

test("a UTF-16 author name reaches the comment intact", async () => {
  const c = await parseOneAnnot({ author: "<FEFF004A006F00E9>", contents: "(hi)" });
  assert.equal(c.author, "Joé");
});

/* ── Dates ───────────────────────────────────────────────────────── */

test("a full PDF date parses to the right instant", () => {
  const d = parsePDFDate("D:20240115143000Z");
  assert.equal(d.toISOString(), "2024-01-15T14:30:00.000Z");
});

test("a positive UTC offset is applied, not discarded", () => {
  // 14:30 at +05'30' is 09:00 UTC. Ignoring the offset gave local time.
  const d = parsePDFDate("D:20240115143000+05'30'");
  assert.equal(d.toISOString(), "2024-01-15T09:00:00.000Z");
});

test("a negative UTC offset is applied", () => {
  const d = parsePDFDate("D:20240115143000-08'00'");
  assert.equal(d.toISOString(), "2024-01-15T22:30:00.000Z");
});

test("an offset written without the apostrophes is still read", () => {
  const d = parsePDFDate("D:20240115143000+0530");
  assert.equal(d.toISOString(), "2024-01-15T09:00:00.000Z");
});

test("a date with no zone is read as local time, as the spec says", () => {
  const d = parsePDFDate("D:20240115143000");
  assert.equal(d.getFullYear(), 2024);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 15);
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 30);
});

test("a truncated date fills the missing fields", () => {
  const d = parsePDFDate("D:2024");
  assert.equal(d.getFullYear(), 2024);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 1);
});

test("nonsense is not a date", () => {
  assert.equal(parsePDFDate("D:notadate"), null);
  assert.equal(parsePDFDate(""), null);
  assert.equal(parsePDFDate(null), null);
});

/* ── Dictionary lookup ───────────────────────────────────────────── */

test("a key lookup does not match a longer key that starts the same way", () => {
  // /T must not be answered by /Type, and /M must not be answered by /MediaBox.
  const dict = "<< /Type /Annot /Subtype /Text /T (Alice) /MediaBox [0 0 1 1] /M (D:20240101000000Z) >>";
  assert.equal(extractDictValue(dict, "T"), "(Alice)");
  assert.equal(extractDictValue(dict, "M"), "(D:20240101000000Z)");
});

test("a key with no space before its value is still found", () => {
  // Writers routinely omit the space: /T(Alice)/Contents(hi)
  const dict = "<</Type/Annot/Subtype/Text/T(Alice)/Contents(hi)>>";
  assert.equal(extractDictValue(dict, "T"), "(Alice)");
  assert.equal(extractDictValue(dict, "Contents"), "(hi)");
});

test("a missing key is null", () => {
  assert.equal(extractDictValue("<< /Type /Annot >>", "Contents"), null);
});

test("an annotation written without spaces still parses end to end", async () => {
  const { threads } = await PDFParser.parse(toArrayBuffer(buildPdf([
    [1, "<</Type/Catalog/Pages 2 0 R>>"],
    [2, "<</Type/Pages/Kids[3 0 R]/Count 1>>"],
    [3, "<</Type/Page/Parent 2 0 R/Annots[4 0 R]>>"],
    [4, "<</Type/Annot/Subtype/Text/T(Alice)/Contents(compact)>>"],
  ])));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].author, "Alice");
  assert.equal(threads[0].contents, "compact");
  assert.equal(threads[0].page, 1);
});
