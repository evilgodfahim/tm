const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");

const baseURL = "https://time.com";
const targetURL = "https://time.com/";
const flareSolverrURL = process.env.FLARESOLVERR_URL || "http://localhost:8191";
const FEED_PATH = "./feeds/feed.xml";
const MAX_ITEMS = 500;

fs.mkdirSync("./feeds", { recursive: true });

// ===== DATE PARSING =====
// TIME article URLs carry the publish date: /article/YYYY/MM/DD/slug/
// Fall back to parseItemDate for any date strings in the feed.
function extractDateFromURL(href) {
  const m = (href || "").match(/\/article\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function parseItemDate(raw) {
  if (!raw || !raw.trim()) return new Date();
  const trimmed = raw.trim();

  const relMatch = trimmed.match(/^(\d+)\s+(minute|hour|day)s?\s+ago$/i);
  if (relMatch) {
    const n    = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const ms   = unit === "minute" ? n * 60_000
               : unit === "hour"   ? n * 3_600_000
               :                     n * 86_400_000;
    return new Date(Date.now() - ms);
  }

  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d;

  console.warn(`⚠️  Could not parse date: "${trimmed}" — using now()`);
  return new Date();
}

// ===== LOAD EXISTING ITEMS FROM FEED =====
function loadExistingItems() {
  if (!fs.existsSync(FEED_PATH)) return [];

  try {
    const xml = fs.readFileSync(FEED_PATH, "utf-8");
    const $ = cheerio.load(xml, { xmlMode: true });
    const items = [];

    $("item").each((_, el) => {
      const $el    = $(el);
      const title  = $el.find("title").first().text().trim();
      const link   = $el.find("link").first().text().trim()
                  || $el.find("guid").first().text().trim();
      const desc   = $el.find("description").first().text().trim();
      const author = $el.find("author").first().text().trim()
                  || $el.find("dc\\:creator").first().text().trim();
      const pubDate = $el.find("pubDate").first().text().trim();

      if (!title || !link) return;

      items.push({
        title,
        link,
        description: desc,
        author,
        date: parseItemDate(pubDate),
      });
    });

    console.log(`📂 Loaded ${items.length} existing items from feed`);
    return items;
  } catch (err) {
    console.warn(`⚠️  Could not parse existing feed: ${err.message} — starting fresh`);
    return [];
  }
}

// ===== FLARESOLVERR =====
async function fetchWithFlareSolverr(url) {
  console.log(`Fetching ${url} via FlareSolverr...`);
  const response = await axios.post(
    `${flareSolverrURL}/v1`,
    { cmd: "request.get", url, maxTimeout: 60000 },
    { headers: { "Content-Type": "application/json" }, timeout: 65000 }
  );
  if (response.data?.solution) {
    console.log("✅ FlareSolverr successfully bypassed protection");
    return response.data.solution.response;
  }
  throw new Error("FlareSolverr did not return a solution");
}

// ===== SCRAPE TIME.COM ARTICLES =====
// TIME homepage renders every article inside an <article> element.
// Structure (all sections: Your Brief, Story Showcase, People, Voices):
//
//   <article>
//     <h1|h2|h3|h4  class="...font-editorial...">
//       <a href="/article/YYYY/MM/DD/slug/">
//         <span>Title text</span>   ← or direct text
//       </a>
//     </h1|h2|h3|h4>
//     <p class="...text-caption-large...">Description…</p>
//     <p class="...text-grey-1...">by Author Name</p>
//     <a class="...rounded-2...">Category pill</a>   ← optional
//   </article>
//
// Date is parsed from the URL; category pill gives the section tag.

function scrapeArticles(htmlContent) {
  const $ = cheerio.load(htmlContent);
  const items = [];
  const seen  = new Set();

  $("article").each((_, el) => {
    const $card = $(el);

    // ── Title + link ──────────────────────────────────────────────
    // Find the first heading that has the TIME editorial font class.
    const $heading = $card
      .find("h1, h2, h3, h4, h5")
      .filter((_, h) => ($(h).attr("class") || "").includes("font-editorial"))
      .first();

    if (!$heading.length) return;

    const $anchor = $heading.find("a[href]").first();
    if (!$anchor.length) return;

    // Title lives either inside a <span> child or as direct text
    const title = $anchor.find("span").first().text().trim()
               || $anchor.text().trim();
    if (!title) return;

    const href = $anchor.attr("href");
    if (!href) return;

    // Skip section/tag index pages — keep only real article paths
    const isArticle = /^\/(article|collection|[0-9])/.test(href);
    if (!isArticle) return;

    const link = href.startsWith("http") ? href : baseURL + href;
    if (seen.has(link)) return;
    seen.add(link);

    // ── Description ───────────────────────────────────────────────
    const description = $card
      .find("p")
      .filter((_, p) => ($(p).attr("class") || "").includes("text-caption-large"))
      .first()
      .text()
      .trim();

    // ── Author ────────────────────────────────────────────────────
    // Primary: <p class="...text-grey-1...">by John Doe</p>
    // Fallback: <span class=""> inside a <ul> (Voices section author list)
    let author = $card
      .find("p")
      .filter((_, p) => ($(p).attr("class") || "").includes("text-grey-1"))
      .first()
      .text()
      .trim()
      .replace(/^by\s+/i, "");

    if (!author) {
      // Voices section: li > span (not italic "By" span)
      $card.find("li").each((_, li) => {
        const spans = $(li).find("span");
        spans.each((__, sp) => {
          const cls = $(sp).attr("class") || "";
          if (!cls.includes("italic")) {
            const t = $(sp).text().trim();
            if (t) { author = t; return false; }
          }
        });
        if (author) return false;
      });
    }

    // ── Category ──────────────────────────────────────────────────
    // Category pills are <a> tags styled with rounded-2 (e.g. "World", "U.S.")
    const category = $card
      .find("a")
      .filter((_, a) => ($(a).attr("class") || "").includes("rounded-2"))
      .first()
      .text()
      .trim();

    // ── Date ──────────────────────────────────────────────────────
    // Best source: the URL itself — /article/YYYY/MM/DD/slug/
    const date = extractDateFromURL(href) || new Date();

    items.push({ title, link, description, author, category, date });
  });

  return items;
}

// ===== MAIN =====
async function generateRSS() {
  try {
    const htmlContent = await fetchWithFlareSolverr(targetURL);
    const newItems = scrapeArticles(htmlContent);

    console.log(`🆕 Scraped ${newItems.length} articles from TIME homepage`);

    // ===== MERGE: new items take priority; deduplicate by link =====
    const existingItems   = loadExistingItems();
    const existingByLink  = new Map(existingItems.map(i => [i.link, i]));

    for (const item of newItems) {
      existingByLink.set(item.link, item);
    }

    const merged = [...existingByLink.values()]
      .sort((a, b) => b.date - a.date)
      .slice(0, MAX_ITEMS);

    console.log(`📦 Total items after merge: ${merged.length}`);

    if (merged.length === 0) {
      merged.push({
        title:       "No articles found yet",
        link:        baseURL,
        description: "RSS feed could not scrape any articles.",
        author:      "",
        date:        new Date(),
      });
    }

    const feed = new RSS({
      title:       "TIME Magazine",
      description: "Breaking news and analysis from TIME",
      feed_url:    `${baseURL}/feed`,
      site_url:    baseURL,
      language:    "en",
      pubDate:     new Date().toUTCString(),
    });

    merged.forEach(item => {
      feed.item({
        title:       item.title,
        url:         item.link,
        description: item.description || undefined,
        author:      item.author      || undefined,
        categories:  item.category    ? [item.category] : undefined,
        date:        item.date,
      });
    });

    const xml = feed.xml({ indent: true });
    fs.writeFileSync(FEED_PATH, xml);
    console.log(`✅ RSS written with ${merged.length} items (max ${MAX_ITEMS}).`);

  } catch (err) {
    console.error("❌ Error generating RSS:", err.message);

    if (fs.existsSync(FEED_PATH)) {
      console.log("⚠️  Scrape failed — existing feed preserved as-is.");
      return;
    }

    // No existing feed — write placeholder
    const feed = new RSS({
      title:       "TIME Magazine (error fallback)",
      description: "RSS feed could not scrape, showing placeholder",
      feed_url:    `${baseURL}/feed`,
      site_url:    baseURL,
      language:    "en",
      pubDate:     new Date().toUTCString(),
    });
    feed.item({
      title:       "Feed generation failed",
      url:         baseURL,
      description: "An error occurred during scraping.",
      date:        new Date(),
    });
    fs.writeFileSync(FEED_PATH, feed.xml({ indent: true }));
  }
}

generateRSS();
