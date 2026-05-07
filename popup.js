// popup.js — Popup Controller
// Manages all UI state, chrome messaging, and user interactions.

"use strict";

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  view: "main",        // "main" | "settings"
  phase: "idle",       // "idle" | "loading" | "summary" | "error"
  summary: null,
  pageTab: null,
  selectedStyle: "standard",
  highlightActive: false,
  copyFeedbackTimer: null
};

// ─── DOM References ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  // Views
  viewMain: $("view-main"),
  viewSettings: $("view-settings"),
  // Header
  btnSettings: $("btn-settings"),
  btnTheme: $("btn-theme"),
  iconSun: $("icon-sun"),
  iconMoon: $("icon-moon"),
  // Page info
  pageFavicon: $("page-favicon"),
  pageTitle: $("page-title"),
  pageDomain: $("page-domain"),
  // Style pills
  stylePills: document.querySelectorAll(".style-pill"),
  // Action bar
  btnSummarize: $("btn-summarize"),
  btnClear: $("btn-clear"),
  // States
  loadingState: $("loading-state"),
  loadingText: $("loading-text"),
  loadingBarFill: $("loading-bar-fill"),
  errorState: $("error-state"),
  errorMessage: $("error-message"),
  btnRetry: $("btn-retry"),
  // Summary
  summaryWrap: $("summary-wrap"),
  cacheBadge: $("cache-badge"),
  metaReadingTime: $("meta-reading-time"),
  metaSentiment: $("meta-sentiment"),
  metaWordCount: $("meta-wordcount"),
  overviewText: $("overview-text"),
  keyPoints: $("key-points"),
  insightsList: $("insights-list"),
  tagsWrap: $("tags-wrap"),
  btnCopy: $("btn-copy"),
  btnHighlightToggle: $("btn-highlight-toggle"),
  btnRefresh: $("btn-refresh"),
  // Settings
  btnBack: $("btn-back"),
  btnSaveSettings: $("btn-save-settings"),
  saveFeedback: $("save-feedback"),
  cacheCount: $("cache-count"),
  btnClearCache: $("btn-clear-cache"),
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  await restoreTheme();
  await loadCurrentTab();
  await restoreStyle();
  bindEvents();
});

async function loadCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.pageTab = tab;

    if (!tab) return;

    // Page title
    els.pageTitle.textContent = tab.title || "Untitled page";
    els.pageTitle.title = tab.title || "";

    // Domain
    try {
      const url = new URL(tab.url);
      els.pageDomain.textContent = url.hostname.replace("www.", "");
    } catch {
      els.pageDomain.textContent = "";
    }

    // Favicon
    if (tab.favIconUrl && isValidFaviconUrl(tab.favIconUrl)) {
      const img = document.createElement("img");
      img.src = tab.favIconUrl;
      img.alt = "";
      img.onerror = () => {}; // keep placeholder SVG
      els.pageFavicon.innerHTML = "";
      els.pageFavicon.appendChild(img);
    }

    // Check if page is summarizable
    if (!isPageSummarizeable(tab.url)) {
      setPhase("error", "This page type cannot be summarized (try an article or blog post).");
      els.btnSummarize.disabled = true;
    }
  } catch (err) {
    console.warn("[Summari] Tab load error:", err);
  }
}

async function restoreStyle() {
  const { summaryStyle } = await chrome.storage.local.get("summaryStyle");
  if (summaryStyle) {
    state.selectedStyle = summaryStyle;
    els.stylePills.forEach((pill) => {
      pill.classList.toggle("active", pill.dataset.style === summaryStyle);
    });
  }
}

async function restoreTheme() {
  const { theme } = await chrome.storage.local.get("theme");
  applyTheme(theme || "dark");
}

function applyTheme(theme) {
  document.body.classList.toggle("light", theme === "light");
  els.iconSun.style.display = theme === "light" ? "none" : "";
  els.iconMoon.style.display = theme === "light" ? "" : "none";
}

// ─── Event Bindings ───────────────────────────────────────────────────────────
function bindEvents() {
  
  // Navigation
  els.btnTheme.addEventListener("click", async () => {
    const isLight = document.body.classList.contains("light");
    const newTheme = isLight ? "dark" : "light";
    applyTheme(newTheme);
    await chrome.storage.local.set({ theme: newTheme });
  });
  els.btnSettings.addEventListener("click", () => showView("settings"));
  els.btnBack.addEventListener("click", () => showView("main"));

  // Style selection
  els.stylePills.forEach((pill) => {
    pill.addEventListener("click", () => {
      state.selectedStyle = pill.dataset.style;
      els.stylePills.forEach((p) => p.classList.toggle("active", p === pill));
      chrome.storage.local.set({ summaryStyle: state.selectedStyle });
    });
  });

  // Summarize
  els.btnSummarize.addEventListener("click", handleSummarize);

  // Clear
  els.btnClear.addEventListener("click", () => {
    setPhase("idle");
    state.summary = null;
  });

  // Retry
  els.btnRetry.addEventListener("click", handleSummarize);

  // Copy
  els.btnCopy.addEventListener("click", handleCopy);

  // Highlight toggle
  els.btnHighlightToggle.addEventListener("click", handleHighlightToggle);

  // Refresh (force new summary)
  els.btnRefresh.addEventListener("click", async () => {
    if (state.pageTab?.url) {
      await chrome.runtime.sendMessage({ type: "CLEAR_CACHE", url: state.pageTab.url });
    }
    handleSummarize();
  });

  // Keyboard shortcut: Enter on summarize button
  els.btnSummarize.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") handleSummarize();
  });

  els.btnSaveSettings.addEventListener("click", handleSaveSettings);
  els.btnClearCache.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });
    els.cacheCount.textContent = "0 pages cached";
  });
}

// ─── View Switching ───────────────────────────────────────────────────────────
async function showView(view) {
  state.view = view;
  els.viewMain.style.display = view === "main" ? "" : "none";
  els.viewSettings.style.display = view === "settings" ? "" : "none";

  if (view === "settings") {
    els.saveFeedback.style.display = "none";
    const resp = await chrome.runtime.sendMessage({ type: "GET_CACHE_STATS" });
    const count = resp?.count || 0;
    els.cacheCount.textContent = `${count} page${count !== 1 ? "s" : ""} cached`;
  }
}

// ─── Summarize Flow ────────────────────────────────────────────────────────────
async function handleSummarize() {
  if (state.phase === "loading") return;

  setPhase("loading");
  animateLoadingBar();

  try {
    // 1. Inject content script (needed for dynamically loaded pages)
    await ensureContentScript();

    // 2. Extract content from page
    setLoadingText("Extracting content...");
    const extracted = await sendToContentScript({ type: "EXTRACT_CONTENT" });

    if (!extracted?.success || !extracted.content) {
      setPhase("error", "Couldn't extract content from this page. Try refreshing and summarizing again.");
      return;
    }

    // 3. Send to background for AI processing
    setLoadingText("Summarizing with AI...");
    advanceLoadingBar(50);

    const result = await chrome.runtime.sendMessage({
      type: "SUMMARIZE_PAGE",
      content: extracted.content,
      url: state.pageTab?.url,
      title: extracted.title || state.pageTab?.title,
      settings: { style: state.selectedStyle }
    });

    if (result?.error) {
      handleApiError(result);
      return;
    }

    advanceLoadingBar(100);

    // Small delay so 100% bar is visible
    await sleep(200);

    state.summary = result.summary;
    renderSummary(result.summary, result.fromCache);
    setPhase("summary");

  } catch (err) {
    console.error("[Summari] Summarize error:", err);
    setPhase("error", "An unexpected error occurred. Please try again.");
  }
}

async function ensureContentScript() {
  if (!state.pageTab?.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: state.pageTab.id },
      files: ["src/content.js"]
    });
  } catch {
    // Script already loaded or permission denied — continue
  }
}

async function sendToContentScript(message) {
  return new Promise((resolve) => {
    if (!state.pageTab?.id) {
      resolve({ success: false, error: "No active tab" });
      return;
    }
    chrome.tabs.sendMessage(state.pageTab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: false });
      }
    });
  });
}

function handleApiError({ error, message }) {
  const msgs = {
    NO_API_KEY: "No API key found. Please add one in Settings.",
    AUTH_ERROR: "Invalid API key. Please check your settings.",
    RATE_LIMIT: "Rate limit reached. Please wait a moment.",
    OVERLOADED: "AI is busy. Please try again in a moment.",
    NETWORK_ERROR: "Network error. Check your connection.",
    EMPTY_RESPONSE: "AI returned no content. Please try again."
  };
  setPhase("error", msgs[error] || message || "Something went wrong.");
}

// ─── Summary Rendering ────────────────────────────────────────────────────────
function renderSummary(summary, fromCache = false) {
  if (!summary) return;

  // Cache badge
  els.cacheBadge.style.display = fromCache ? "inline-flex" : "none";

  // Meta
  const rt = summary.readingTime;
  els.metaReadingTime.querySelector("span").textContent =
    `${rt} min read`;
  els.metaSentiment.querySelector("span").textContent = summary.sentiment || "Informative";
  els.metaWordCount.querySelector("span").textContent =
    summary.wordCount ? `~${summary.wordCount.toLocaleString()} words` : "";

  // Overview
  els.overviewText.textContent = summary.overview || "";

  // Key points
  els.keyPoints.innerHTML = "";
  (summary.keyPoints || []).forEach((point) => {
    const li = document.createElement("li");
    li.textContent = sanitizeText(point);
    els.keyPoints.appendChild(li);
  });

  // Insights
  els.insightsList.innerHTML = "";
  (summary.insights || []).forEach((insight) => {
    const li = document.createElement("li");
    li.textContent = sanitizeText(insight);
    els.insightsList.appendChild(li);
  });

  // Tags
  els.tagsWrap.innerHTML = "";
  (summary.tags || []).forEach((tag) => {
    const span = document.createElement("span");
    span.className = "tag";
    span.textContent = sanitizeText(tag);
    els.tagsWrap.appendChild(span);
  });
}

// ─── Copy ─────────────────────────────────────────────────────────────────────
async function handleCopy() {
  if (!state.summary) return;

  const { overview, keyPoints, insights, readingTime, tags } = state.summary;
  const lines = [
    `📄 ${state.pageTab?.title || "Page Summary"}`,
    `🔗 ${state.pageTab?.url || ""}`,
    `⏱ ${readingTime} min read`,
    "",
    "Overview",
    overview,
    "",
    "Key Points",
    ...(keyPoints || []).map((p) => `• ${p}`),
    "",
    "Key Insights",
    ...(insights || []).map((i) => `→ ${i}`),
    "",
    tags?.length ? `Tags: ${tags.join(", ")}` : "",
    "",
    `Summarized with Summari`
  ].filter((l) => l !== undefined);

  try {
    await navigator.clipboard.writeText(lines.join("\n").trim());

    // Feedback
    const original = els.btnCopy.innerHTML;
    els.btnCopy.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied!`;
    els.btnCopy.style.color = "var(--green)";
    els.btnCopy.style.borderColor = "rgba(16,185,129,0.3)";

    clearTimeout(state.copyFeedbackTimer);
    state.copyFeedbackTimer = setTimeout(() => {
      els.btnCopy.innerHTML = original;
      els.btnCopy.style.color = "";
      els.btnCopy.style.borderColor = "";
    }, 2000);
  } catch {
    // Clipboard API failed
  }
}

// ─── Highlight Toggle ─────────────────────────────────────────────────────────
async function handleHighlightToggle() {
  if (!state.summary || !state.pageTab?.id) return;

  state.highlightActive = !state.highlightActive;
  els.btnHighlightToggle.classList.toggle("active", state.highlightActive);

  if (state.highlightActive) {
    // Extract key terms from key points
    const terms = extractKeyTerms(state.summary);
    await sendToContentScript({
      type: "HIGHLIGHT_TOGGLE",
      terms,
      enabled: true
    });
  } else {
    await sendToContentScript({
      type: "HIGHLIGHT_TOGGLE",
      terms: [],
      enabled: false
    });
  }
}

function extractKeyTerms(summary) {
  const allText = [
    ...(summary.keyPoints || []),
    ...(summary.insights || [])
  ].join(" ");

  // Extract multi-word phrases and significant nouns (simple heuristic)
  const words = allText
    .replace(/[^\w\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4)
    .filter((w) => !STOP_WORDS.has(w.toLowerCase()));

  // Deduplicate and take top 12
  return [...new Set(words)].slice(0, 12);
}

const STOP_WORDS = new Set([
  "about", "above", "after", "again", "also", "another", "because", "been",
  "before", "being", "between", "both", "could", "does", "doing", "during",
  "each", "every", "first", "from", "have", "having", "here", "however",
  "into", "just", "like", "made", "make", "more", "most", "much", "must",
  "need", "only", "other", "over", "same", "should", "since", "some", "still",
  "such", "that", "their", "there", "these", "they", "this", "those", "through",
  "under", "until", "upon", "used", "using", "very", "what", "when", "where",
  "which", "while", "will", "with", "would", "your"
]);

// ─── Settings ─────────────────────────────────────────────────────────────────
async function handleSaveSettings() {
  els.saveFeedback.style.display = "flex";
  setTimeout(() => (els.saveFeedback.style.display = "none"), 3000);
}

// ─── Phase / UI State ─────────────────────────────────────────────────────────
function setPhase(phase, errorMessage = "") {
  state.phase = phase;

  els.loadingState.style.display = phase === "loading" ? "flex" : "none";
  els.errorState.style.display = phase === "error" ? "flex" : "none";
  els.summaryWrap.style.display = phase === "summary" ? "flex" : "none";
  els.btnClear.style.display = ["error", "summary"].includes(phase) ? "flex" : "none";
  els.btnSummarize.style.display = phase === "summary" ? "none" : "flex";
  els.btnSummarize.disabled = phase === "loading";

  if (phase === "error" && errorMessage) {
    els.errorMessage.textContent = errorMessage;
  }
}

function setLoadingText(text) {
  els.loadingText.textContent = text;
}

let loadingBarVal = 0;
let loadingBarTimer = null;

function animateLoadingBar() {
  loadingBarVal = 0;
  els.loadingBarFill.style.width = "0%";
  clearInterval(loadingBarTimer);
  // Animate to ~40% naturally
  loadingBarTimer = setInterval(() => {
    if (loadingBarVal < 40) {
      loadingBarVal += 2;
      els.loadingBarFill.style.width = `${loadingBarVal}%`;
    } else {
      clearInterval(loadingBarTimer);
    }
  }, 80);
}

function advanceLoadingBar(target) {
  clearInterval(loadingBarTimer);
  loadingBarTimer = setInterval(() => {
    if (loadingBarVal < target) {
      loadingBarVal += 3;
      els.loadingBarFill.style.width = `${Math.min(loadingBarVal, target)}%`;
    } else {
      clearInterval(loadingBarTimer);
    }
  }, 40);
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function sanitizeText(text) {
  if (typeof text !== "string") return "";
  return text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

function isValidFaviconUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return ["http:", "https:", "data:"].includes(u.protocol);
  } catch {
    return false;
  }
}

function isPageSummarizeable(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return !["chrome:", "chrome-extension:", "about:", "edge:", "brave:"].includes(u.protocol);
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
