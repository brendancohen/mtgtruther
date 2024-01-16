const fetch = require("node-fetch");
const cheerio = require("cheerio");
const dbPool = require("./dbPool");
const pgFormat = require("pg-format");

async function clearDuplicates(dbClient){
  try {
    console.log("Clearing duplicates...");
    const res = await dbClient.query(
      "DELETE FROM truths WHERE id NOT IN ( SELECT DISTINCT ON (body) id FROM truths ORDER BY body, id);"
    );
    console.log(`${res.rowCount} duplicates cleared.`);
  } catch (e) {
    dbClient.release();
    console.error("DB error while clearing duplicates", e);
    process.exit(-1);
  }
}

module.exports = async function doScrape() {
const dbClient = await dbPool.connect();

  try {

    const queryRes = await dbClient.query(
      "SELECT MAX(page) FROM truths"
    );

    //max last page.
    const lastSyncedPage = queryRes.rows[0]?.max ?? 1;
    
    //parse (newMax) from aria-label
    const body = await fetch(
      "https://feedback.wizards.com/forums/918667-mtg-arena-bugs-product-suggestions/suggestions/44184111-algorithm-improvement?page=1"
    ).then((res) => res.text());
    const scrapedComments = [];
    const $ = cheerio.load(body);
    const selector = '[aria-label*="Page "]';
    const elements = $(selector);

    newMax = 1;
    elements.each((index, element) => {
      newMax = parseInt($(element).text(),10) > parseInt(newMax,10) ? $(element).text() : newMax
    });
    console.log(newMax);
    console.log(lastSyncedPage);

    $(".uvListItem .uvUserActionBody .typeset").each((index, el) => {
      scrapedComments.push([$(el).text(), $(el).html(), 1]);
    });

    await dbClient.query(
        pgFormat(
          "INSERT INTO truths (body, bodyhtml, page) VALUES %L",
          scrapedComments
        )
      );
    
    console.log(`Done importing page 1.`);

    //if newMax not equal to lastSynced, parse (newMax-max) additional pages
    if (newMax != lastSyncedPage) {
      const difference = parseInt(newMax,10) - parseInt(lastSyncedPage,10)
      for(i = 1; i<= difference; i++){

        const currPage = i+1;
        const fetchUrl = `https://feedback.wizards.com/forums/918667-mtg-arena-bugs-product-suggestions/suggestions/44184111-algorithm-improvement?page=${currPage}`
        console.log(fetchUrl)
        try{
          const body = await fetch(fetchUrl).then((res) => res.text());
          const $ = cheerio.load(body);
          const scrapedComments = [];
    
          $(".uvListItem .uvUserActionBody .typeset").each((index, el) => {
            scrapedComments.push([$(el).text(), $(el).html(), currPage]);
          });
          await dbClient.query(
              pgFormat(
                "INSERT INTO truths (body, bodyhtml, page) VALUES %L",
                scrapedComments
              )
            );
          console.log(`Done importing page ${currPage}.`);
        }catch(e) {
          console.error(`Failed to fetch page ${currPage}. Status: ${response.status}`);
        }
      }

      await dbClient.query(
        pgFormat(
          "UPDATE truths SET page=%L WHERE page=%L",
          newMax,
          lastSyncedPage
        )
      );
      
      console.log(`Updated "page" to ${newMax} where "page" equals ${lastSyncedPage}.`);
    }
    await clearDuplicates(dbClient);
    console.log("scraping done");
    dbClient.release();
  } catch (e) {
    dbClient.release();
    console.error("DB error", e);
    process.exit(-1);
  }
};
