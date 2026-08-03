---
name: verify-ui
description: Run the headless smoke test against The World's Bookshelf to prove the page actually works after a change — cards render, filters populate and filter, both languages work, no console errors. Use after editing index.html, after a data refresh, before publishing, or when asked to test, verify, check the page, or confirm nothing broke.
---

# Verify the UI

The repo has no build step and no test framework, so the historical way to check
a change was to open a browser and look. That catches layout problems and misses
everything that happens after an async fetch.

A concrete example this exists to prevent: the language filter was built **once**
at startup from the curated list, so the twenty languages added by enrichment
were present in `data/books.json` but unreachable in the dropdown. The page
looked completely normal. Only asserting on the post-load DOM caught it.

## Run it

The test needs the site served over HTTP — `file://` breaks both `fetch` and
Supabase CORS.

```bash
python -m http.server 8000     # separate terminal, from the repo root
node scripts/smoke-test.js
```

Options: `--settle 12000` (raise if the data fetch is slow) and `--url`, which
accepts either a base (`--url http://localhost:3000`) or a full page URL ending
in `.html`. The second form matters for fault injection: it lets you point the
test at a deliberately broken copy without overwriting `index.html`.

```bash
node scripts/smoke-test.js --url http://localhost:8000/index-broken.html
```

`jsdom` is an optional, dev-only dependency and is deliberately **not** in a
`package.json` — the site ships as static files with no install step. If it is
missing the script prints instructions and exits **0**, so it can never fail a
publish for being unconfigured:

```bash
npm install --no-save jsdom
```

## What it asserts

| Check | Catches |
|---|---|
| >200 cards render | `loadDynamicBooks()` silently failing |
| >140 cards | Only curated books loaded — the async merge died |
| >30 language options | Filter not rebuilt after the async load |
| Ukrainian/Catalan/Hungarian selectable | Enrichment languages unreachable in the UI |
| Covers have `http` URLs | `coverUrl` mapping broken |
| Filtering narrows, clearing restores | Options exist but do not actually filter |
| Sort sequences are non-increasing | Sort control wired up but not applied |
| Search finds a genre and a country | Search narrowed back to title/author only |
| Clear button appears, then resets | No escape hatch from a zero-result state |
| Language tags are `<button>` | Tags moved back inside the Goodreads `<a>` |
| Clicking a tag filters and updates the URL | Delegated handler or URL sync broken |
| No `<script>` inside the grid | Book text interpolated without `escapeHtml` |
| Title non-empty **before** any toggle | The `updateUI()` trap — see the `i18n` skill |
| Chinese toggle changes title, cards survive | i18n regressions |
| Footer release date non-empty | The blank-footer bug specifically |
| No uncaught page errors | Anything throwing during startup |

**Assert sequences, not endpoints.** The sort checks originally compared only the
first and last card. An unsorted list satisfied that by chance, so removing the
sort entirely still passed. They now verify the whole sequence.

**Never skip a check when its precondition fails.** An early `if (tag) { … }`
guard meant a missing element quietly dropped two checks and the run still
reported success, just with a smaller total. Failing preconditions must fail
loudly instead.

## Reading a failure

A count in the detail column is the diagnosis:

- **135 cards** — exactly the curated list. `data/books.json` did not load at all.
- **27 languages** — exactly the curated vocabulary. The filter was not rebuilt
  after the async load; look at `populateLangFilter()` and where it is called.
- **450 cards but 0 covers** — data loaded, the `coverUrl` field mapping is wrong.

## Extending it

Add a `check(name, pass, detail)` line. Two rules:

- **Assert on a number, not on truthiness.** "Cards exist" passes with only the
  curated list loaded, which is the failure being hunted.
- **Prove the interaction, not just the markup.** Dispatch a real `change` event
  and compare counts. An `<option>` existing does not mean it filters.

## Verifying the test itself

A test that never fails is worse than no test. After changing it, inject the
fault it is supposed to catch and confirm it goes red:

```bash
cp index.html /tmp/backup.html
# e.g. point the data fetch at a missing file
sed -i "s|fetch('data/books.json')|fetch('data/NOPE.json')|" index.html
node scripts/smoke-test.js      # must FAIL
cp /tmp/backup.html index.html
node scripts/smoke-test.js      # must PASS again
```

Watch the quote style when injecting — the fetch uses single quotes, and a
pattern with double quotes silently matches nothing, which looks exactly like
the test failing to detect the fault.
