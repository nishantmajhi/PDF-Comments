/*
 * Runs the real `pdf-parser.js` in a real browser.
 *
 * `review.md` asks whether `DecompressionStream` "behaves in a popup exactly as
 * it does in Node". The 88 Node checks run the real parser against real PDFs
 * built by `tests/pdfbuild.js`, but they run it on Node's implementation of that
 * API, and the comment at the call site asserts the two are alike rather than
 * demonstrating it. This demonstrates it: the same files, the same parser, the
 * same assertions, in Chrome.
 *
 * `pdf-parser.js` calls no `chrome.*` API, and `popup.html` loads it with a
 * plain classic script tag, so a plain page reproduces the conditions it runs
 * under. What this does *not* cover is the popup's own chrome wiring -- see the
 * note in `review.md`.
 *
 * Results go into a <div id="test-results"> as JSON.
 */

(function () {
  "use strict";

  const results = [];
  const record = (name, ok, detail) =>
    results.push(Object.assign({}, detail || {}, { name: name, ok: ok }));

  const publish = () => {
    const el = document.createElement("div");
    el.id = "test-results";
    el.textContent = JSON.stringify(results);
    document.body.appendChild(el);
  };

  function bytesFrom(base64) {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  async function main() {
    record(
      "the parser loaded from a classic script tag, as the popup loads it",
      typeof PDFParser !== "undefined" && typeof PDFParser.parse === "function",
      { type: typeof PDFParser },
    );

    record(
      "this browser has DecompressionStream",
      typeof DecompressionStream === "function",
      { type: typeof DecompressionStream },
    );

    if (typeof PDFParser === "undefined") {
      publish();
      return;
    }

    /*
     * Each case names the threads the Node suite asserts for the same bytes.
     * Comparing against those strings rather than against "some comments came
     * out" is the point: a parser that silently found nothing inside a
     * compressed object stream is exactly the bug, and it reports as success.
     */
    for (const testCase of window.__fixtures.cases) {
      const label = testCase.name;
      try {
        const bytes = bytesFrom(testCase.base64);
        const parsed = await PDFParser.parse(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        );
        const got = (parsed.threads || []).map((t) => ({
          author: t.author,
          contents: t.contents,
          page: t.page,
        }));
        const same = JSON.stringify(got) === JSON.stringify(testCase.expected);
        record(label, same, {
          got: got,
          expected: testCase.expected,
        });
      } catch (err) {
        record(label, false, { error: String((err && err.stack) || err) });
      }
    }

    publish();
  }

  main().catch((err) => {
    record("driver", false, { error: String((err && err.stack) || err) });
    publish();
  });
})();
