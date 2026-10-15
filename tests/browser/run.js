/*
 * Runs the real parser, on real PDFs, in a real browser.
 *
 * `review.md` records that the parser is covered by 88 checks under
 * `node --test` but that nothing here could confirm "that
 * `DecompressionStream` behaves in a popup exactly as it does in Node". The
 * comment at the call site in `pdf-parser.js` asserts the two are alike; this
 * demonstrates it, which is a different thing.
 *
 * It needs no extension host. `pdf-parser.js` calls no `chrome.*` API and
 * `popup.html` loads it with a plain classic script tag, so a minimal page with
 * the same tag reproduces the conditions it runs under. The files are built here
 * by `tests/pdfbuild.js` -- the same builder the Node suite uses -- and handed
 * to the page as base64 together with the threads each one must produce. The
 * first case is `objstm.test.js`'s headline test byte for byte; the other two
 * are built in the same style here.
 *
 * Comparing against those threads rather than against "some comments came out"
 * is the whole point. The bug this project existed to fix was a parser that
 * found nothing inside a compressed object stream, and "nothing" is a perfectly
 * successful-looking result.
 *
 * What this does NOT cover: the popup's own chrome wiring, the service worker,
 * and whether removing the content script broke anything. Those still want a
 * person with a browser -- see `review.md`.
 *
 * With no browser installed this exits 0 and says SKIP.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");

const {
  buildPdf,
  objectStream,
  catalog,
  pagesNode,
  page,
  annot,
} = require("../pdfbuild.js");

const CANDIDATES = [
  process.env.PDFCOMMENTS_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function findBrowser() {
  for (const candidate of CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not there */
    }
  }
  return null;
}

/*
 * The cases, each with the threads it must produce.
 *
 * The first is `objstm.test.js`'s "annotations inside a compressed object stream
 * are found", reproduced exactly -- the headline path, where every object
 * including the annotation is inside a Flate stream and nothing is visible in
 * the raw bytes. The second is the hybrid shape that test file also covers,
 * structure compressed and the annotation added later by an incremental update
 * and written out plainly, though the names here are this file's own. The third
 * is an uncompressed file, so that a failure in the first two can be read as
 * "the decompression" rather than "the parser".
 */
function cases() {
  const compressed = buildPdf([
    [
      9,
      objectStream([
        [1, catalog()],
        [2, pagesNode([3])],
        [3, page([4])],
        [4, annot({ author: "(Alice)", contents: "(compressed comment)" })],
      ]),
    ],
  ]);

  const hybrid = buildPdf([
    [
      9,
      objectStream([
        [1, catalog()],
        [2, pagesNode([3])],
        [3, page([4])],
      ]),
    ],
    [4, annot({ author: "(Bob)", contents: "(added later)" })],
  ]);

  const plain = buildPdf([
    [1, catalog()],
    [2, pagesNode([3])],
    [3, page([4])],
    [4, annot({ author: "(Carol)", contents: "(uncompressed comment)" })],
  ]);

  return [
    {
      name: "a comment inside a compressed object stream is found",
      base64: Buffer.from(compressed).toString("base64"),
      expected: [{ author: "Alice", contents: "compressed comment", page: 1 }],
    },
    {
      name: "a hybrid file's plainly-written comment is found",
      base64: Buffer.from(hybrid).toString("base64"),
      expected: [{ author: "Bob", contents: "added later", page: 1 }],
    },
    {
      name: "an uncompressed file still parses",
      base64: Buffer.from(plain).toString("base64"),
      expected: [{ author: "Carol", contents: "uncompressed comment", page: 1 }],
    },
  ];
}

/*
 * A minimal page that loads the parser exactly as `popup.html` does: one
 * classic script tag, same file, no bundler and no module wrapper. The tag is
 * read out of the real `popup.html` rather than written here, so that if the
 * popup ever starts loading the parser some other way this stops matching and
 * the mismatch is reported.
 */
const PARSER_TAG = '<script src="pdf-parser.js"></script>';

function stage(fixtures) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfcomments-browser-"));
  fs.copyFileSync(
    path.join(ROOT, "pdf-parser.js"),
    path.join(dir, "pdf-parser.js"),
  );
  fs.copyFileSync(path.join(__dirname, "driver.js"), path.join(dir, "driver.js"));
  fs.writeFileSync(
    path.join(dir, "fixtures.js"),
    "window.__fixtures = " + JSON.stringify(fixtures) + ";\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "host.html"),
    "<!doctype html>\n<meta charset=\"utf-8\">\n<title>parser host</title>\n<body>\n" +
      PARSER_TAG +
      '\n<script src="fixtures.js"></script>\n<script src="driver.js"></script>\n',
    "utf8",
  );
  return path.join(dir, "host.html");
}

function run(browser, pageFile) {
  const profile = path.join(path.dirname(pageFile), "profile");
  const result = spawnSync(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--disable-extensions",
      "--user-data-dir=" + profile,
      "--virtual-time-budget=60000",
      "--dump-dom",
      "file:///" + pageFile.replace(/\\/g, "/"),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180000 },
  );

  if (result.error) throw result.error;
  const dom = result.stdout || "";
  const match = dom.match(/<div id="test-results">([\s\S]*?)<\/div>/);
  if (!match) {
    throw new Error(
      "the page produced no results. Last of the dumped DOM:\n" +
        dom.slice(-1500) +
        "\n--- stderr ---\n" +
        (result.stderr || "").slice(-1500),
    );
  }
  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return JSON.parse(decoded);
}

function main() {
  let failed = 0;
  const report = (name, ok, why) => {
    if (ok) {
      console.log("  ok   " + name);
    } else {
      failed++;
      console.log("  FAIL " + name + (why ? "\n       " + why : ""));
    }
  };

  /* The assumption this approach rests on, so it cannot rot silently. */
  const popup = fs.readFileSync(path.join(ROOT, "popup.html"), "utf8");
  report(
    "popup.html still loads the parser with the tag this run reproduces",
    popup.includes(PARSER_TAG),
    "popup.html no longer contains " + PARSER_TAG,
  );

  const parserSource = fs.readFileSync(path.join(ROOT, "pdf-parser.js"), "utf8");
  report(
    "the parser calls no chrome.* API, so it runs in a plain page",
    !/\bchrome\s*\./.test(parserSource),
    "it does reference chrome.*, so a plain page is no longer equivalent",
  );

  const browser = findBrowser();
  if (!browser) {
    console.log("SKIP: no Chrome or Edge found. Set PDFCOMMENTS_BROWSER to one.");
    return failed === 0 ? 0 : 1;
  }
  console.log("browser: " + browser);

  for (const r of run(browser, stage({ cases: cases() }))) {
    report(
      r.name,
      r.ok,
      r.error ||
        (r.got
          ? "expected " + JSON.stringify(r.expected) + ", got " + JSON.stringify(r.got)
          : null),
    );
  }

  console.log(
    failed === 0 ? "\nbrowser: all checks passed" : "\nbrowser: " + failed + " failed",
  );
  return failed === 0 ? 0 : 1;
}

process.exit(main());
