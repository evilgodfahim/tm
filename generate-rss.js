const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");

const baseURL = "https://www.thedailystar.net";
const targetURL = "https://www.thedailystar.net/";
const flareSolverrURL = process.env.FLARESOLVERR_URL || "http://localhost:8191";

fs.mkdirSync("./feeds", { recursive: true });

// ===== DATE PARSING =====
/**
 * Try to produce a valid Date from whatever the scraper finds.
 * Falls back to now() so feed.item() always gets a real Date object
 * and never writes "Invalid Date" into the XML.
 */
function parseItemDate(raw) {
  if (!raw || !raw.trim()) return new Date();

  const trimmed = raw.trim();

  // Relative: "2 hours ago", "30 minutes ago", "1 day ago"
  const relMatch = trimmed.match(/^(\d+)\s+(minute|hour|day)s?\s+ago$/i);
  if (relMatch) {
    const n    = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const ms   = unit === "minute" ? n * 60_000
               : unit === "hour"   ? n * 3_600_000
               :                     n * 86_400_000;
    return new Date(Date.now() - ms);
  }

  // Attempt native parse (handles RFC 2822, ISO 8601, etc.)
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d;

  // Nothing worked — use now so we never emit "Invalid Date"
  console.warn(`⚠️  Could not parse date: "${trimmed}" — using now()`);
  return new Date();
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
    const items = [];
    const seen  = new Set();

    $("div.card").each((_, el) => {
      const $card = $(el);

      const titleElement = $card.find("h5.card-title a, h1.card-title a").first();
      const title = titleElement.text().trim();
      const href  = titleElement.attr("href");
      if (!title || !href) return;

      const link = href.startsWith("http") ? href : baseURL + href;
      if (seen.has(link)) return;
      seen.add(link);

      const intro  = $card.find("div.card-intro").text().trim()
                  || $card.find("p.intro").text().trim();
      const author = $card.find("div.author a").text().trim();
      const rawDate = $card.find("div.card-info span").first().text().trim();

      items.push({
        title,
        link,
        description: intro || (author ? `By ${author}` : ""),
        author,
        date: parseItemDate(rawDate),   // always a valid Date object
      });
    });

    console.log(`Found ${items.length} articles`);

    if (items.length === 0) {
      console.log("⚠️  No articles found, creating placeholder item");
      items.push({
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

    items.forEach(item => {
      feed.item({
        title:       item.title,
        url:         item.link,
        description: item.description,
        author:      item.author || undefined,
        date:        item.date,             // Date object → RFC 2822, never "Invalid Date"
      });
    });

    const xml = feed.xml({ indent: true });
    fs.writeFileSync("./feeds/feed.xml", xml);
    console.log(`✅ RSS generated with ${items.length} items.`);

  } catch (err) {
    console.error("❌ Error generating RSS:", err.message);

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
    fs.writeFileSync("./feeds/feed.xml", feed.xml({ indent: true }));
  }
}

generateRSS();
