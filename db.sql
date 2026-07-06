-- Canonical schema for the `truths` table.
--
-- `body_hash` is a generated md5 of `body` with a unique index; the scraper
-- relies on it for `ON CONFLICT (body_hash) DO NOTHING` deduplication. The app
-- never inserts body_hash directly — Postgres derives it.
create table if not exists truths (
  id serial primary key,
  body text not null,
  bodyhtml text,
  page int,
  body_hash text generated always as (md5(body)) stored
);

create unique index if not exists truths_body_hash_key on truths (body_hash);

-- Migrating an existing table that predates body_hash? Run once, after removing
-- any pre-existing duplicate bodies:
--
--   ALTER TABLE truths
--     ADD COLUMN body_hash text GENERATED ALWAYS AS (md5(body)) STORED;
--   CREATE UNIQUE INDEX truths_body_hash_key ON truths (body_hash);
