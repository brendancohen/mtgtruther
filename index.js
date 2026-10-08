const express = require("express");
const cheerio = require("cheerio");
const dbPool = require("./dbPool");
const { censorText, censorHtml, isProfane } = require("./censor");
const app = express();

const port = process.env.PORT || 8080;

// Optional shared-secret protecting the admin UI and manual scrape trigger.
// If unset, those routes stay open (backward compatible with the original behavior).
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function requireAuth(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const provided = req.query.token || req.get("x-admin-token");
  if (provided === ADMIN_TOKEN) return next();
  return res.status(401).send("Unauthorized");
}

// ============================================================================
// HELPERS
// ============================================================================

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Escape for HTML, then wrap case-insensitive matches of `term` for the admin UI.
function highlightMatch(text, term) {
  const escaped = escapeHtml(text);
  if (!term) return escaped;
  const escapedTerm = escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escapedTerm) return escaped;
  return escaped.replace(new RegExp(escapedTerm, "gi"), (m) => `<span class="highlight">${m}</span>`);
}

// Where each comment came from: `source` is null for the original feedback-forum
// scrape and 'steam' for steamScrape.js. Keys double as the admin filter values.
const SOURCE_LABELS = { arena: "Arena forum", steam: "Steam" };

// Hidden comments stay in the table (so re-scrapes still dedupe against them) but
// are never served. The admin page can list either set or both.
const VISIBILITY_LABELS = { all: "All comments", visible: "In rotation", hidden: "Hidden" };

function sourceKey(row) {
  return row.source || "arena";
}

function parseLengthFilters(req) {
  const minLength = parseInt(req.query.min_length) || 1;
  const maxLength = parseInt(req.query.max_length) || 999999;
  return { minLength, maxLength };
}

function formatComment(selectedRow, req) {
  if (!selectedRow) return "";

  const isText = req.query.mode === "text";
  let comment = isText ? selectedRow.body : selectedRow.bodyhtml;

  // Censor before truncating; the source forum's profanity filter lets plenty through.
  comment = isText ? censorText(comment) : censorHtml(comment);

  if (req.query.short === "true" && comment) {
    if (isText) {
      comment = comment.slice(0, 500);
    } else {
      // Truncate HTML at 500 chars, then let cheerio drop any dangling partial
      // tag and re-balance so we never emit broken markup.
      const sliced = comment.slice(0, 500).replace(/<[^>]*$/, "");
      comment = cheerio.load(sliced, null, false).html();
    }
  }

  return comment;
}

function withDbClient(handler) {
  return async (req, res) => {
    const dbClient = await dbPool.connect();
    try {
      return await handler(req, res, dbClient);
    } catch (e) {
      console.error('Request error:', e);
      res.status(500).send(e.message);
    } finally {
      dbClient.release();
    }
  };
}

// ============================================================================
// ROUTES
// ============================================================================

app.get("/", (req, res) => res.send("MTG Truther API"));

app.get("/ping", (req, res) => res.send("pong"));

// Automatic scraping is retired: the original feedback forum was archived and
// locked behind sign-in in Oct 2026. New comments are now collected offline with
// steamScrape.js (review, then insert). Kept as a no-op so any existing caller
// gets a clear answer rather than a 404.
app.get("/scrape", (req, res) => {
  res
    .status(410)
    .send("On-demand scraping is disabled; the corpus is updated offline. Comments are still served via /truth and /search.");
});

app.get("/truth", withDbClient(async (req, res, dbClient) => {
  const { minLength, maxLength } = parseLengthFilters(req);
  
  console.log("Fetching random truth.");

  const queryRes = await dbClient.query(
    "SELECT * FROM truths WHERE NOT hidden AND LENGTH(body) >= $1 AND LENGTH(body) <= $2 ORDER BY RANDOM() LIMIT 1",
    [minLength, maxLength]
  );

  const comment = formatComment(queryRes.rows[0], req);

  console.log("Sending random truth: ", comment);

  res.send(comment);
}));

app.get("/search", withDbClient(async (req, res, dbClient) => {
  const searchTerm = req.query.q;
  
  console.log(`Searching for term: ${searchTerm}`);

  if (!searchTerm) {
    return res.status(400).send("Missing search term. Use ?q=yourterm");
  }

  const { minLength, maxLength } = parseLengthFilters(req);

  const queryRes = await dbClient.query(
    "SELECT * FROM truths WHERE NOT hidden AND body ~* $1 AND LENGTH(body) >= $2 AND LENGTH(body) <= $3 ORDER BY RANDOM() LIMIT 1",
    [`\\y${searchTerm}\\y`, minLength, maxLength]
  );

  const comment = formatComment(queryRes.rows[0], req);

  console.log(`Sending search result for term: ${searchTerm}: `, comment);

  res.send(comment);
}));

app.get("/stats", withDbClient(async (req, res, dbClient) => {
  // Get basic counts
  const totalRes = await dbClient.query("SELECT COUNT(*) as total FROM truths WHERE NOT hidden");
  const total = parseInt(totalRes.rows[0].total);

  // Get length statistics
  const lengthRes = await dbClient.query(
    "SELECT AVG(LENGTH(body))::int as avg_length, MIN(LENGTH(body)) as min_length, MAX(LENGTH(body)) as max_length FROM truths WHERE NOT hidden"
  );

  // Get comments per page
  const pageRes = await dbClient.query(
    "SELECT page, COUNT(*) as count FROM truths WHERE NOT hidden GROUP BY page ORDER BY page"
  );

  // Get most common words (top 20, excluding common words)
  const wordsRes = await dbClient.query(`
    SELECT word, COUNT(*) as frequency
    FROM (
      SELECT regexp_split_to_table(LOWER(body), E'\\\\s+') as word
      FROM truths
      WHERE NOT hidden
    ) words
    WHERE LENGTH(word) > 3
      AND word NOT IN ('the', 'and', 'that', 'this', 'with', 'have', 'from', 'they', 'been', 'were', 'your', 'just', 'their', 'than', 'when', 'what', 'about', 'which', 'there', 'would', 'could', 'should')
    GROUP BY word
    ORDER BY frequency DESC
    LIMIT 20
  `);

  // Get last scrape info (when the newest page was added)
  const lastScrapeRes = await dbClient.query(
    "SELECT MAX(page) as last_page FROM truths WHERE NOT hidden"
  );

  const stats = {
    total_comments: total,
    length_stats: {
      average: lengthRes.rows[0].avg_length,
      minimum: lengthRes.rows[0].min_length,
      maximum: lengthRes.rows[0].max_length
    },
    comments_per_page: pageRes.rows.map(r => ({
      page: r.page,
      count: parseInt(r.count)
    })),
    most_common_words: wordsRes.rows
      .filter(r => !isProfane(r.word))
      .map(r => ({
        word: r.word,
        frequency: parseInt(r.frequency)
      })),
    last_scraped_page: lastScrapeRes.rows[0].last_page
  };

  res.json(stats);
}));

app.get("/admin", requireAuth, withDbClient(async (req, res, dbClient) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';
  const source = SOURCE_LABELS[req.query.source] ? req.query.source : '';
  const visibility = VISIBILITY_LABELS[req.query.show] ? req.query.show : 'all';
  const sortBy = req.query.sort || 'id';
  const sortOrder = req.query.order || 'desc';

  // Validate sort column to prevent SQL injection; values are fixed expressions.
  const sortExpressions = {
    id: 'id',
    body_length: 'LENGTH(body)',
    page: 'page',
    source: "COALESCE(source, 'arena')",
  };
  const sortColumn = sortExpressions[sortBy] ? sortBy : 'id';
  const order = sortOrder === 'asc' ? 'ASC' : 'DESC';

  // Build the filter once, shared by the count and the page of rows.
  const conditions = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`body ILIKE $${params.length}`);
  }
  if (source === 'arena') conditions.push('source IS NULL');
  if (source === 'steam') conditions.push("source = 'steam'");
  if (visibility === 'visible') conditions.push('NOT hidden');
  if (visibility === 'hidden') conditions.push('hidden');
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await dbClient.query(`SELECT COUNT(*) FROM truths ${where}`, params);
  const totalComments = parseInt(countRes.rows[0].count);
  const totalPages = Math.ceil(totalComments / limit);

  const queryRes = await dbClient.query(`
    SELECT
      id,
      LEFT(body, 200) as body_preview,
      LENGTH(body) as body_length,
      page,
      source,
      hidden,
      hidden_reason
    FROM truths
    ${where}
    ORDER BY ${sortExpressions[sortColumn]} ${order}, id ${order}
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...params, limit, offset]);

  const sourceCountsRes = await dbClient.query(
    "SELECT COUNT(*) FILTER (WHERE source IS NULL AND NOT hidden)::int AS arena, COUNT(*) FILTER (WHERE source = 'steam' AND NOT hidden)::int AS steam, COUNT(*) FILTER (WHERE hidden)::int AS hidden FROM truths"
  );

  res.send(renderAdminPage({
    page,
    limit,
    offset,
    totalComments,
    totalPages,
    rows: queryRes.rows,
    search,
    source,
    visibility,
    sourceCounts: sourceCountsRes.rows[0],
    sortBy: sortColumn,
    sortOrder
  }));
}));
// ============================================================================
// ADMIN PAGE TEMPLATE WITH SEARCH AND SORT
// ============================================================================

function renderAdminPage({ page, limit, offset, totalComments, totalPages, rows, search, source, visibility, sourceCounts, sortBy, sortOrder }) {
  const buildUrl = (params) => {
    const url = new URLSearchParams({
      page: params.page || page,
      limit: params.limit || limit,
      search: params.search !== undefined ? params.search : search,
      source: params.source !== undefined ? params.source : source,
      show: params.show !== undefined ? params.show : visibility,
      sort: params.sort || sortBy,
      order: params.order || sortOrder
    });
    return `/admin?${url.toString()}`;
  };

  const toggleSort = (column) => {
    const newOrder = (sortBy === column && sortOrder === 'desc') ? 'asc' : 'desc';
    return buildUrl({ sort: column, order: newOrder, page: 1 });
  };

  const sortIcon = (column) => {
    if (sortBy !== column) return '↕';
    return sortOrder === 'asc' ? '↑' : '↓';
  };

  return `
<!DOCTYPE html>
<html>
<head>
  <title>MTG Truther UI</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      margin: 0;
      padding: 20px;
      background: #f5f5f5;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      color: #333;
      margin-top: 0;
    }
    .stats {
      display: flex;
      gap: 20px;
      margin-bottom: 20px;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 4px;
    }
    .stat {
      flex: 1;
    }
    .stat-label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .stat-value {
      font-size: 24px;
      font-weight: bold;
      color: #333;
    }
    .search-bar {
      margin-bottom: 20px;
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .search-bar input {
      flex: 1;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }
    .search-bar button {
      padding: 10px 20px;
      background: #3498db;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    .search-bar button:hover {
      background: #2980b9;
    }
    .search-bar .clear-btn {
      background: #95a5a6;
    }
    .search-bar .clear-btn:hover {
      background: #7f8c8d;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
    }
    th {
      background: #2c3e50;
      color: white;
      padding: 12px;
      text-align: left;
      font-weight: 600;
      position: sticky;
      top: 0;
      cursor: pointer;
      user-select: none;
    }
    th:hover {
      background: #34495e;
    }
    th a {
      color: white;
      text-decoration: none;
      display: block;
    }
    .sort-icon {
      float: right;
      opacity: 0.6;
    }
    td {
      padding: 12px;
      border-bottom: 1px solid #ddd;
    }
    tr:hover {
      background: #f8f9fa;
    }
    .body-preview {
      max-width: 600px;
      white-space: normal;
      word-wrap: break-word;
      line-height: 1.4;
    }
    .highlight {
      background-color: yellow;
      font-weight: bold;
    }
    .pagination {
      display: flex;
      justify-content: center;
      gap: 10px;
      margin-top: 20px;
    }
    .pagination a, .pagination span {
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      text-decoration: none;
      color: #333;
    }
    .pagination a:hover {
      background: #f0f0f0;
    }
    .pagination .current {
      background: #2c3e50;
      color: white;
      border-color: #2c3e50;
    }
    .id-col { width: 60px; }
    .source-col { width: 110px; text-align: center; }
    .page-col { width: 80px; text-align: center; }
    .length-col { width: 100px; text-align: center; }
    .search-bar select {
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
      background: white;
    }
    .source-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      text-decoration: none;
    }
    .source-arena { background: #fdecc8; color: #8a5300; }
    .source-steam { background: #dbeafe; color: #1e40af; }
    .source-other { background: #eee; color: #444; }
    .source-hidden { background: #fde2e2; color: #9b1c1c; }
    .hidden-row td { color: #999; }
    .hidden-reason { display: block; margin-top: 4px; font-size: 12px; color: #9b1c1c; }
    .stat-sources {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 6px;
    }
    .stat-sources .source-badge {
      font-size: 14px;
      padding: 4px 10px;
    }
    .stat-sources .source-badge.active {
      outline: 2px solid currentColor;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>MTG Truther UI</h1>
    
    <div class="stats">
      <div class="stat">
        <div class="stat-label">Total Comments${search || source || visibility !== 'all' ? ' (Filtered)' : ''}</div>
        <div class="stat-value">${totalComments.toLocaleString()}</div>
      </div>
      <div class="stat">
        <div class="stat-label">In Rotation</div>
        <div class="stat-sources">
          ${Object.entries(SOURCE_LABELS).map(([key, label]) => `
            <a href="${buildUrl({ source: source === key ? '' : key, page: 1 })}"
               class="source-badge source-${key}${source === key ? ' active' : ''}"
               title="${source === key ? 'Show all sources' : `Show only ${label}`}">
              ${label} ${(sourceCounts[key] || 0).toLocaleString()}
            </a>`).join('')}
            <a href="${buildUrl({ show: visibility === 'hidden' ? 'all' : 'hidden', page: 1 })}"
               class="source-badge source-hidden${visibility === 'hidden' ? ' active' : ''}"
               title="${visibility === 'hidden' ? 'Show all comments' : 'Show only hidden comments'}">
              Hidden ${(sourceCounts.hidden || 0).toLocaleString()}
            </a>
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">Current Page</div>
        <div class="stat-value">${page} / ${totalPages}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Showing</div>
        <div class="stat-value">${offset + 1}-${Math.min(offset + limit, totalComments)}</div>
      </div>
    </div>

    <div class="search-bar">
      <form method="GET" action="/admin" style="display: flex; gap: 10px; flex: 1;">
        <input 
          type="text" 
          name="search" 
          placeholder="Search comments..." 
          value="${escapeHtml(search)}"
        >
        <input type="hidden" name="sort" value="${sortBy}">
        <input type="hidden" name="order" value="${sortOrder}">
        <input type="hidden" name="limit" value="${limit}">
        <select name="source" onchange="this.form.submit()" aria-label="Filter by source">
          <option value=""${source ? '' : ' selected'}>All sources</option>
          ${Object.entries(SOURCE_LABELS).map(([key, label]) =>
            `<option value="${key}"${source === key ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <select name="show" onchange="this.form.submit()" aria-label="Filter by visibility">
          ${Object.entries(VISIBILITY_LABELS).map(([key, label]) =>
            `<option value="${key}"${visibility === key ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <button type="submit">Search</button>
        ${search || source || visibility !== 'all' ? `<a href="${buildUrl({ search: '', source: '', show: 'all', page: 1 })}" class="search-bar clear-btn" style="padding: 10px 20px; text-decoration: none; border-radius: 4px; color: white;">Clear</a>` : ''}
      </form>
    </div>
    
    <table>
      <thead>
        <tr>
          <th class="id-col">
            <a href="${toggleSort('id')}">
              ID <span class="sort-icon">${sortIcon('id')}</span>
            </a>
          </th>
          <th class="source-col">
            <a href="${toggleSort('source')}">
              Source <span class="sort-icon">${sortIcon('source')}</span>
            </a>
          </th>
          <th>Comment Preview</th>
          <th class="length-col">
            <a href="${toggleSort('body_length')}">
              Length <span class="sort-icon">${sortIcon('body_length')}</span>
            </a>
          </th>
          <th class="page-col">
            <a href="${toggleSort('page')}">
              Page <span class="sort-icon">${sortIcon('page')}</span>
            </a>
          </th>
        </tr>
      </thead>
      <tbody>
        ${rows.length === 0 ? `
          <tr>
            <td colspan="5" style="text-align: center; padding: 40px; color: #666;">
              No comments found${search ? ` matching "${escapeHtml(search)}"` : ''}${source ? ` from ${SOURCE_LABELS[source]}` : ''}${visibility !== 'all' ? ` (${VISIBILITY_LABELS[visibility].toLowerCase()})` : ''}
            </td>
          </tr>
        ` : rows.map(row => `
          <tr${row.hidden ? ' class="hidden-row"' : ''}>
            <td class="id-col">${row.id}</td>
            <td class="source-col">${SOURCE_LABELS[sourceKey(row)]
              ? `<span class="source-badge source-${sourceKey(row)}">${SOURCE_LABELS[sourceKey(row)]}</span>`
              : `<span class="source-badge source-other">${escapeHtml(row.source)}</span>`}</td>
            <td class="body-preview">${highlightMatch(censorText(row.body_preview), search)}${row.body_length > 200 ? '...' : ''}${row.hidden ? `<span class="hidden-reason">Hidden — ${escapeHtml(row.hidden_reason || 'no reason recorded')}</span>` : ''}</td>
            <td class="length-col">${row.body_length}</td>
            <td class="page-col">${row.page || '-'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    
    <div class="pagination">
      ${page > 1 ? `<a href="${buildUrl({ page: page - 1 })}">← Previous</a>` : ''}
      
      ${Array.from({ length: Math.min(10, totalPages) }, (_, i) => {
    const pageNum = i + 1;
    if (pageNum === page) {
      return `<span class="current">${pageNum}</span>`;
    }
    return `<a href="${buildUrl({ page: pageNum })}">${pageNum}</a>`;
  }).join('')}
      
      ${totalPages > 10 ? `<span>...</span><a href="${buildUrl({ page: totalPages })}">${totalPages}</a>` : ''}
      
      ${page < totalPages ? `<a href="${buildUrl({ page: page + 1 })}">Next →</a>` : ''}
    </div>
  </div>
</body>
</html>
  `;
}

// ============================================================================
// STARTUP
// ============================================================================

if (!ADMIN_TOKEN) {
  console.warn("ADMIN_TOKEN is not set — /admin is publicly accessible.");
}

app.listen(port, () => console.log(`MTG Truther listening on port ${port}`));