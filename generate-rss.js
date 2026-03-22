const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");

const baseURL = "https://www.thedailystar.net";
const targetURL = "https://www.thedailystar.net/";
const flareSolverrURL = process.env.FLARESOLVERR_URL || "http://localhost:8191";
const FEED_PATH = "./feeds/feed.xml";
const MAX_ITEMS = 500;

fs.mkdirSync("./feeds", { recursive: true });

// ===== DATE PARSING =====
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
      const $el   = $(el);
      const title = $el.find("title").first().text().trim();
      const link  = $el.find("link").first().text().trim()
                 || $el.find("guid").first().text().trim();
      const desc  = $el.find("description").first().text().trim();
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

// ===== MAIN =====
async function generateRSS() {
  try {
    const htmlContent = await fetchWithFlareSolverr(targetURL);
    const $ = cheerio.load(htmlContent);
    const newItems = [];
    const seen = new Set();

    $("div.card").each((_, el) => {
      const $card = $(el);

      const titleElement = $card.find("h5.card-title a, h1.card-title a").first();
      const title = titleElement.text().trim();
      const href  = titleElement.attr("href");
      if (!title || !href) return;

      const link = href.startsWith("http") ? href : baseURL + href;
      if (seen.has(link)) return;
      seen.add(link);

      const intro   = $card.find("div.card-intro").text().trim()
                   || $card.find("p.intro").text().trim();
      const author  = $card.find("div.author a").text().trim();
      const rawDate = $card.find("div.card-info span").first().text().trim();

      newItems.push({
        title,
        link,
        description: intro || (author ? `By ${author}` : ""),
        author,
        date: parseItemDate(rawDate),
      });
    });

    console.log(`🆕 Scraped ${newItems.length} articles from page`);

    // ===== MERGE: new items take priority; deduplicate by link =====
    const existingItems = loadExistingItems();
    const existingByLink = new Map(existingItems.map(i => [i.link, i]));

    // Insert/overwrite with fresh scraped data
    for (const item of newItems) {
      existingByLink.set(item.link, item);
    }

    // Sort newest-first, cap at MAX_ITEMS
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
      title:       "The Daily Star",
      description: "Latest news from The Daily Star",
      feed_url:    baseURL,
      site_url:    baseURL,
      language:    "en",
      pubDate:     new Date().toUTCString(),
    });

    merged.forEach(item => {
      feed.item({
        title:       item.title,
        url:         item.link,
        description: item.description,
        author:      item.author || undefined,
        date:        item.date,
      });
    });

    const xml = feed.xml({ indent: true });
    fs.writeFileSync(FEED_PATH, xml);
    console.log(`✅ RSS written with ${merged.length} items (max ${MAX_ITEMS}).`);

  } catch (err) {
    console.error("❌ Error generating RSS:", err.message);

    // On scrape failure: preserve existing feed untouched if it exists
    if (fs.existsSync(FEED_PATH)) {
      console.log("⚠️  Scrape failed — existing feed preserved as-is.");
      return;
    }

    // No existing feed either — write placeholder
    const feed = new RSS({
      title:       "The Daily Star (error fallback)",
      description: "RSS feed could not scrape, showing placeholder",
      feed_url:    baseURL,
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
