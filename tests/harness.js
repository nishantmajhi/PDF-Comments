/* Enough of a Chrome extension host to run background.js.
 *
 * A service worker registers its listeners against the `chrome` namespace at
 * load time and is never called from outside, so there is no way to test one
 * without standing that namespace up. This does it in a `node:vm` context —
 * the same way a worker gets a fresh global — and hands back the events the
 * tests need to fire and a log of the calls the worker made.
 *
 * The approach, and most of the shape of this file, is borrowed from
 * `Browser Extensions/PrivatePages/tests/harness.js`, which does the same for
 * a much larger worker.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

/** A listener registry that looks like `chrome.something.onEvent`. */
function makeEvent() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    emit(...args) {
      for (const fn of listeners) fn(...args);
    },
    get count() {
      return listeners.length;
    },
  };
}

/**
 * Load background.js into a fresh context.
 *
 * `tabs` seeds the fake browser: an array of `{ id, url }`. Anything the
 * worker does to the toolbar icon lands in `calls`, and the badge text per
 * tab is summarised by `badgeFor()`.
 */
function loadWorker({ tabs = [], getFails = false } = {}) {
  const calls = [];
  const tabsById = new Map(tabs.map((t) => [t.id, t]));

  const events = {
    onActivated: makeEvent(),
    onUpdated: makeEvent(),
    onInstalled: makeEvent(),
    onMessage: makeEvent(),
  };

  // Chrome clears an unchecked-error warning only if the callback actually
  // reads runtime.lastError, so whether it was read is the thing worth
  // observing — the worker's visible behaviour is identical either way.
  let lastError;
  let lastErrorReads = 0;

  const chrome = {
    runtime: {
      get lastError() {
        lastErrorReads++;
        return lastError;
      },
      set lastError(value) {
        lastError = value;
      },
      onInstalled: events.onInstalled,
      onMessage: events.onMessage,
    },
    action: {
      setBadgeText(details) {
        calls.push({ fn: "setBadgeText", ...details });
      },
      setBadgeBackgroundColor(details) {
        calls.push({ fn: "setBadgeBackgroundColor", ...details });
      },
    },
    tabs: {
      onActivated: events.onActivated,
      onUpdated: events.onUpdated,
      get(tabId, callback) {
        if (getFails) {
          chrome.runtime.lastError = { message: "No tab with id: " + tabId };
          callback(undefined);
          lastError = undefined;
          return;
        }
        lastError = undefined;
        callback(tabsById.get(tabId));
      },
      query(_criteria, callback) {
        callback([...tabsById.values()]);
      },
    },
  };

  const context = vm.createContext({ chrome, console, URL });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), context, {
    filename: "background.js",
  });

  return {
    chrome,
    events,
    calls,
    /** How many times the worker read chrome.runtime.lastError. */
    get lastErrorReads() { return lastErrorReads; },
    /** The last badge text set for a tab, or undefined if none was. */
    badgeFor(tabId) {
      const texts = calls.filter((c) => c.fn === "setBadgeText" && c.tabId === tabId);
      return texts.length ? texts[texts.length - 1].text : undefined;
    },
  };
}

module.exports = { loadWorker };
