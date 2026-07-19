const {
  RegExpMatcher,
  TextCensor,
  DataSet,
  pattern,
  englishDataset,
  englishRecommendedTransformers,
  asteriskCensorStrategy,
} = require("obscenity");
const cheerio = require("cheerio");

// The bundled English dataset covers most profanity (including leetspeak like
// "r@pe" / "sh1t"), but misses a few terms that show up in this corpus. Patterns
// are word-boundary anchored with `|` so ordinary words stay clean -- important
// here, since "scrape", "grape", "therapist", "pedometer" and "torpedo" all
// contain flagged substrings.
const dataset = new DataSet()
  .addAll(englishDataset)
  .addPhrase((phrase) =>
    phrase
      .setMetadata({ originalWord: "rape" })
      .addPattern(pattern`|raping`)
      .addPattern(pattern`|gangrape`)
      .addPattern(pattern`|gangraping`)
  )
  .addPhrase((phrase) =>
    phrase.setMetadata({ originalWord: "molest" }).addPattern(pattern`|molest`)
  )
  .addPhrase((phrase) =>
    phrase
      .setMetadata({ originalWord: "pedophile" })
      .addPattern(pattern`|pedo|`)
      .addPattern(pattern`|pedophil`)
      .addPattern(pattern`|paedophil`)
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
