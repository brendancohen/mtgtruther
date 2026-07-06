# MTG Truther

Grabs random comments from the MTG Arena feedback forum about the shuffler algorithm.

Source: https://feedback.wizards.com/forums/918667-mtg-arena-bugs-product-suggestions/suggestions/44184111-algorithm-improvement

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

## Admin panel

`GET /admin` serves a searchable, sortable web UI over the stored comments, and `GET /scrape` triggers an immediate scrape.

Set the `ADMIN_TOKEN` environment variable to require a shared secret on both routes — pass it as `?token=...` or an `x-admin-token` header. If `ADMIN_TOKEN` is unset, the routes remain publicly accessible.