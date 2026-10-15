/**
 * background.js — service worker
 *
 * One job: put a dot on the toolbar icon when the active tab holds a PDF, so
 * the user knows there is something to click. Everything else — reading the
 * file, parsing it, jumping to a page — happens in the popup, which has the
 * tab's URL and the tabs API already.
 */

function isPdfTab(tab) {
  if (!tab?.url) return false;
  try {
    const path = new URL(tab.url).pathname.toLowerCase();
    return path.endsWith('.pdf');
  } catch { return false; }
}

function updateBadge(tab) {
  if (!tab?.id || tab.id < 0) return;
  if (isPdfTab(tab)) {
    chrome.action.setBadgeText({ text: '●', tabId: tab.id });
    chrome.action.setBadgeBackgroundColor({ color: '#2563EB', tabId: tab.id });
  } else {
    chrome.action.setBadgeText({ text: '', tabId: tab.id });
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    // A tab can close between the event and this callback. Reading
    // lastError is what stops Chrome logging the failure as unhandled.
    if (chrome.runtime.lastError) return;
    updateBadge(tab);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') updateBadge(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({}, (tabs) => tabs.forEach(updateBadge));
});
