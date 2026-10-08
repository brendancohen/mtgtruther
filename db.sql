-- Canonical schema for the `truths` table, matching production.
--
-- `body_hash` is generated from `body` with whitespace normalized: leading and
-- trailing spaces trimmed and every run of whitespace collapsed to one space. The
-- unique index on it is what `ON CONFLICT (body_hash) DO NOTHING` relies on, so
-- re-scraped posts that differ only in spacing or line breaks are deduplicated.
-- The app never inserts body_hash directly — Postgres derives it.
--
-- Quirk: TRIM runs before the collapse and only strips spaces, so a trailing
-- newline survives as a trailing space and hashes differently. The scrapers trim
-- all whitespace before inserting, so they never hit this.
create table if not exists truths (
  id serial primary key,
  body text not null,
  bodyhtml text,
  page int,
  body_hash text generated always as (md5(regexp_replace(trim(both from body), '\s+', ' ', 'g'))) stored,
  source text,  -- null for the original feedback forum, 'steam' for steamScrape.js
  hidden boolean not null default false,  -- kept for dedup, never served
  hidden_reason text
);

create unique index if not exists idx_truths_body_hash on truths (body_hash);

-- Adding `source` to an existing table must be done by the table owner (the app
-- role usually can't ALTER):
--
--   ALTER TABLE truths ADD COLUMN source text;

-- Adding moderation columns to an existing table (owner only):
--
--   ALTER TABLE truths ADD COLUMN hidden boolean NOT NULL DEFAULT false, ADD COLUMN hidden_reason text;
