const dbPool = require("./dbPool");

module.exports = async function doClearDuplicates() {
  const dbClient = await dbPool.connect();

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
};
