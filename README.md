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

# Get shortened version (250 chars)
GET /truth?short=true

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

**Note:** Search matches whole words only. `?q=test` will match "test" but not "greatest" or "testing".

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