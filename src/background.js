// background.js — Service Worker
// Handles all AI API communication. API key never touches the content script.

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const MAX_CONTENT_LENGTH = 12000; // chars sent to API (~3000 tokens)
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SUMMARIZE_PAGE") {
    handleSummarizeRequest(message, sendResponse);
    return true; // keep channel open for async response
  }

  if (message.type === "CLEAR_CACHE") {
    clearSummaryCache(message.url, sendResponse);
    return true;
  }

  if (message.type === "GET_CACHE_STATS") {
    getCacheStats(sendResponse);
    return true;
  }
});

// ─── Summarize Handler ────────────────────────────────────────────────────────
async function handleSummarizeRequest({ content, url, title, settings }, sendResponse) {
  try {
    // 1. Load API key from storage
    const stored = await chrome.storage.local.get(["apiKey", "summaryCache"]);
    const apiKey = stored.apiKey;

    if (!apiKey || apiKey.trim() === "") {
      sendResponse({ error: "NO_API_KEY", message: "Please add your Groq API key in Settings." });
      return;
    }

    // 2. Check cache
    const cache = stored.summaryCache || {};
    const cacheKey = normalizeUrl(url);
    const cached = cache[cacheKey];

    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      sendResponse({ success: true, summary: cached.summary, fromCache: true });
      return;
    }

    // 3. Truncate content safely
    const safeContent = sanitizeContent(content).slice(0, MAX_CONTENT_LENGTH);
    const wordCount = safeContent.trim().split(/\s+/).length;
    const readingTimeMin = Math.ceil(wordCount / 238); // avg reading speed

    // 4. Build prompt
    const style = settings?.style || "detailed";
    const prompt = buildPrompt(safeContent, title, url, style, readingTimeMin);

    // 5. Call Groq API
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2048,
        temperature: 0.4
      })
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      console.error("[Summari] Groq error body:", JSON.stringify(errBody));
      const errMsg = errBody?.error?.message || `API error ${response.status}`;

      if (response.status === 400) {
        sendResponse({ error: "API_ERROR", message: `Bad request: ${errMsg}` });
      } else if (response.status === 401) {
        sendResponse({ error: "AUTH_ERROR", message: "Invalid Groq API key. Please check your settings." });
      } else if (response.status === 429) {
        sendResponse({ error: "RATE_LIMIT", message: "Groq rate limit reached. Please wait a moment and try again." });
      } else if (response.status === 503) {
        sendResponse({ error: "OVERLOADED", message: "Groq is overloaded. Please try again shortly." });
      } else {
        sendResponse({ error: "API_ERROR", message: `Error ${response.status}: ${errMsg}` });
      }
      return;
    }

    const data = await response.json();
    const rawText = data.choices?.[0]?.message?.content || "";

    if (!rawText) {
      sendResponse({ error: "EMPTY_RESPONSE", message: "AI returned an empty response. Please try again." });
      return;
    }

    // 6. Parse structured response
    const summary = parseSummary(rawText, readingTimeMin);

    // 7. Cache result
    cache[cacheKey] = { summary, timestamp: Date.now(), title };
    // Keep cache under 50 entries
    const keys = Object.keys(cache);
    if (keys.length > 50) {
      const oldest = keys.sort((a, b) => cache[a].timestamp - cache[b].timestamp)[0];
      delete cache[oldest];
    }
    await chrome.storage.local.set({ summaryCache: cache });

    sendResponse({ success: true, summary, fromCache: false });

  } catch (err) {
    console.error("[Summari] Background error:", err);
    if (err.name === "TypeError" && err.message.includes("fetch")) {
      sendResponse({ error: "NETWORK_ERROR", message: "Network error. Check your internet connection." });
    } else {
      sendResponse({ error: "UNKNOWN_ERROR", message: "An unexpected error occurred. Please try again." });
    }
  }
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────
function buildPrompt(content, title, url, style, readingTimeMin) {
  const bulletCount = style === "brief" ? 3 : style === "detailed" ? 7 : 5;
  const depthNote = style === "brief"
    ? "Be very concise. Short sentences only."
    : style === "detailed"
    ? "Be thorough. Include technical detail where relevant."
    : "Be clear and balanced.";

  return `Summarize this webpage. ${depthNote}

TITLE: ${title || "Unknown"}
URL: ${url || ""}
READING TIME: ${readingTimeMin} min

CONTENT:
${content}

Reply using EXACTLY these sections and no others:

## SUMMARY
2-3 sentences on the core topic and main argument.

## KEY POINTS
Exactly ${bulletCount} bullet points. Each must be specific and standalone.
- 
- 
${bulletCount >= 4 ? "- \n- " : ""}
${bulletCount >= 6 ? "- \n- " : ""}

## KEY INSIGHTS
Exactly 3 non-obvious takeaways.
- 
- 
- 

## TOPIC_TAGS
4 short tags separated by commas.

## SENTIMENT
One word only: Informative, Persuasive, Technical, News, Opinion, Tutorial, Research, or Product.`;
}

// ─── Response Parser ──────────────────────────────────────────────────────────
function parseSummary(raw, readingTimeMin) {
  const section = (label) => {
    const regex = new RegExp(`## ${label}\\s*([\\s\\S]*?)(?=##|$)`, "i");
    const match = raw.match(regex);
    return match ? match[1].trim() : "";
  };

  const bulletLines = (text) =>
    text
      .split("\n")
      .map((l) => l.replace(/^[-•*]\s*/, "").trim())
      .filter((l) => l.length > 0);

  const rawTags = section("TOPIC_TAGS");
  const tags = rawTags
    ? rawTags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 6)
    : [];

  const sentiment = section("SENTIMENT").split("\n")[0]?.trim() || "Informative";

  return {
    overview: section("SUMMARY"),
    keyPoints: bulletLines(section("KEY POINTS")),
    insights: bulletLines(section("KEY INSIGHTS")),
    readingTime: readingTimeMin,
    wordCount: raw.trim().split(/\s+/).length,
    tags,
    sentiment,
    generatedAt: new Date().toISOString()
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Strip UTM params and fragments for cache key
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref"].forEach((p) =>
      u.searchParams.delete(p)
    );
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

function sanitizeContent(text) {
  if (typeof text !== "string") return "";
  // Remove potential prompt injection attempts
  return text
    .replace(/##\s*(SUMMARY|KEY POINTS|KEY INSIGHTS|TOPIC_TAGS|SENTIMENT)/gi, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // control chars
    .trim();
}

async function clearSummaryCache(url, sendResponse) {
  const { summaryCache = {} } = await chrome.storage.local.get("summaryCache");
  if (url) {
    delete summaryCache[normalizeUrl(url)];
  } else {
    Object.keys(summaryCache).forEach((k) => delete summaryCache[k]);
  }
  await chrome.storage.local.set({ summaryCache });
  sendResponse({ success: true });
}

async function getCacheStats(sendResponse) {
  const { summaryCache = {} } = await chrome.storage.local.get("summaryCache");
  sendResponse({ count: Object.keys(summaryCache).length });
}
