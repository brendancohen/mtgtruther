// Steam Community scraper: the successor source after the Wizards feedback forum
// was archived. Collects shuffler-themed comments from the MTG Arena discussion
// forum.
//
//   node steamScrape.js                dry run: scrape, write steam-review.json + .md
//   node steamScrape.js --reclassify   re-run the filter over the cached scrape
//   node steamScrape.js --insert       insert the reviewed steam-review.json into the DB
//   node steamScrape.js --auto         scrape and insert new comments unattended
//
// The insert step reads the cached review file rather than re-scraping, so what
// gets stored is exactly what was reviewed. --auto is what the scheduled Fly
// Machine runs; it refuses to insert anything if a run looks implausible.

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const pgFormat = require("pg-format");
const { censorText } = require("./censor");

const APP_ID = 2141910;
const FORUM = `https://steamcommunity.com/app/${APP_ID}/discussions`;
const QUERIES = ["shuffler", "rigged", "shuffle", "mana screw", "land flood"];
const SEARCH_PAGES = 3;
const MAX_THREAD_PAGES = 20;
const MAX_RETRIES = 3;
// More new posts than this in one unattended run suggests a broken filter or a
// Steam layout change rather than real activity, so --auto inserts nothing.
const MAX_NEW_PER_RUN = process.env.STEAM_MAX_NEW ? Number(process.env.STEAM_MAX_NEW) : 100;
const DELAY_MS = 1500;
const UA = "mtgtruther/0.2 (+https://github.com/brendancohen/mtgtruther)";

const REVIEW_JSON = path.join(__dirname, "steam-review.json");
const REVIEW_MD = path.join(__dirname, "steam-review.md");

const MIN_LENGTH = 40;
const MAX_LENGTH = 4000;
// A comment must touch the shuffler/rigging theme to be kept; this is what drops
// conversational tangents (rage-quit etiquette, economy complaints, etc.). The
// second line covers rigging claims that never mention shuffling or lands.
const THEME = new RegExp(
  [
    "shuffl|rigged|\\brng\\b|random|algorithm|smooth|scrambl|\\blands?\\b|mana|screw|flood|mulligan|\\bdraws?\\b|\\bdrew\\b|opening hand",
    "\\bpaper\\b|win ?rate|\\bwr\\b|50[-/ ]50|matchmak|manipulat|on purpose|intentional|predetermin|scripted|\\bcheat",
  ].join("|"),
  "i"
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch and parse a page, backing off when Steam rate-limits (429) or has a
// transient server error, honouring Retry-After when it's given.
async function getPage(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) return cheerio.load(await res.text());

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : 30000 * 2 ** attempt;
    console.log(`HTTP ${res.status}; retrying in ${Math.round(waitMs / 1000)}s: ${url}`);
    await sleep(waitMs);
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Plain text of a post with quoted replies removed and line breaks preserved.
function extractText($, el) {
  const $post = $(el).clone();
  $post.find("blockquote, .bb_blockquote, script, style").remove();
  $post.find("br").replaceWith("\n");
  return $post
    .text()
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Rebuild minimal, safe HTML from the cleaned text rather than storing Steam's
// markup (emoticon images, bbcode classes, outbound links).
function toHtml(text) {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function looksLikeDecklist(text) {
  const entries = text.match(/(^|\s)\d{1,2}x?\s+[A-Za-z]/gm) || [];
  return entries.length >= 8;
}

function classify(text) {
  if (text.length < MIN_LENGTH) return "too short";
  if (text.length > MAX_LENGTH) return "too long";
  if (looksLikeDecklist(text)) return "decklist";
  if (!THEME.test(text)) return "off-theme";
  return null;
}

async function discoverThreads() {
  const threads = new Set();
  const collectLinks = async (url) => {
    try {
      const $ = await getPage(url);
      let found = 0;
      $("a[href*='/discussions/0/']").each((_, a) => {
        const match = ($(a).attr("href") || "").match(/\/discussions\/0\/(\d+)/);
        if (match) {
          found++;
          threads.add(match[1]);
        }
      });
      return found;
    } catch (e) {
      console.error(`Discovery page failed: ${e.message}`);
      return 0;
    } finally {
      await sleep(DELAY_MS);
    }
  };

  for (const query of QUERIES) {
    for (let page = 1; page <= SEARCH_PAGES; page++) {
      const found = await collectLinks(`${FORUM}/search/?q=${encodeURIComponent(query)}&gidforum=0&p=${page}`);
      if (found === 0) break;
    }
  }
  return [...threads];
}

async function scrapeThread(threadId) {
  const posts = [];
  const seen = new Set();
  let title = "";

  for (let page = 1; page <= MAX_THREAD_PAGES; page++) {
    const $ = await getPage(`${FORUM}/0/${threadId}/?ctp=${page}`);
    if (page === 1) {
      title = $(".forum_op .topic").text().replace(/\s+/g, " ").trim();
      const op = extractText($, $(".forum_op .content"));
      if (op) {
        seen.add(op);
        posts.push(op);
      }
    }

    let added = 0;
    $(".commentthread_comment_text").each((_, el) => {
      const text = extractText($, el);
      if (text && !seen.has(text)) {
        seen.add(text);
        posts.push(text);
        added++;
      }
    });

    await sleep(DELAY_MS);
    // Steam serves the last page again past the end, so stop once a page adds nothing.
    if (added === 0) break;
  }

  return { title, posts };
}

// Discover, scrape and filter. Shared by the dry run and --auto.
async function collect() {
  console.log("Discovering threads...");
  const threadIds = await discoverThreads();
  console.log(`Found ${threadIds.length} threads.`);
  if (threadIds.length === 0) {
    throw new Error("Discovered 0 threads; Steam's forum markup may have changed.");
  }

  const kept = [];
  const dropped = [];
  const seen = new Set();
  let raw = 0;
  let failed = 0;

  for (const [i, threadId] of threadIds.entries()) {
    try {
      const { title, posts } = await scrapeThread(threadId);
      raw += posts.length;
      for (const text of posts) {
        if (seen.has(text)) continue;
        seen.add(text);
        const reason = classify(text);
        const entry = { threadId, title, text };
        if (reason) dropped.push({ ...entry, reason });
        else kept.push(entry);
      }
      console.log(`[${i + 1}/${threadIds.length}] ${posts.length} posts — ${title.slice(0, 60)}`);
    } catch (e) {
      failed++;
      console.error(`Thread ${threadId} failed: ${e.message}`);
    }
  }

  if (raw === 0) {
    throw new Error(`Scraped 0 posts from ${threadIds.length} threads (${failed} failed); Steam's markup may have changed.`);
  }
  return { stats: { threads: threadIds.length, failed, raw, unique: seen.size }, kept, dropped };
}

async function dryRun() {
  const { stats, kept, dropped } = await collect();
  writeReview(stats, kept, dropped);
}

// Unattended mode for the scheduled Machine: scrape, then insert only posts that
// aren't already stored, refusing implausibly large batches.
async function auto() {
  const startedAt = Date.now();
  const { stats, kept } = await collect();

  const dbPool = require("./dbPool");
  const client = await dbPool.connect();
  try {
    await ensureSourceColumn(client);

    // Let the table's own unique constraint decide what's new, rather than
    // recomputing body_hash here: insert everything inside a transaction and roll
    // back if the batch is implausibly large.
    await client.query("BEGIN");
    let ids;
    try {
      ids = await insertRows(client, kept);
      if (ids.length > MAX_NEW_PER_RUN) {
        throw new Error(
          `${ids.length} new posts exceeds the per-run limit of ${MAX_NEW_PER_RUN}; inserted nothing. ` +
            "Review with a dry run, or raise STEAM_MAX_NEW for a one-off catch-up."
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }

    const range = ids.length ? `, ids ${Math.min(...ids)}-${Math.max(...ids)}` : "";
    console.log(
      `Steam auto run: ${stats.threads} threads (${stats.failed} failed), ${stats.raw} posts, ` +
        `${kept.length} on-theme, ${ids.length} new inserted${range} in ${Math.round((Date.now() - startedAt) / 1000)}s.`
    );
  } finally {
    client.release();
    await dbPool.end();
  }
}

// Re-run the filter over the cached scrape, so it can be tuned without hitting Steam.
function reclassify() {
  const data = JSON.parse(fs.readFileSync(REVIEW_JSON, "utf8"));
  const kept = [];
  const dropped = [];
  for (const { reason: _old, ...entry } of [...data.kept, ...data.dropped]) {
    const reason = classify(entry.text);
    if (reason) dropped.push({ ...entry, reason });
    else kept.push(entry);
  }
  const { threads, raw, unique } = data.stats;
  writeReview({ threads, raw, unique }, kept, dropped);
}

function writeReview(base, kept, dropped) {
  const reasons = {};
  for (const d of dropped) reasons[d.reason] = (reasons[d.reason] || 0) + 1;
  const stats = { ...base, kept: kept.length, dropped: reasons };

  fs.writeFileSync(
    REVIEW_JSON,
    JSON.stringify({ generatedAt: new Date().toISOString(), stats, kept, dropped }, null, 2)
  );
  fs.writeFileSync(REVIEW_MD, renderReview(stats, kept, dropped));

  console.log("\n", stats);
  console.log(`\nReview written to ${path.basename(REVIEW_MD)} (data in ${path.basename(REVIEW_JSON)}).`);
}

function renderReview(stats, kept, dropped) {
  const quote = (text) => censorText(text).replace(/\n+/g, " ").slice(0, 400);
  const lines = [
    "# Steam scrape review",
    "",
    "Text is shown censored, as it would be served. Nothing has been inserted yet.",
    "",
    `- Threads: ${stats.threads}`,
    `- Unique posts: ${stats.unique}`,
    `- **Kept: ${stats.kept}**`,
    `- Dropped: ${Object.entries(stats.dropped).map(([r, n]) => `${r} ${n}`).join(", ") || "none"}`,
    "",
    `## Kept (${kept.length})`,
    "",
    ...kept.map((k, i) => `${i + 1}. ${quote(k.text)}`),
    "",
    `## Dropped (${dropped.length})`,
    "",
    ...dropped.map((d) => `- *[${d.reason}]* ${quote(d.text)}`),
    "",
  ];
  return lines.join("\n");
}

async function insert() {
  if (!fs.existsSync(REVIEW_JSON)) {
    throw new Error("No steam-review.json found; run a dry run first.");
  }
  const { kept } = JSON.parse(fs.readFileSync(REVIEW_JSON, "utf8"));
  const dbPool = require("./dbPool");
  const client = await dbPool.connect();
  try {
    await ensureSourceColumn(client);
    const ids = await insertRows(client, kept);
    console.log(`Inserted ${ids.length} of ${kept.length} kept comments (rest were duplicates).`);
  } finally {
    client.release();
    await dbPool.end();
  }
}

// Postgres checks table ownership before IF NOT EXISTS, so only attempt the ALTER
// when the column is actually missing; the app role usually can't run it.
async function ensureSourceColumn(client) {
  const { rowCount: hasSource } = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'truths' AND column_name = 'source'"
  );
  if (hasSource) return;
  try {
    await client.query("ALTER TABLE truths ADD COLUMN source text");
  } catch (e) {
    if (e.code === "42501") {
      throw new Error("truths has no `source` column and this role can't add it; run as the table owner: ALTER TABLE truths ADD COLUMN source text;");
    }
    throw e;
  }
}

// Insert posts as Steam rows, skipping any already stored. Returns the new ids.
async function insertRows(client, entries) {
  const ids = [];
  for (let i = 0; i < entries.length; i += 200) {
    const rows = entries.slice(i, i + 200).map((k) => [k.text, toHtml(k.text), null, "steam"]);
    const res = await client.query(
      pgFormat(
        "INSERT INTO truths (body, bodyhtml, page, source) VALUES %L ON CONFLICT (body_hash) DO NOTHING RETURNING id",
        rows
      )
    );
    ids.push(...res.rows.map((r) => r.id));
  }
  return ids;
}

if (require.main === module) {
  const mode = process.argv.includes("--auto")
    ? auto
    : process.argv.includes("--insert")
      ? insert
      : process.argv.includes("--reclassify")
        ? async () => reclassify()
        : dryRun;

  mode().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { classify, insertRows, ensureSourceColumn };
