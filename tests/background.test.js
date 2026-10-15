/* The service worker: the badge, and nothing else.
 *
 * The badge is the only thing telling the user the extension has something to
 * show, so getting it wrong on a PDF tab makes the extension invisible, and
 * getting it wrong elsewhere makes it noise.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadWorker } = require("./harness.js");

test("a PDF tab gets the dot", () => {
  const w = loadWorker({ tabs: [{ id: 1, url: "https://example.com/report.pdf" }] });
  w.events.onActivated.emit({ tabId: 1 });
  assert.equal(w.badgeFor(1), "●");
});

test("a page that is not a PDF gets no dot", () => {
  const w = loadWorker({ tabs: [{ id: 1, url: "https://example.com/index.html" }] });
  w.events.onActivated.emit({ tabId: 1 });
  assert.equal(w.badgeFor(1), "");
});

test("a query string after the .pdf does not hide the dot", () => {
  const w = loadWorker({ tabs: [{ id: 1, url: "https://example.com/a.pdf?download=1#page=3" }] });
  w.events.onActivated.emit({ tabId: 1 });
  assert.equal(w.badgeFor(1), "●");
});

test("an uppercase extension still counts", () => {
  const w = loadWorker({ tabs: [{ id: 1, url: "https://example.com/REPORT.PDF" }] });
  w.events.onActivated.emit({ tabId: 1 });
  assert.equal(w.badgeFor(1), "●");
});

test("a local file gets the dot", () => {
  const w = loadWorker({ tabs: [{ id: 1, url: "file:///C:/docs/draft.pdf" }] });
  w.events.onActivated.emit({ tabId: 1 });
  assert.equal(w.badgeFor(1), "●");
});

test("a .pdf that is only in the query string does not count", () => {
  const w = loadWorker({ tabs: [{ id: 1, url: "https://example.com/viewer?file=a.pdf" }] });
  w.events.onActivated.emit({ tabId: 1 });
  assert.equal(w.badgeFor(1), "");
});

test("a tab that closes before the lookup returns is handled quietly", () => {
  // chrome.tabs.get fires its callback with no tab and sets runtime.lastError.
  // Not reading lastError makes Chrome log the failure as unhandled on every
  // tab switch that races a close.
  const w = loadWorker({ tabs: [{ id: 1, url: "https://example.com/a.pdf" }], getFails: true });
  assert.doesNotThrow(() => w.events.onActivated.emit({ tabId: 1 }));
  assert.equal(w.calls.length, 0, "no badge for a tab that is gone");
  assert.ok(w.lastErrorReads > 0, "the callback must read chrome.runtime.lastError");
});

test("the badge is only set once a navigation has finished", () => {
  const w = loadWorker();
  const tab = { id: 2, url: "https://example.com/a.pdf" };

  w.events.onUpdated.emit(2, { status: "loading" }, tab);
  assert.equal(w.calls.length, 0);

  w.events.onUpdated.emit(2, { status: "complete" }, tab);
  assert.equal(w.badgeFor(2), "●");
});

test("installing marks every open PDF tab at once", () => {
  const w = loadWorker({
    tabs: [
      { id: 1, url: "https://example.com/a.pdf" },
      { id: 2, url: "https://example.com/index.html" },
      { id: 3, url: "https://example.com/b.pdf" },
    ],
  });

  w.events.onInstalled.emit();

  assert.equal(w.badgeFor(1), "●");
  assert.equal(w.badgeFor(2), "");
  assert.equal(w.badgeFor(3), "●");
});

test("a tab with no id is ignored", () => {
  const w = loadWorker();
  w.events.onUpdated.emit(-1, { status: "complete" }, { id: -1, url: "https://x/a.pdf" });
  assert.equal(w.calls.length, 0);
});

test("an unparseable URL does not throw", () => {
  const w = loadWorker({ tabs: [{ id: 1, url: "not a url at all" }] });
  assert.doesNotThrow(() => w.events.onActivated.emit({ tabId: 1 }));
  assert.equal(w.badgeFor(1), "");
});

test("the worker registers no message listener", () => {
  // It used to listen for a SCROLL_TO_PAGE message that nothing ever sent —
  // the popup navigates the tab itself — which kept the worker alive to
  // service an event that never arrives.
  const w = loadWorker();
  assert.equal(w.events.onMessage.count, 0);
});
