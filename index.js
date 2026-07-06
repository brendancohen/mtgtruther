const express = require("express");
const cheerio = require("cheerio");
const dbPool = require("./dbPool");
const doScrape = require("./doScrape");
const app = express();

const port = process.env.PORT || 8080;
const scrapeInterval = 12 * 60 * 60 * 1000;

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

function parseLengthFilters(req) {
  const minLength = parseInt(req.query.min_length) || 1;
  const maxLength = parseInt(req.query.max_length) || 999999;
  return { minLength, maxLength };
}

function formatComment(selectedRow, req) {
  if (!selectedRow) return "";

  const isText = req.query.mode === "text";
  let comment = isText ? selectedRow.body : selectedRow.bodyhtml;

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

app.get("/scrape", requireAuth, async (req, res) => {
  res.send('Scraping in progress');
  doScrape().catch(err => console.error('Scrape failed:', err));
});

app.get("/truth", withDbClient(async (req, res, dbClient) => {
  const { minLength, maxLength } = parseLengthFilters(req);
  
  console.log("Fetching random truth.");

  const queryRes = await dbClient.query(
    "SELECT * FROM truths WHERE LENGTH(body) >= $1 AND LENGTH(body) <= $2 ORDER BY RANDOM() LIMIT 1",
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
    "SELECT * FROM truths WHERE body ~* $1 AND LENGTH(body) >= $2 AND LENGTH(body) <= $3 ORDER BY RANDOM() LIMIT 1",
    [`\\y${searchTerm}\\y`, minLength, maxLength]
  );

  const comment = formatComment(queryRes.rows[0], req);

  console.log(`Sending search result for term: ${searchTerm}: `, comment);

  res.send(comment);
}));

app.get("/stats", withDbClient(async (req, res, dbClient) => {
  // Get basic counts
  const totalRes = await dbClient.query("SELECT COUNT(*) as total FROM truths");
  const total = parseInt(totalRes.rows[0].total);

  // Get length statistics
  const lengthRes = await dbClient.query(
    "SELECT AVG(LENGTH(body))::int as avg_length, MIN(LENGTH(body)) as min_length, MAX(LENGTH(body)) as max_length FROM truths"
  );

  // Get comments per page
  const pageRes = await dbClient.query(
    "SELECT page, COUNT(*) as count FROM truths GROUP BY page ORDER BY page"
  );

  // Get most common words (top 20, excluding common words)
  const wordsRes = await dbClient.query(`
    SELECT word, COUNT(*) as frequency
    FROM (
      SELECT regexp_split_to_table(LOWER(body), E'\\\\s+') as word
      FROM truths
    ) words
    WHERE LENGTH(word) > 3
      AND word NOT IN ('the', 'and', 'that', 'this', 'with', 'have', 'from', 'they', 'been', 'were', 'your', 'just', 'their', 'than', 'when', 'what', 'about', 'which', 'there', 'would', 'could', 'should')
    GROUP BY word
    ORDER BY frequency DESC
    LIMIT 20
  `);

  // Get last scrape info (when the newest page was added)
  const lastScrapeRes = await dbClient.query(
    "SELECT MAX(page) as last_page FROM truths"
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
    most_common_words: wordsRes.rows.map(r => ({
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
  const sortBy = req.query.sort || 'id';
  const sortOrder = req.query.order || 'desc';

  // Validate sort column to prevent SQL injection
  const validSortColumns = ['id', 'body_length', 'page'];
  const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'id';
  const order = sortOrder === 'asc' ? 'ASC' : 'DESC';

  let countQuery, countParams, dataQuery, dataParams;

  if (search) {
    // With search filter
    countQuery = 'SELECT COUNT(*) FROM truths WHERE body ILIKE $1';
    countParams = [`%${search}%`];

    dataQuery = `
      SELECT 
        id, 
        LEFT(body, 200) as body_preview, 
        LENGTH(body) as body_length, 
        page 
      FROM truths 
      WHERE body ILIKE $3
      ORDER BY ${sortColumn === 'body_length' ? 'LENGTH(body)' : sortColumn} ${order}
      LIMIT $1 OFFSET $2
    `;
    dataParams = [limit, offset, `%${search}%`];
  } else {
    // Without search filter
    countQuery = 'SELECT COUNT(*) FROM truths';
    countParams = [];

    dataQuery = `
      SELECT 
        id, 
        LEFT(body, 200) as body_preview, 
        LENGTH(body) as body_length, 
        page 
      FROM truths 
      ORDER BY ${sortColumn === 'body_length' ? 'LENGTH(body)' : sortColumn} ${order}
      LIMIT $1 OFFSET $2
    `;
    dataParams = [limit, offset];
  }

  const countRes = await dbClient.query(countQuery, countParams);
  const totalComments = parseInt(countRes.rows[0].count);
  const totalPages = Math.ceil(totalComments / limit);

  const queryRes = await dbClient.query(dataQuery, dataParams);

  res.send(renderAdminPage({
    page,
    limit,
    offset,
    totalComments,
    totalPages,
    rows: queryRes.rows,
    search,
    sortBy: sortColumn,
    sortOrder
  }));
}));
// ============================================================================
// ADMIN PAGE TEMPLATE WITH SEARCH AND SORT
// ============================================================================

function renderAdminPage({ page, limit, offset, totalComments, totalPages, rows, search, sortBy, sortOrder }) {
  const buildUrl = (params) => {
    const url = new URLSearchParams({
      page: params.page || page,
      limit: params.limit || limit,
      search: params.search !== undefined ? params.search : search,
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
    .page-col { width: 80px; text-align: center; }
    .length-col { width: 100px; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <h1>MTG Truther UI</h1>
    
    <div class="stats">
      <div class="stat">
        <div class="stat-label">Total Comments${search ? ' (Filtered)' : ''}</div>
        <div class="stat-value">${totalComments.toLocaleString()}</div>
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
        <button type="submit">Search</button>
        ${search ? `<a href="${buildUrl({ search: '', page: 1 })}" class="search-bar clear-btn" style="padding: 10px 20px; text-decoration: none; border-radius: 4px;">Clear</a>` : ''}
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
            <td colspan="4" style="text-align: center; padding: 40px; color: #666;">
              No comments found${search ? ` matching "${escapeHtml(search)}"` : ''}
            </td>
          </tr>
        ` : rows.map(row => `
          <tr>
            <td class="id-col">${row.id}</td>
            <td class="body-preview">${highlightMatch(row.body_preview, search)}${row.body_length > 200 ? '...' : ''}</td>
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

// Auto-scrape every 12 hours. Note: on a scale-to-zero host the machine may be
// suspended when this would fire, so treat scheduling as best-effort.
setInterval(() => {
  doScrape().catch(err => console.error("Scheduled scrape failed:", err));
}, scrapeInterval);

if (!ADMIN_TOKEN) {
  console.warn("ADMIN_TOKEN is not set — /admin and /scrape are publicly accessible.");
}

app.listen(port, () => console.log(`MTG Truther listening on port ${port}`));