# PDF Comments

A browser extension that lists the comments in the PDF you are looking at.

Open a PDF in a browser tab, click the toolbar icon, and the annotations
people have left in it — sticky notes, highlights with a note attached,
replies — appear in a panel, grouped by page and threaded under whatever they
reply to. Click a page number to jump there.

Nothing leaves your machine. The extension reads the bytes of the PDF the tab
already has, parses them locally, and shows the result. There is no server, no
account and no telemetry.

---

## Why it exists

Browsers render PDFs but do not show you their annotations. Chrome's built-in
viewer draws highlight marks and sticky-note icons on the page but gives you
no way to read the thread, filter by who wrote it, or search the text of the
comments. Getting at those means opening the file in Acrobat or uploading it
somewhere. This extension is the small version of that: a read-only view of
the comment layer, in the browser, offline.

---

## Installing

There is no build step. The extension is plain HTML, CSS and JavaScript with
no dependencies and no bundler; the folder you clone is the extension.

```bash
git clone https://github.com/nishantmajhi/PDF-Comments.git
```

**Chrome, Edge, Brave, and other Chromium browsers**

1. Go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the cloned folder.
4. Pin the icon to the toolbar.

To read PDFs stored on disk rather than fetched over the web, also turn on
**Allow access to file URLs** on the extension's entry in `chrome://extensions`.

**Firefox** loads it from `about:debugging#/runtime/this-firefox` →
**Load Temporary Add-on** → select `manifest.json`. It works, but the page-jump
button relies on Chrome's viewer honouring a `#page=` URL and does not move
Firefox's viewer.

---

## Using it

Open a PDF and click the icon. A blue dot on the icon means the tab holds a
PDF and there is something to click.

- **Search** filters to comments whose author, subject, body or replies
  contain what you type.
- **Author chips** filter to one person; click the chip again to clear it.
- **Sort** switches between page order and newest-first.
- **The page pill** on a comment jumps the PDF to that page.

---

## What it can read

Annotation types recognised as comments:

| | |
| --- | --- |
| `Text` | sticky note |
| `FreeText` | text typed onto the page |
| `Highlight`, `Underline`, `StrikeOut` | text markup, when a note is attached |
| `Square`, `Circle` | shape markup, when a note is attached |
| `Ink` | freehand drawing, when a note is attached |
| `Stamp` | stamp, when a note is attached |
| `Caret` | insertion mark |

Markup with no author and no text is skipped — a highlight on its own is a
decoration, not a comment. `Popup` and `Widget` annotations are skipped too:
the first is the viewer's own note window, the second is a form field.

Replies are threaded using `/IRT`. A reply whose parent was skipped is shown
as a comment in its own right rather than disappearing with it.

Compressed files are handled. Since PDF 1.5, most writers — Word, recent
Acrobat, LibreOffice, Chrome's own "print to PDF" — pack the document
structure and the annotations into Flate-compressed object streams rather than
writing them out plainly. Those are inflated using the browser's own
`DecompressionStream`, so no compression library is bundled.

### What it cannot read

- **Encrypted PDFs.** Password-protected files, and files with an owner
  password set to restrict printing or copying, keep their strings encrypted.
  Nothing here decrypts them.
- **Object streams using a filter other than Flate** — LZW, or a filter chain.
  These are rare.
- **Annotations added by the viewer but never saved back into the file.** If a
  comment only exists in Acrobat's local copy, it is not in the bytes the
  browser has.

The parser counts the object streams it could not decode and returns that
alongside the comments, so "this file has no comments" can be told apart from
"this file could not be read".

---

## How it works

One job per file.

```
manifest.json    MV3 manifest
background.js    service worker: the dot on the toolbar icon
popup.html/css   the panel
popup.js         fetches the PDF bytes, renders, filters, sorts
pdf-parser.js    bytes in, comment threads out — no DOM, no chrome API
tests/           node --test suite, no framework, no dependencies
```

**Getting the bytes.** The popup fetches the tab's URL itself, with
credentials, so that a PDF behind a login works. If that fetch is refused —
a cross-origin redirect, a CORS policy — it falls back to running the fetch
inside the tab via `chrome.scripting` and transferring the result back in
512 KB base64 chunks.

**Parsing.** `pdf-parser.js` is deliberately self-contained: it takes an
`ArrayBuffer` and returns `{ threads, unreadableObjectStreams }`, touching no
browser API beyond `TextDecoder` and `DecompressionStream`. That is what makes
it testable, and it is where all the difficulty lives:

1. Scan the file for `N G obj` definitions, stepping over stream data and over
   literal strings rather than searching through them. Compressed bytes
   eventually contain the sequence `endobj`, and a comment can perfectly well
   contain the word "stream".
2. Inflate every `/Type /ObjStm` and add the objects packed inside it.
3. Walk the `/Pages` tree from the catalog to get pages in document order,
   with a visited set and a depth cap, because the input is arbitrary files
   from the open web.
4. Read each page's `/Annots` array. That is the authoritative page
   attribution; `/P` back-references are often absent and object numbers are
   not page order.
5. Parse each annotation dictionary and thread the replies.

The cross-reference table is not consulted. In damaged and incrementally
updated files it is the first thing to go stale, and scanning finds objects a
correct xref walk would miss. The cost is that when an object number is
defined twice there is no xref to say which is live, so the parser applies the
rule that matches how files grow: a plainly written object beats a copy inside
an object stream.

**Permissions.** `activeTab`, `scripting` and `tabs` are for reading the
current tab's URL and running the fallback fetch inside it. `host_permissions`
is `<all_urls>` because a PDF can be hosted anywhere and the popup fetches it
directly. There is no content script: nothing is injected into pages you
visit, only into the tab you have explicitly opened the popup on.

---

## Tests

```bash
node --test "tests/*.test.js"
```

No framework and no dependencies — Node's own test runner against the same
files the browser loads. 88 checks covering the parser (structure, threading,
page attribution, string and date decoding, compressed object streams,
malformed input) and the service worker's badge logic.

`tests/pdfbuild.js` assembles fixture PDFs byte by byte, because the
interesting cases — a cyclic page tree, a comment containing a closing
parenthesis, an author name in UTF-16, an object stream — are not ones you can
produce by exporting from Word. `tests/harness.js` stands up enough of the
`chrome` namespace in a `node:vm` context to load and drive the real service
worker.

---

## Contributing

Keep it dependency-free and offline: no bundler, no network calls, no
third-party libraries. Match the existing style — plain JavaScript, no
frameworks.

If you are fixing a parser bug, add a fixture to `tests/` that reproduces it
and check that the test fails before your fix and passes after. A test that
passes against the unfixed code is testing nothing.

---

## License

Free for personal, non-commercial use. You may use, study and modify this
software for yourself, but you may not use it commercially, and you may not
share or publish it, in its original form or modified. See [LICENSE](LICENSE)
for the full terms.
