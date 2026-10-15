# Code Review — PDF Comments

First reviewed 2026-09-04. **Remediated 2026-09-17** on branch
`cleanup/2026-09-17`; this file is now a record of that pass rather than a
to-do list. The original review is kept below, annotated.

---

## What was done

Every P1, P2 and P3 on the original checklist is closed except one item that
needs a browser to decide, which is recorded under "Deliberately not done".

**88 tests, no framework, no dependencies**: `node --test "tests/*.test.js"`.
35 of them fail against the original `pdf-parser.js` and 2 against the
original `background.js`; the rest are characterisation tests that hold in
both. Every fix below was written against a test that failed first.

### The parser was rewritten around a tokenizer

The original read dictionaries with one regular expression per key. That is
the root cause of four separate findings in the review — the truncated
parenthesis, the `/T`-versus-`/Type` confusion, the missing-space case, and
the octal escapes — so rather than patch each, `pdf-parser.js` now has a small
PDF object scanner: `readValue` reads one object of any type, `parseDict`
walks a dictionary's own top-level entries, and everything else asks those.

A regex cannot tell a `/T` key from the `/T` in `/Type`, nor a `/Contents` key
from the characters `/Contents` inside somebody's comment text. A scanner can,
and a test now pins that: a comment reading `try writing /T (Bob) instead` no
longer overrides the real author.

### P1 — compressed object streams

Implemented rather than merely reported. `scanObjects` now records stream
objects with the byte range of their data; `expandObjectStreams` inflates
every `/Type /ObjStm` with `DecompressionStream` — available in the popup and
in Node alike, so no inflate library is bundled — and unpacks the objects
inside. Flate with no predictor is handled, which is what writers actually
emit; LZW, filter chains and predictors are not, and are counted.

`parse()` now returns `{ threads, unreadableObjectStreams }`. The count lets
"this file has no comments" be told apart from "this file could not be read".
**The popup does not use it yet** — see "Deliberately not done".

The scan itself had to change to make this safe. Compressed bytes are
arbitrary and will eventually contain the sequence `endobj`, or worse
`3 0 obj`, and the original whole-file regex would truncate an object at the
first and let the second silently overwrite a real page. Both are now tests.

### P1 — cycle and depth protection

`collectPageObjNums.walk` takes a visited set and a depth cap of 256. A
`/Kids` entry pointing back at its own parent used to recurse until the stack
was exhausted and the popup showed an error instead of the comments. A
five-thousand-deep tree does the same without any cycle at all. Both are
tests, and both threw `RangeError` against the original code.

The visited set also fixes a quieter bug: a page reachable through two
branches of the tree was counted twice, shifting every page number after it.

### P1 — one-pass decoding

`text += String.fromCharCode(bytes[i])` over the whole file is replaced by a
latin-1 `TextDecoder`. Measured on this machine: 12 MB takes 1008 ms the old
way and 43 ms the new one, and the old way builds the string through forty
million concatenations while holding the file twice over.

A note correcting the original review: it says this "freezes the popup", which
overstates it. A second of blocked main thread on a large file is bad and
worth fixing, but it is not a hang, and at typical PDF sizes it was tens of
milliseconds. The memory cost was the bigger half.

### P2 — the writer scaffolding is gone

`findObjectMeta`, `annotMeta`, `originalBytes` and the per-annotation
`deleted` flag are deleted. Nothing read any of them. That removes a second
whole-file regex scan from every parse and stops the entire PDF being pinned
in memory for as long as the popup stays open. A test asserts the result no
longer carries them.

Two more pieces of dead state went with them: `state.pdfKey` and
`state.fileName` in `popup.js`, with the two functions that computed them.
Nothing read those either.

### P2 — permissions

The `<all_urls>` content script is gone from `manifest.json` and `content.js`
is deleted. It was thirteen lines handling one message type that nothing ever
sent, and its cost was injecting a script into every page the user visits.
The `web_accessible_resources` entry exposing `pdf-parser.js` is gone too;
nothing loaded it from a page, and the only effect was letting any website
fingerprint that this extension is installed.

`host_permissions: ["<all_urls>"]` stays. The popup fetches the PDF itself and
a PDF can be hosted anywhere, so this one is load-bearing.

### P2 — the dead message paths

Both halves of the `SCROLL_TO_PAGE` design are removed: the listener in
`background.js` and the one in the deleted `content.js`. The popup has done
the navigation itself since some earlier change, and nothing sent the message.
A test asserts the worker registers no message listener — an MV3 worker with
an `onMessage` listener is kept alive for an event that never arrives.

### P3 — the rest

- **Literal strings** are read with a paren-depth scanner, so
  `fix this (see above) please` survives.
- **Octal escapes** (`\251`, `\53`, `\0`) decode, stopping after three digits.
  Line continuations and unknown escapes follow the spec.
- **Dates** apply their UTC offset. `D:20240115143000+05'30'` is 09:00 UTC,
  not 14:30 local — silently wrong by up to fourteen hours, and the wrong day
  for anything near midnight.
- **The page-type test** is `/Type` equal to `/Page` read from the parsed
  dictionary, so a Page whose dictionary is truncated right after `/Page` is
  still a Page. The old `/\/Type\s*\/Page[^s]/` needed a character after it.
- **Square and Circle** are in one list now, `COMMENT_TYPES`, from which the
  fallback scan's regular expression is built. The three places that used to
  disagree cannot any more, and the README's table matches.
- **`escape()`** is gone. Strings are decoded by trying strict UTF-8 and
  falling back to latin-1, which gets both the UTF-8 and the PDFDocEncoding
  case right instead of hiding the failure in a `try`/`catch`.
- **Hex strings** pad an odd trailing nibble with zero, per the spec, rather
  than parsing a one-character group as a whole byte.
- **`module.exports`** is kept and is now load-bearing: the tests run the same
  file the browser loads. The original review called it a leftover, which it
  was at the time.
- **`LICENSE`** added (MIT, matching what the README claimed).
- **The clone URL** is the real remote, `nishantmajhi/PDF-Comments`.
- **The README** is rewritten from first principles, including an honest
  account of what the parser cannot read.

### Two bugs the first review missed

Both were found while writing the fix, and both have regression tests.

1. **`chrome.runtime.lastError` was never read** in the `tabs.get` callback.
   A tab closing between a tab switch and the callback makes Chrome log the
   failure as unhandled.
2. **An annotation whose `/IRT` pointed at itself vanished from the output**
   entirely. It was filed as a reply to itself, so it never appeared as a
   root, and the result carried a self-referential cycle.

A third, checked and found not to be a bug: a page whose `/Annots` lists its
own object number does not become its own comment, because a Page dictionary
has no `/Subtype` and is filtered out anyway. The guard against it is now
explicit and tested, but nothing was broken.

### A bug introduced and caught by the tests

Worth recording because it is exactly the failure mode the new scanner was
meant to prevent. The first version of `scanObjects` looked for the `stream`
and `endobj` keywords anywhere after an object header. A comment reading
*"the video stream is corrupt"* then ended the object in the middle of its own
text. Both keyword searches now step over literal strings, and there is a test
named for it.

---

## Deliberately not done

**The page-jump reload** (`popup.js`, `scrollToPage`). It sets the URL hash,
waits 80 ms, and reloads the tab, which re-downloads the PDF and throws away
the viewer's zoom and scroll position. Chrome's built-in viewer usually
honours a `#page=` change without a reload, so this looks like a mistake — but
confirming which viewers need it takes a real browser, and removing it would
break page jumps outright in any that do. A comment saying so is now at the
call site. This is the one item on the original checklist still open.

**Surfacing `unreadableObjectStreams` in the popup.** The parser reports it;
the popup ignores it and still shows the plain "no comments found" panel. New
user-facing copy is outside the business-logic-only remit for this pass, and
the underlying problem — compressed files reading as empty — is now actually
fixed rather than merely explained. Wiring the count to a message is a small,
self-contained job for whoever wants it.

**Cross-reference streams.** Not read, by design; the reasoning is in the
header comment of `pdf-parser.js` and in the README. Scanning finds objects a
correct xref walk would miss in damaged files, and damaged files are the
common case here.

**Encryption.** Not implemented. An encrypted PDF's strings stay encrypted and
its comments will not appear. The README says so.

---

## Notes for a future session

**This has never been loaded into a browser, and item 1 below no longer needs
it.** Everything above is verified by `node --test`, which runs the real
`pdf-parser.js` and the real `background.js`. Two things were unverified end to
end:

1. ~~That `DecompressionStream('deflate')` behaves in a popup exactly as it does
   in Node.~~ **Confirmed in Chrome on 2026-09-24 — `node
   tests/browser/run.js`.** It does.
2. That removing the content script has not broken something not obvious from
   reading the code. It handled one message type that nothing sends, so this
   should be safe. **Still open**, and it still wants a person.

### How item 1 was closed without an extension host

`pdf-parser.js` calls **no `chrome.*` API**, and `popup.html` loads it with a
plain classic `<script>` tag — so a minimal page with the same tag reproduces
the conditions the parser runs under, and no extension needs loading. Both of
those facts are asserted by the run rather than assumed, because if either
stopped being true the run would quietly be testing something else.

Five checks. `tests/pdfbuild.js` — the Node suite's own builder — assembles the
files here, they go to the page as base64, and the page runs the real parser and
hands back the threads it found. Three files: the compressed object stream
(`objstm.test.js`'s headline case, reproduced exactly), the hybrid shape with the
annotation written plainly by an incremental update, and an uncompressed file so
that a failure in the first two reads as *the decompression* rather than *the
parser*.

**The assertion is the exact threads, not "some comments came out."** That
distinction is the whole reason this is worth running: the bug this project
existed to fix was a parser that found nothing inside an object stream, and
nothing is a perfectly successful-looking result.

**Everything passed, so it was shown to be capable of failing**, and the
demonstration is a good one. `inflate`'s format list was temporarily emptied, and
the compressed case came back `[]` — the silent "no comments found" that sent
users looking for a problem in their PDF — while the hybrid case kept its comment
but lost its **page number**, because the page tree was the part inside the
stream. The uncompressed case still passed. That is the original bug, in all
three of its shapes, reported precisely. Reverted.

### What still wants a person

Item 2 above, and the popup itself. This run covers the parser in a browser, not
the popup's chrome wiring, not the service worker, and not `scrollToPage`. The
ten-minute check is unchanged for those: load unpacked, open a PDF exported from
Word with a few comments in it, and confirm the comments appear with the right
page numbers. What it will no longer be discovering is whether decompression
works.

**The fixtures are the useful artefact.** `tests/pdfbuild.js` assembles PDFs
byte by byte — object streams, cyclic page trees, unterminated dictionaries,
binary decoys. Adding a case is three lines. If a real-world PDF ever turns up
that this parser mishandles, reproduce it there rather than committing the
PDF.

**`tests/harness.js`** is a cut-down version of the one in
`Browser Extensions/PrivatePages/tests/harness.js`. If another extension in
this archive needs to test a service worker, start from the PrivatePages one —
it is the fuller of the two.

---

---

# The original review, as written on 2026-09-04

Reviewed 2026-09-04 against the working tree. Scope: `manifest.json`, `popup.js`, `pdf-parser.js`,
`background.js`, `content.js`, `README.md`.

## What this project is

An MV3 extension that reads the PDF open in the current tab, parses its annotation objects with a
hand-written PDF parser, and lists the comments in the popup with search, author filtering, and
jump-to-page.

## Verdict

The UI layer is genuinely good — templates cloned from `<template>` elements, everything rendered
with `textContent`, no injection anywhere. Credit where it is due: the popup is the safest rendering
code in this whole archive. The parser is where the problems are, and the biggest one is that it
silently fails on a large fraction of modern PDFs. There is also a complete abandoned feature
("the writer") still being paid for on every parse.

## Critical issues

**1. The parser cannot read PDFs that use compressed object streams — which is most modern PDFs.**
`pdf-parser.js:65-71` finds objects by running the regex `/(\d+)\s+\d+\s+obj\s*([\s\S]*?)endobj/g`
over the raw file bytes. Since PDF 1.5 (2003), writers routinely pack indirect objects into
Flate-compressed `/Type /ObjStm` streams and use cross-reference streams instead of plain `xref`
tables. Word, recent Acrobat, LibreOffice and Chrome's own printer all do this. Those objects are
compressed binary — the regex cannot see them, so the annotations are invisible and the popup shows
"no comments found".

This also makes the README's troubleshooting section wrong: it tells the user "the PDF has no
embedded annotations", when the real cause is often that the PDF is simply compressed. Either
implement inflate for object streams (`DecompressionStream` is available in the popup and makes this
tractable without a dependency), or state the limitation honestly in the README and detect it — if
you find an `/ObjStm` or `/XRefStm` and zero annotations, say so specifically.

**2. Dead scaffolding from an abandoned "write comments back" feature, still costing a full extra
pass over the file.** `findObjectMeta()` (`pdf-parser.js:74-82`) runs a second whole-file regex scan
to build `annotMeta`, and `parse()` returns `annotMeta` plus `originalBytes` (the entire PDF held in
memory). Each annotation also carries a `deleted: false` field. Nothing in the extension reads any of
it — `popup.js:158-159` uses only `result.threads`. Delete `findObjectMeta`, `annotMeta`,
`originalBytes` and `deleted`; you halve the parse work and stop pinning the whole file in memory.

**3. Unbounded recursion on a malformed Pages tree.** `collectPageObjNums.walk()`
(`pdf-parser.js:104-116`) follows `/Kids` references with no visited-set and no depth limit. A PDF
whose page tree contains a cycle — corrupt or hostile — recurses until the stack blows. The input
here is arbitrary PDFs from the open web. Add a visited-object set and a depth cap.

**4. The whole file is turned into a JavaScript string one character at a time.**
`pdf-parser.js:226-228` loops over every byte doing `text += String.fromCharCode(bytes[i])`. For a
40 MB PDF this builds an 80 MB UTF-16 string via 40 million concatenations and freezes the popup.
One line fixes it: decode the bytes with a latin1 `TextDecoder`.

## Permissions — more than this extension needs

- **`host_permissions: ["<all_urls>"]` plus a content script matching `<all_urls>` at
  `document_idle`.** `content.js` is 13 lines and handles exactly one message type that is never
  sent (see below). So the extension currently injects a script into every page you visit for no
  functional reason. Drop the content script for Chrome, or scope it to the Firefox PDF.js viewer
  where it is actually needed.
- **`web_accessible_resources` exposes `pdf-parser.js` to `<all_urls>`.** Nothing loads it from a web
  page — the popup includes it directly. The only effect is that any website can probe for the file
  and fingerprint that you have this extension installed. Remove the entry.
- The popup fetches the PDF with credentials included (`popup.js:89`, and again inside the injected
  fallback). That is necessary for authenticated PDFs and is fine, but it is worth knowing that your
  cookies are attached.

## Dead message-passing paths

`background.js:40-56` listens for a scroll-to-page message and `content.js:7-12` listens for it too —
but `popup.js:167-178` performs the navigation itself with the tabs API, and nothing anywhere sends
that message. Both listeners are vestigial. Either route the popup through the background worker
(which was clearly the original design, and would keep the Firefox fallback alive) or delete both
handlers.

## Other parser bugs

- **Jumping to a page reloads the tab.** `popup.js:174-176` sets the URL hash, waits 80 ms, then
  reloads. That re-downloads the PDF and throws away the viewer's state on every page jump. Chrome's
  viewer honours a page-hash change without a reload in most cases; if the reload works around a
  specific failure, comment it, because it currently reads like a mistake.
- **Literal strings containing balanced parentheses are truncated.** The `Contents` pattern in
  `extractDictValue` (`pdf-parser.js:45`) stops at the first unescaped closing paren. PDF literal
  strings may legally contain balanced unescaped parens, so a comment reading "fix this (see above)
  please" is cut short. This needs a real paren-depth scanner rather than a regex.
- **Octal escapes in literal strings are not decoded.** `decodePDFString` handles the common
  backslash escapes but leaves three-digit octal escapes as raw text.
- **Timezone offsets in dates are discarded.** `parsePDFDate` (`:54-62`) reads the first fourteen
  digits and ignores the trailing UTC offset, so every timestamp is interpreted as local time and can
  be hours off.
- **The page-type regex fails when the object body ends immediately after the type name.**
  `/\/Type\s*\/Page[^s]/` requires a following character; a negative lookahead is the correct form.
- **Inconsistent type lists.** `COMMENT_TYPES` includes Square and Circle, the fallback scan regex at
  `:254` omits them, and the README's supported-types list omits them too. Three places, two answers.
- **`escape()` is used for UTF-8 recovery** (`:27`, `:35`). It is deprecated and misbehaves on
  non-UTF-8 Latin-1 text, and the surrounding try/catch hides the failure. `TextDecoder` handles both
  cases properly.
- `module.exports` at `:288` is a leftover Node export in a browser-only file with no bundler and no
  tests.

## Documentation

- No `LICENSE` file, despite the README ending with "MIT".
- The README's clone URL is still a placeholder with `<your-username>` in it.
- The troubleshooting entry for "No comments found" is misleading, per critical issue 1.

## Action checklist

- [x] **P1** Handle compressed object streams, or detect and report the limitation accurately.
- [x] **P1** Add cycle and depth protection to the page-tree walk.
- [x] **P1** Replace the byte-by-byte string build with a latin1 `TextDecoder`.
- [x] **P2** Delete the writer scaffolding: `findObjectMeta`, `annotMeta`, `originalBytes`, `deleted`.
- [x] **P2** Remove the `<all_urls>` content script and the `web_accessible_resources` entry.
- [x] **P2** Delete or wire up the two dead scroll-to-page listeners.
- [x] **P3** Fix literal-string parens, octal escapes, date timezones, and the page-type regex.
- [x] **P3** Reconcile the Square/Circle type lists, add a `LICENSE`, fix the placeholder clone URL.
- [ ] Decide whether `scrollToPage` needs its reload. Needs a browser.

## Notes for a future session

No build step; load unpacked. There are no tests, and this is a project that badly wants them — the
parser is pure, bytes in and comment threads out, so a small fixtures folder covering compressed
objects, nested replies, parenthesised text, and UTF-16 author names would pay for itself
immediately. Build those fixtures before attempting the compressed-object work.

## Licence, 2026-10-02

The author chose one licence for all of their projects: free for personal,
non-commercial use, modifiable for the user's own use, and not to be
distributed, original or modified. No standard licence says that, so `LICENSE`
is a short custom text, the same in every project apart from the year and what
it excludes. The README's licence section says the same. Anything above that
calls the licence an open question, or calls the project MIT, is superseded.

## CI, 2026-10-02

`.github/workflows/ci.yml` runs the node checks and the browser suite as two
jobs on `ubuntu-latest`. Nothing has been pushed, so it has not run on GitHub
yet. Every job was run before committing, from a fresh clone of this branch,
the way a runner would run it: Linux jobs in a throwaway Ubuntu 24.04 (the
image `ubuntu-latest` uses) with the same tool versions. 88, and the browser
suite all passing.

The browser job fails if the runner prints `SKIP`, which it does when it finds
no Chrome; otherwise a missing browser would read as a pass.
