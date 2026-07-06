const { Pool } = require("pg");
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// Log idle-client errors but keep the process alive; node-postgres removes the
// broken client from the pool automatically, so a transient blip shouldn't crash us.
dbPool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client:", err);
});

module.exports = dbPool;
