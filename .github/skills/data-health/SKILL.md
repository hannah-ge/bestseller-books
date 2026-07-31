---
name: data-health
description: Diagnose the health of the bestseller data pipeline and the live site for The World's Bookshelf. Reports coverage gaps, probes the upstream OpenLibrary and NYT APIs to find silent failures, and checks the deployed site. Use when asked why covers, languages, or Chinese translations are missing, or for a general data quality report.
---

# Data health

The pipeline fails silently by design — `fetch-books.js` swallows every upstream
error and returns empty values, so the Action goes green while publishing degraded
data. Never conclude the data is fine because CI passed. Measure it.

## 1. Coverage report

```bash
node scripts/validate-books.js --strict
```

`--strict` turns existing debt into failures, which is what you want for a report
(in CI the gate runs without it so debt does not block).

For machine-readable output: `node scripts/validate-books.js --json`.

## 2. Probe upstream before blaming the data

A metric at or near 100% missing almost always means the upstream call is failing,
not that the data genuinely lacks the field. Confirm with a real request.

OpenLibrary is the primary enrichment source (keyless, aggregates all editions):

```bash
curl -s -H "User-Agent: worlds-bookshelf/1.0" \
  "https://openlibrary.org/search.json?q=dune+herbert&fields=language,cover_i&limit=5" \
  | head -c 400
```

- Empty `docs` — the query is too noisy. NYT titles often carry subtitles and
  series text; strip them before searching.
- A non-200, or a hang — check https://openlibrary.org/status before assuming
  the script is at fault.

Google Books is only used as a supplement when `GOOGLE_BOOKS_KEY` is set:

```bash
curl -s -o /dev/null -w "google-books: %{http_code}\n" \
  "https://www.googleapis.com/books/v1/volumes?q=dune+herbert&maxResults=1"
```

- `429` — rate limited. The keyless endpoint is shared across CI runner IPs.
  This is exactly what silently emptied the catalogue before; it is why
  OpenLibrary is now primary and why `httpJson` retries with backoff rather
  than swallowing the error.

Check the NYT side too if book counts look wrong:

```bash
curl -s -o /dev/null -w "nyt: %{http_code}\n" \
  "https://api.nytimes.com/svc/books/v3/lists/current/combined-print-and-e-book-fiction.json?api-key=$NYT_API_KEY"
```

Secrets that are simply unset produce empty output and a log line, never a failure.
Confirm `GOOGLE_TRANSLATE_KEY` and `NYT_API_KEY` exist in repo settings before
concluding translation is broken in code.

## 3. Check the deployed site

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://hannah-ge.github.io/bestseller-books/data/books.json
```

The page merges the inline curated books with `data/books.json` **asynchronously
after first paint**. Counting cards immediately after load undercounts — wait for
the network to settle before measuring, and do not report an early count as a bug.

## 4. Interpreting results

| Pattern | Meaning |
|---|---|
| One metric at ~100% | Upstream call failing silently — probe it |
| A metric rising week over week | New fetches degraded; older curated data still good |
| Book count flat while dates advance | Merge is matching everything as existing; check the dedup key |
| Only recent years affected | Current-week path differs from the historical path |

Report absolute counts **and** percentages, and always name the suspected root
cause with the evidence for it. Do not propose fixes to `data/books.json` — it is
generated, and edits are overwritten on the next run. Fix `scripts/fetch-books.js`.
