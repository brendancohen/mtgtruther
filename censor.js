const {
  RegExpMatcher,
  TextCensor,
  DataSet,
  parseRawPattern,
  englishDataset,
  englishRecommendedTransformers,
  asteriskCensorStrategy,
} = require("obscenity");
const cheerio = require("cheerio");
const naughtyWords = require("naughty-words");

// The word list itself is not committed to this repo — it comes from the
// published `naughty-words` dictionary (the LDNOOBW list) in node_modules.
//
// obscenity's bundled dataset is the curated engine: its whitelist is what keeps
// ordinary words ("class", "scrape", "grape", "therapist") from being flagged.
// We use that as the base, then fill its gaps with the published list — adding
// only entries obscenity doesn't already catch, each anchored at word boundaries
// (`|`) so no ordinary word is masked.
const base = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

const gapTerms = (naughtyWords.en || []).filter(
  (word) => !word.includes(" ") && !base.hasMatch(word)
);

const dataset = gapTerms.reduce(
  (ds, word) => ds.addPhrase((phrase) => phrase.addPattern(parseRawPattern(`|${word}|`))),
  new DataSet().addAll(englishDataset)
);

const matcher = new RegExpMatcher({
  ...dataset.build(),
  ...englishRecommendedTransformers,
});

const textCensor = new TextCensor().setStrategy(asteriskCensorStrategy());

// Replace flagged terms with asterisks. Asterisk strategy preserves length, so
// downstream character-based truncation stays predictable.
function censorText(text) {
  if (!text) return text;
  const matches = matcher.getAllMatches(text);
  return matches.length > 0 ? textCensor.applyTo(text, matches) : text;
}

// Censor only the text nodes of an HTML fragment, so tags, attributes and URLs
// can never be corrupted by the replacement.
function censorHtml(html) {
  if (!html) return html;
  const $ = cheerio.load(html, null, false);

  const walk = (nodes) => {
    nodes.each((_, node) => {
      if (node.type === "text") {
        node.data = censorText(node.data);
      } else if (node.name === "script" || node.name === "style") {
        // leave raw script/style content alone
      } else if (node.children && node.children.length > 0) {
        walk($(node).contents());
      }
    });
  };

  walk($.root().contents());
  return $.html();
}

// Used to keep flagged words out of aggregate output such as /stats.
function isProfane(text) {
  if (!text) return false;
  return matcher.hasMatch(text);
}

module.exports = { censorText, censorHtml, isProfane };
