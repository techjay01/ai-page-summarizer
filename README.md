# Summari — AI Page Summarizer

> A Chrome Extension (Manifest V3) that extracts and summarizes any webpage using the Groq API (Llama 3.3 70B).

![Summari Extension](icons/icon128.png)

---

## Features

- **Instant summarization** of any article, blog post, documentation page, or news item
- **Structured output**: Overview, Key Points, Key Insights, Topic Tags, and Content Type
- **Reading time estimate** based on actual word count
- **Three summary depths**: Brief (3 bullets), Standard (5), Detailed (7)
- **In-page highlights**: Optionally marks key terms directly on the source page
- **Copy to clipboard** — formatted plain text ready to paste anywhere
- **Smart caching**: Summaries cached per URL for 30 minutes — no duplicate API calls
- **Dark/light mode toggle** — persisted across sessions
- **Word count display** alongside reading time and content type
- **Clean dark/light UI** with responsive layout and keyboard accessibility

---

## Architecture

```
frontend_stage_4a/
├── config.js           ← Real key — NEVER committed
├── config.example.js   ← Empty key — committed to GitHub
├── .gitignore          ← Includes config.js
├── manifest.json          # Manifest V3 config
├── popup.html             # Extension popup shell
├── popup.css              # Popup styles (dark editorial theme)
├── popup.js               # Popup controller — UI state, messaging
├── src/
│   ├── background.js      # Service worker — AI API calls, caching
│   └── content.js         # Content script — page extraction, highlights
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

### Message Flow

```
User clicks "Summarize"
        │
        ▼
  popup.js
  ├── Sends EXTRACT_CONTENT → content.js (via chrome.tabs.sendMessage)
  │       └── content.js extracts clean text, returns it
  │
  └── Sends SUMMARIZE_PAGE → background.js (via chrome.runtime.sendMessage)
          ├── Loads API key from chrome.storage.local
          ├── Checks summary cache (30-min TTL)
          ├── Calls Groq API — Llama 3.3 70B (if no cache hit)
          ├── Parses structured response
          ├── Stores result in cache
          └── Returns summary to popup.js → renders UI
```

### Content Extraction Strategy (content.js)

The script uses a multi-tier heuristic approach:

1. **Semantic `<article>` element** — highest confidence
2. **Known main-content selectors** — `main`, `[role=main]`, `.post-content`, `.entry-content`, etc.
3. **Largest text-dense block** — scores all `div/section` elements by word count × (1 − link density) ÷ DOM depth
4. **Full body fallback** — strips nav/header/footer/sidebar noise

In all cases, navigational and boilerplate elements are removed before text is returned.

---

## AI Integration

### Model
Llama 3.3 70B via Groq's OpenAI-compatible API (`/openai/v1/chat/completions`). Groq provides extremely fast inference with a generous free tier — no credit card required.

### Prompt Design
The background script sends a structured prompt requesting output in strict sections (`## SUMMARY`, `## KEY POINTS`, etc.), which are then parsed with regex into typed fields. This avoids fragile JSON parsing while maintaining structure.

Content is truncated to ~12,000 characters (~3,000 tokens) before being sent, covering most articles while staying well within context limits.

### Security Decisions

| Decision | Rationale |
|---|---|
| API key stored in `chrome.storage.local` | Never synced to cloud, never leaves the device except in the API call |
| API key never passes through content script | Content script only sends extracted text to popup; popup relays to background |
| Background service worker makes all AI API calls | Background context is isolated from web page's JavaScript environment |
| Sanitize extracted content | Strips control characters and section headers to prevent prompt injection |
| Sanitize rendered text | All user-derived text uses `.textContent` (not `.innerHTML`) to prevent XSS |
| API key sent as Authorization Bearer header | Standard auth pattern; isolated to background service worker, never exposed to page context |

### Why Not a Proxy Server?
This is a personal/local extension. Using a proxy would require hosting a server, managing auth, and adding latency. A Groq API key has already been provided, which is the standard pattern for developer-facing extensions. A production/published extension should use a proxy to avoid exposing the key in requests.

---

## Trade-offs

| Choice | Trade-off |
|---|---|
| Pre-configured API key | Works out of the box, but key must be kept out of version control via .gitignore |
| Regex-based response parsing | More robust than JSON parsing for LLM output, but brittle if model deviates from format |
| 12K char content limit | Prevents long documents from being fully summarized |
| 30-min cache TTL | Balances freshness vs. API cost; can be adjusted in `background.js` |
| Content script pre-injected | Faster response time vs. waiting for scripting.executeScript each time |

---

## Setup Instructions

### Prerequisites
- Google Chrome (or any Chromium-based browser: Edge, Brave, Arc)
- No API key needed — works immediately after installation

### Installation

1. **Download or clone this repository**
   ```bash
   git clone https://github.com/techjay01/ai-page-summarizer.git
   # or download the ZIP and extract it
   ```

2. **Open Chrome Extensions**
   - Navigate to `chrome://extensions`
   - Or: Menu → More Tools → Extensions

3. **Enable Developer Mode**
   - Toggle "Developer mode" in the top-right corner

4. **Load the Extension**
   - Click **"Load unpacked"**
   - Select the `ai-page-summarizer` folder (the one containing `manifest.json`)

5. **Pin the Extension** (recommended)
   - Click the puzzle-piece icon in the toolbar
   - Click the pin icon next to "Summari"

6. **You're ready!**
   - Navigate to any article or blog post
   - Click the Sumree icon
   - Click **Summarize Page**

### No API Key Needed

Sumree works out of the box. No setup required from the user — the AI connection is pre-configured.

---

## Usage Tips

- Works best on **article pages**, blog posts, news, documentation, and research papers
- Does **not** work on `chrome://` internal pages or the Chrome Web Store
- Use **"Brief"** mode for quick skimming, **"Detailed"** for deep reading
- The **Highlight** button marks key terms from the summary directly on the page — click again to remove
- Summaries are cached — click **Refresh** to force a new one
- Use **Copy** to paste the full summary into notes, email, or Slack

---

## Permissions Explained

| Permission | Why |
|---|---|
| `activeTab` | Read the current tab's URL and title |
| `scripting` | Inject content script to extract page text |
| `storage` | Store API key and summary cache locally |
| `https://api.groq.com/*` | Make API calls to Groq's API (host permission) |

No browsing history, no cookies, no access to other tabs.

---

## Development

To modify the extension:

1. Edit the source files
2. Go to `chrome://extensions`
3. Click the **refresh icon** on the Summari card
4. Reload any open tabs you want to test on

View background script logs:
- `chrome://extensions` → Summari → **"Service worker"** link → DevTools console

View content script / popup logs:
- Right-click popup → Inspect → Console

---

## License

MIT — free to use, modify, and distribute.

---

## Security Note

The Groq API key is stored in `config.js` which is listed in `.gitignore` and 
is never committed to this repository. A `config.example.js` file is included 
showing the expected structure.API calls are made exclusively from the background service worker, the key is never accessible to page scripts or the popup.
