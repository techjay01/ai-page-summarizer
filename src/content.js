// content.js — Content Script
// Extracts clean, readable content from the current page.
// Runs in page context but communicates via chrome.runtime messaging.

(function () {
  "use strict";

  // Guard: only register listener once
  if (window.__summariLoaded) return;
  window.__summariLoaded = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "EXTRACT_CONTENT") {
      try {
        const result = extractPageContent();
        sendResponse({ success: true, ...result });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    }

    if (message.type === "HIGHLIGHT_TOGGLE") {
      toggleHighlights(message.terms, message.enabled);
      sendResponse({ success: true });
    }

    return true; // async
  });

  // ─── Content Extraction ────────────────────────────────────────────────────
  function extractPageContent() {
    const title = document.title || "";
    const url = window.location.href;
    const lang = document.documentElement.lang || "en";

    // Try article-first extraction strategy
    let content = "";
    let strategy = "generic";

    // Strategy 1: Semantic <article> element
    const articleEl = document.querySelector("article");
    if (articleEl) {
      content = extractText(articleEl);
      strategy = "article-element";
    }

    // Strategy 2: Main content area heuristics
    if (!content || content.length < 300) {
      const mainSelectors = [
        "main",
        '[role="main"]',
        "#main-content",
        "#content",
        ".post-content",
        ".article-content",
        ".entry-content",
        ".article-body",
        ".story-body",
        ".post-body",
        ".content-body",
        '[itemprop="articleBody"]',
        ".readable",
        "#article-body"
      ];

      for (const sel of mainSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const txt = extractText(el);
          if (txt.length > content.length) {
            content = txt;
            strategy = `selector:${sel}`;
          }
        }
      }
    }

    // Strategy 3: Largest text-dense block
    if (!content || content.length < 300) {
      content = extractLargestTextBlock();
      strategy = "heuristic-largest-block";
    }

    // Strategy 4: Full body fallback
    if (!content || content.length < 200) {
      content = extractText(document.body);
      strategy = "body-fallback";
    }

    // Clean and truncate
    content = cleanText(content);

    // Extract metadata
    const description =
      getMeta("description") || getMeta("og:description") || getMeta("twitter:description") || "";
    const author = getMeta("author") || getMeta("article:author") || "";
    const publishDate = getMeta("article:published_time") || getMeta("datePublished") || "";
    const siteName = getMeta("og:site_name") || "";

    return { title, url, content, description, author, publishDate, siteName, lang, strategy };
  }

  // ─── Text Extraction Helpers ───────────────────────────────────────────────
  function extractText(root) {
    if (!root) return "";

    // Clone to avoid modifying live DOM
    const clone = root.cloneNode(true);

    // Remove noise elements
    const noiseSelectors = [
      "nav", "header", "footer", "aside",
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
      '[role="complementary"]', '[role="search"]',
      ".nav", ".navbar", ".navigation",
      ".header", ".footer", ".sidebar",
      ".ad", ".ads", ".advertisement", ".promo",
      ".cookie", ".popup", ".modal",
      ".social", ".share", ".sharing",
      ".comment", ".comments", ".disqus",
      ".related", ".recommended", ".suggested",
      "script", "style", "noscript", "iframe",
      "button", "form", "input", "select", "textarea",
      ".skip-link", ".screen-reader-only", ".sr-only",
      "[aria-hidden='true']", ".hidden",
      ".breadcrumb", ".breadcrumbs",
      ".tags", ".tag-list",
      ".author-bio", ".byline-extras"
    ];

    noiseSelectors.forEach((sel) => {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    });

    // Extract visible text preserving structure
    return clone.innerText || clone.textContent || "";
  }

  function extractLargestTextBlock() {
    const candidates = document.querySelectorAll(
      "div, section, article, main, .content, .post, .story"
    );

    let bestEl = null;
    let bestScore = 0;

    candidates.forEach((el) => {
      // Skip tiny or invisible elements
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return;

      const text = el.innerText || el.textContent || "";
      const wordCount = text.trim().split(/\s+/).length;
      const linkDensity = getLinkDensity(el, text);
      const depth = getDepth(el);

      // Score: favor word-dense, low-link-density, shallower elements
      const score = wordCount * (1 - linkDensity) * (1 / Math.max(depth, 1));

      if (score > bestScore && wordCount > 50) {
        bestScore = score;
        bestEl = el;
      }
    });

    return bestEl ? extractText(bestEl) : "";
  }

  function getLinkDensity(el, text) {
    const links = el.querySelectorAll("a");
    let linkText = 0;
    links.forEach((a) => (linkText += (a.innerText || a.textContent || "").length));
    const total = text.length || 1;
    return Math.min(linkText / total, 1);
  }

  function getDepth(el) {
    let depth = 0;
    let node = el;
    while (node.parentElement && depth < 20) {
      depth++;
      node = node.parentElement;
    }
    return depth;
  }

  function cleanText(text) {
    return text
      .replace(/\t/g, " ")
      .replace(/[ \t]{2,}/g, " ")         // collapse horizontal whitespace
      .replace(/\n{3,}/g, "\n\n")          // max 2 blank lines
      .replace(/^\s+|\s+$/gm, "")          // trim each line
      .replace(/^(\s*\n)+/, "")            // leading blank lines
      .trim();
  }

  function getMeta(name) {
    const el =
      document.querySelector(`meta[name="${name}"]`) ||
      document.querySelector(`meta[property="${name}"]`) ||
      document.querySelector(`meta[itemprop="${name}"]`);
    return el?.getAttribute("content")?.trim() || "";
  }

  // ─── Highlight Feature ─────────────────────────────────────────────────────
  const HIGHLIGHT_CLASS = "summari-highlight";
  let highlightActive = false;

  function toggleHighlights(terms, enabled) {
    if (!enabled || !terms?.length) {
      removeHighlights();
      return;
    }
    removeHighlights();
    addHighlights(terms);
    highlightActive = true;
  }

  function addHighlights(terms) {
    if (!document.getElementById("summari-highlight-style")) {
      const style = document.createElement("style");
      style.id = "summari-highlight-style";
      style.textContent = `
        .${HIGHLIGHT_CLASS} {
          background: rgba(251, 191, 36, 0.35) !important;
          border-radius: 2px !important;
          padding: 0 2px !important;
          box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.5) !important;
          transition: background 0.2s ease !important;
        }
      `;
      document.head.appendChild(style);
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toLowerCase();
        if (["script", "style", "noscript", "iframe", "input", "textarea"].includes(tag))
          return NodeFilter.FILTER_REJECT;
        if (parent.classList.contains(HIGHLIGHT_CLASS)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const escapedTerms = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(`(${escapedTerms.join("|")})`, "gi");

    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    textNodes.forEach((textNode) => {
      const text = textNode.textContent;
      if (!pattern.test(text)) return;
      pattern.lastIndex = 0;

      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIdx) {
          frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
        }
        const mark = document.createElement("mark");
        mark.className = HIGHLIGHT_CLASS;
        mark.textContent = match[0];
        frag.appendChild(mark);
        lastIdx = pattern.lastIndex;
      }
      if (lastIdx < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      }
      textNode.parentNode.replaceChild(frag, textNode);
    });
  }

  function removeHighlights() {
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => {
      const parent = el.parentNode;
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    });
    highlightActive = false;
  }
})();
