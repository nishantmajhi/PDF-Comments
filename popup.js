/**
 * popup.js — PDF Comments Extension
 */

(() => {
  const state = {
    tabId:         null,
    allComments:   [],
    filterAuthor:  null,
    searchQuery:   "",
    sortBy:        "page",
  };

  const $ = (id) => document.getElementById(id);

  const PANELS = [
    "state-not-pdf", "state-loading", "state-error",
    "state-empty", "toolbar", "stats-bar", "comments-container",
  ];
  function showPanels(...show) {
    PANELS.forEach((id) => $(id)?.classList.toggle("hidden", !show.includes(id)));
  }

  function showError(title, body) {
    $("error-title").textContent = title;
    $("error-body").textContent  = body;
    showPanels("state-error");
  }

  // ── Helpers ────────────────────────────────────────────────────
  function avatarColors(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++)
      h = (h * 31 + name.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    return { bg: `hsl(${hue},60%,91%)`, fg: `hsl(${hue},45%,36%)` };
  }

  function initials(name) {
    return name.trim().split(/\s+/).map((w) => w[0] || "")
      .join("").substring(0, 2).toUpperCase() || "?";
  }

  function formatDate(d) {
    if (!d) return "";
    const diff = Date.now() - d;
    if (diff < 60_000)         return "just now";
    if (diff < 3_600_000)      return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000)     return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function isPdfUrl(url) {
    if (!url) return false;
    try { return new URL(url).pathname.toLowerCase().endsWith(".pdf"); }
    catch { return url.toLowerCase().includes(".pdf"); }
  }

  // ── Fetch PDF bytes ────────────────────────────────────────────
  // For file:// URLs the popup can fetch directly (extensions have file access).
  // For http(s):// we try direct fetch first, then fall back to injected script.
  async function fetchPdfBytes(tab) {
    const url = tab.url;

    // ── file:// — direct fetch from popup context ──────────────
    if (url.startsWith("file://")) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Could not read file (HTTP ${resp.status})`);
      return new Uint8Array(await resp.arrayBuffer());
    }

    // ── http(s):// — try direct fetch first ───────────────────
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return new Uint8Array(await resp.arrayBuffer());
    } catch (_) {}

    // ── Fallback: inject into the tab and transfer in chunks ───
    // We stream chunks of max 512 KB to avoid btoa size limits.
    const CHUNK = 512 * 1024;
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (url, chunkSize) => {
        try {
          const r = await fetch(url, { credentials: "include" });
          if (!r.ok) return { error: `HTTP ${r.status}` };
          const bytes  = new Uint8Array(await r.arrayBuffer());
          const chunks = [];
          for (let i = 0; i < bytes.length; i += chunkSize) {
            const slice = bytes.subarray(i, i + chunkSize);
            let bin = "";
            for (let j = 0; j < slice.length; j++) bin += String.fromCharCode(slice[j]);
            chunks.push(btoa(bin));
          }
          return { chunks };
        } catch (e) { return { error: e.message }; }
      },
      args: [url, CHUNK],
    });

    const res = results?.[0]?.result;
    if (!res)        throw new Error("Script injection returned nothing");
    if (res.error)   throw new Error(res.error);

    // Reassemble chunks
    let totalLen = 0;
    const decoded = res.chunks.map((c) => {
      const bin  = atob(c);
      const arr  = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      totalLen += arr.length;
      return arr;
    });
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const arr of decoded) { out.set(arr, offset); offset += arr.length; }
    return out;
  }

  // ── Init ───────────────────────────────────────────────────────
  async function init() {
    showPanels("state-loading");
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) { showPanels("state-not-pdf"); return; }

      const titleIsPdf = tab.title?.toLowerCase().endsWith(".pdf");
      if (!isPdfUrl(tab.url) && !titleIsPdf) { showPanels("state-not-pdf"); return; }

      state.tabId = tab.id;

      const bytes = await fetchPdfBytes(tab);
      await loadComments(bytes.buffer);
    } catch (e) {
      showError("Could not read PDF", e.message);
    }
  }

  async function loadComments(buf) {
    const result = await PDFParser.parse(buf);
    state.allComments = result.threads;

    if (!state.allComments?.length) { showPanels("state-empty"); return; }
    showPanels("toolbar", "stats-bar", "comments-container");
    render();
  }

  // ── Scroll to page ─────────────────────────────────────────────
  // The reload is not obviously necessary: Chrome's built-in viewer usually
  // honours a change to #page=N on its own, and reloading re-downloads the
  // file and throws away the viewer's zoom and scroll position. It is left in
  // place because confirming which viewers need it takes a real browser, and
  // removing it would break page jumps outright in any that do. See review.md.
  async function scrollToPage(page) {
    if (!page || page < 1 || !state.tabId) return;
    try {
      const tab = await chrome.tabs.get(state.tabId);
      if (!tab?.url) return;
      const url = new URL(tab.url);
      url.hash = `page=${page}`;
      await chrome.tabs.update(state.tabId, { url: url.toString() });
      await new Promise((r) => setTimeout(r, 80));
      await chrome.tabs.reload(state.tabId);
    } catch (e) { console.warn("scrollToPage:", e.message); }
  }

  // ── Data helpers ───────────────────────────────────────────────

  function applyFilters(comments) {
    const q      = state.searchQuery.toLowerCase().trim();
    const author = state.filterAuthor;
    return comments.filter((c) => {
      if (author && c.author !== author) return false;
      if (q) {
        const hay = [c.author, c.subject, c.contents,
          ...c.replies.map((r) => `${r.author} ${r.contents}`)]
          .join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function sortComments(list) {
    return [...list].sort((a, b) => {
      if (state.sortBy === "date") return (b.date ?? 0) - (a.date ?? 0);
      const pa = a.page ?? 9999, pb = b.page ?? 9999;
      return pa !== pb ? pa - pb : (a.date ?? 0) - (b.date ?? 0);
    });
  }

  // ── Render ─────────────────────────────────────────────────────
  function render() {
    const full    = state.allComments;
    const visible = sortComments(applyFilters(full));

    const authors = [...new Set(full.map((c) => c.author))];
    $("stats-text").textContent =
      `${full.length} comment${full.length !== 1 ? "s" : ""} · ` +
      `${authors.length} author${authors.length !== 1 ? "s" : ""}`;

    const fc = $("filter-authors");
    fc.innerHTML = "";
    authors.forEach((a) => {
      const chip = document.createElement("button");
      chip.className = "author-chip" + (state.filterAuthor === a ? " active" : "");
      chip.textContent = a.split(" ")[0];
      chip.title = a;
      chip.onclick = () => { state.filterAuthor = state.filterAuthor === a ? null : a; render(); };
      fc.appendChild(chip);
    });

    const list = $("comments-list");
    list.innerHTML = "";
    $("no-results").classList.toggle("hidden", visible.length > 0);
    if (!visible.length) return;

    visible.forEach((c) => list.appendChild(buildCard(c)));
  }

  // ── Build comment card ─────────────────────────────────────────
  function buildCard(c) {
    const frag = document.getElementById("tpl-comment").content.cloneNode(true);
    const card = frag.querySelector(".comment-card");

    const { bg, fg } = avatarColors(c.author);
    const av = card.querySelector(".comment-avatar");
    av.style.background = bg;
    av.style.color = fg;
    av.textContent = initials(c.author);

    card.querySelector(".comment-author").textContent = c.author;
    card.querySelector(".comment-date").textContent   = formatDate(c.date);

    const pill = card.querySelector(".page-pill");
    if (c.page != null) {
      pill.querySelector(".pill-label").textContent = `page ${c.page}`;
      pill.title = `Go to page ${c.page} in PDF`;
      pill.classList.remove("hidden");
      pill.addEventListener("click", (e) => { e.stopPropagation(); scrollToPage(c.page); });
    }

    const subj = card.querySelector(".comment-subject");
    if (c.subject) subj.textContent = c.subject;
    else subj.style.display = "none";

    card.querySelector(".comment-body").textContent = c.contents;

    const repliesEl = card.querySelector(".comment-replies");
    c.replies.forEach((r) => repliesEl.appendChild(buildReply(r)));

    return frag;
  }

  function buildReply(r) {
    const frag = document.getElementById("tpl-reply").content.cloneNode(true);
    const card = frag.querySelector(".reply-card");

    const { bg, fg } = avatarColors(r.author);
    const av = card.querySelector(".reply-avatar");
    av.style.background = bg;
    av.style.color = fg;
    av.textContent = initials(r.author);

    card.querySelector(".reply-author").textContent = r.author;
    card.querySelector(".reply-date").textContent   = formatDate(r.date);
    card.querySelector(".reply-body").textContent   = r.contents;

    return frag;
  }

  // ── Wire controls ──────────────────────────────────────────────
  $("search-input").addEventListener("input", (e) => { state.searchQuery = e.target.value; render(); });
  $("sort-select").addEventListener("change", (e) => { state.sortBy = e.target.value; render(); });

  init();
})();
