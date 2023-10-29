const fetch = require("node-fetch");
const cheerio = require("cheerio");
const doClearDuplicates = require("./doClearDuplicates");
const dbPool = require("./dbPool");
const pgFormat = require("pg-format");

module.exports = async function doScrape() {
const dbClient = await dbPool.connect();

  try {

    const queryRes = await dbClient.query(
      "SELECT MAX(page) FROM truths"
    );

    //max last page.
    const lastSyncedPage = queryRes.rows[0] ? queryRes.rows[0].max : 1;
    
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
    doClearDuplicates();

    //if newMax not equal to lastSynced, parse (newMax-max) additional pages
    if (newMax != lastSyncedPage) {
      const difference = parseInt(newMax,10) - parseInt(lastSyncedPage,10)
      for(i = 1; i<= difference; i++){

        const currPage = i+1;
        const body = await fetch(
          "https://feedback.wizards.com/forums/918667-mtg-arena-bugs-product-suggestions/suggestions/44184111-algorithm-improvement?page="+currPage
        ).then((res) => res.text());
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
        doClearDuplicates();
      }
    }
    console.log("scraping done");
    dbClient.release();
  } catch (e) {
    dbClient.release();
    console.error("DB error", e);
    process.exit(-1);
  }
};
