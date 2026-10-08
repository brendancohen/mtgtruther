# MTG Truther

Serves random comments about the MTG Arena shuffler algorithm.

## Sources

- **MTG Arena feedback forum** (original) — the [algorithm improvement](https://feedback.wizards.com/forums/918667-mtg-arena-bugs-product-suggestions/suggestions/44184111-algorithm-improvement) thread. Wizards moved the forum into a private, sign-in-only archive in Oct 2026, so it can no longer be scraped; the comments captured before then live only in the database.
- **Steam Community** — shuffler-themed posts from the [MTG Arena discussions](https://steamcommunity.com/app/2141910/discussions/), collected with `steamScrape.js` and tagged `source = 'steam'`.

### Collecting from Steam

Ingestion is a manual, reviewed process rather than a background job:

```bash
npm run scrape:steam                    # scrape and write steam-review.md / .json for review
node steamScrape.js --reclassify        # re-run the filter over the cached scrape after tuning
node steamScrape.js --insert            # insert exactly the reviewed set (needs DATABASE_URL)
```

Quoted replies are stripped, and posts are kept only if they touch the shuffler/rigging theme and aren't banter or decklists. The review files contain raw comments and are git-ignored. To back out every Steam comment: `DELETE FROM truths WHERE source = 'steam';`

## API Endpoints

### Get Random Comment
```bash
# Get random comment (HTML format)
GET /truth

# Get random comment (plain text)
GET /truth?mode=text

# Get shortened version (500 chars)
GET /truth?short=true

# Filter by comment length (characters)
GET /truth?min_length=100&max_length=800

# Combine options
GET /truth?mode=text&short=true
```

### Search Comments
```bash
# Search for comments containing "mana" (case-insensitive, whole word match)
GET /search?q=mana

# Search with text mode
GET /search?q=shuffler&mode=text

# Search with short mode
GET /search?q=bug&short=true
```

**Note:** Search matches whole words only. `?q=test` will match "test" but not "greatest" or "testing". Search scans the full comment body and also accepts `min_length` / `max_length`.

## Add it to your Twitch Chat

1. Install a chat bot like MTGBot or Nightbot
2. Add commands to your bot to run the API endpoints `truth` or `search`. MTGBot commands should be templated like so:

**Random Comment:**
```
!addcom !shuffler %remoteapi https://mtgtruther.fly.dev/truth?mode=text&short=true%
```

**With Search (e.g., only mana complaints):**
```
!addcom !search %remoteapi https://mtgtruther.fly.dev/search?q=%input%&mode=text&short=true%
```

## Profanity filtering

Neither source forum filters much, so comments are censored at serve time: flagged words are masked with asterisks in `/truth`, `/search` and the admin previews, and excluded from the `/stats` word list.

The word list is not kept in this repo. Matching combines two published dictionaries pulled in as dependencies: [`obscenity`](https://www.npmjs.com/package/obscenity) is the engine (its curated whitelist is what keeps ordinary words like *class* or *scrape* from being flagged, and it also handles common character substitutions), and any terms it misses are filled in from the [`naughty-words`](https://www.npmjs.com/package/naughty-words) list, anchored at word boundaries. See [censor.js](censor.js).

Masking applies to the API response only — originals are stored unmodified in the database — and it masks words, not surrounding context.

## Admin panel

`GET /admin` serves a searchable, sortable web UI over the stored comments. (`GET /scrape` is retired and returns `410 Gone`; see [Collecting from Steam](#collecting-from-steam).)

Set the `ADMIN_TOKEN` environment variable to require a shared secret on `/admin` — pass it as `?token=...` or an `x-admin-token` header. If `ADMIN_TOKEN` is unset, the route remains publicly accessible.