const fetch = require("node-fetch");
const cheerio = require("cheerio");
const dbPool = require("./dbPool");
const pgFormat = require("pg-format");

// Helper function to add delays between requests
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function doScrape() {
  const dbClient = await dbPool.connect();

  try {
    // Get the highest page number we've scraped
    const queryRes = await dbClient.query(
      "SELECT MAX(page) FROM truths"
    );
    const lastSyncedPage = queryRes.rows[0]?.max ?? 0;

    console.log(`Last synced page: ${lastSyncedPage}`);

    // Fetch page 1 to determine the total number of pages
    const body = await fetch(
      "https://feedback.wizards.com/forums/918667-mtg-arena-bugs-product-suggestions/suggestions/44184111-algorithm-improvement?page=1"
    ).then((res) => res.text());

    const $ = cheerio.load(body);
    const selector = '[aria-label*="Page "]';
    const elements = $(selector);

    // Find the maximum page number
    let newMax = 1;
    elements.each((index, element) => {
      const pageNum = parseInt($(element).text(), 10);
      if (!isNaN(pageNum) && pageNum > newMax) {
        newMax = pageNum;
      }
    });

    console.log(`Total pages available: ${newMax}`);

    // ALWAYS scrape page 1 (new comments appear here)
    console.log(`Scraping page 1 for new comments...`);
    const scrapedComments = [];

    $(".uvListItem .uvUserActionBody .typeset").each((index, el) => {
      scrapedComments.push([$(el).text(), $(el).html(), 1]);
    });

    if (scrapedComments.length > 0) {
      // Use ON CONFLICT to handle duplicates gracefully
      await dbClient.query(
        pgFormat(
          "INSERT INTO truths (body, bodyhtml, page) VALUES %L ON CONFLICT (body_hash) DO NOTHING",
          scrapedComments
        )
      );
      console.log(`Processed ${scrapedComments.length} comments from page 1`);
    }

    // If there are NEW pages beyond what we've scraped before, get those too
    if (newMax > lastSyncedPage) {
      const startPage = lastSyncedPage + 1;
      console.log(`New pages detected! Scraping pages ${startPage} to ${newMax}...`);

      for (let currPage = startPage; currPage <= newMax; currPage++) {
        const fetchUrl = `https://feedback.wizards.com/forums/918667-mtg-arena-bugs-product-suggestions/suggestions/44184111-algorithm-improvement?page=${currPage}`;
        console.log(`Scraping page ${currPage}...`);

        // Add delay before each request (but not before the first one)
        if (currPage > startPage) {
          await sleep(2000);
        }

        try {
          const pageBody = await fetch(fetchUrl).then((res) => {
            if (!res.ok) {
              throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }
            return res.text();
          });

          const $page = cheerio.load(pageBody);
          const pageComments = [];

          $page(".uvListItem .uvUserActionBody .typeset").each((index, el) => {
            const bodyText = $page(el).text();
            const bodyHtml = $page(el).html();
            pageComments.push([bodyText, bodyHtml, currPage]);
          });

          if (pageComments.length > 0) {
            await dbClient.query(
              pgFormat(
                "INSERT INTO truths (body, bodyhtml, page) VALUES %L ON CONFLICT DO NOTHING",
                pageComments
              )
            );
            console.log(`Imported ${pageComments.length} comments from page ${currPage}`);
          } else {
            console.log(`No comments found on page ${currPage}`);
          }

        } catch (e) {
          console.error(`Failed to fetch page ${currPage}. Error: ${e.message}`);
          // Continue to next page instead of stopping entirely
        }
      }
    } else {
      console.log("No new pages to scrape.");
    }

    console.log("Scraping completed successfully");
    dbClient.release();

  } catch (e) {
    dbClient.release();
    console.error("DB error during scraping:", e);
    throw e; // Re-throw so caller knows it failed
  }
};