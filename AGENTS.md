# AGENTS.md

Instructions for coding agents working on **The World's Bookshelf**.

## What this is

A single-page site showing bestselling books from the last ~10 years across 12
countries plus classic literature, with the languages each book has been
translated into. Full English/Chinese i18n. Live at
`https://hannah-ge.github.io/bestseller-books/`.

Everything ships as static files. There is no build step, no bundler, no
package.json. Open `index.html` and it runs.

## Layout

| Path | Role |
|---|---|
| `index.html` | The entire app — markup, CSS, i18n, ~137 curated books, voting engine. ~1,650 lines |
| `data/books.json` | **Generated.** NYT data refreshed weekly by the Action |
| `scripts/fetch-books.js` | The weekly scraper (NYT + Google Books + Google Translate) |
| `scripts/validate-books.js` | Publish gate. Runs in CI between fetch and commit |
| `supabase-setup.sql` | Backend schema for global ratings. Safe to re-run |
| `higashino-keigo.html` | Standalone tribute page |
| `.github/workflows/update-books.yml` | Monday 09:00 UTC refresh |

The page merges two sources at runtime: the ~137 books hardcoded in `index.html`
(curated, rich language data) and everything in `data/books.json` (NYT, English
only). Merge is by lowercased title; `loadDynamicBooks()` runs **async after**
first paint, so counting cards immediately after load undercounts.

## Hard rules

1. **Never hand-edit `data/books.json`.** It is generated and will be overwritten.
   Curated entries belong in the inline `books` array in `index.html`.
2. **The agent cannot push.** The CLI pins git to a different identity and gets a
   403 on this repo. Make commits, then give the user the push command to run.
3. **Run the gate before proposing a publish:** `node scripts/validate-books.js`.
4. **Never weaken the security model** in `supabase-setup.sql` to make a test pass.
5. The Supabase anon key in `index.html` is a **publishable** key and is meant to
   be committed. Nothing depends on hiding it. Do not "fix" this.

## Non-obvious traps

These each cost real debugging time. Read before editing.

- **`updateUI()` only runs from `setLang()`** — never on initial page load, which
  relies on the static English markup. Any text derived in JS must *also* be set
  during the initial render, or it renders blank until the user toggles language.
  This caused a blank footer that only appeared after switching languages.

- **Card structure is load-bearing.** A card is `<article class="card">` with an
  inner `<a class="card-link">` and the vote row as a **sibling** of the anchor.
  Putting buttons inside the `<a>` is invalid HTML and makes votes navigate to
  Goodreads.

- **The grid is rebuilt with `innerHTML` on every render**, so all card event
  handling is **delegated on `#grid`**. Do not attach listeners to cards directly.

- **The vote key is `` `${title}::${author}` `` lowercased**, not ISBN. NYT books
  often lack a usable ISBN, and this key survives the weekly refresh.

- **Resetting ratings means deleting from `book_voters`, not `book_votes`.**
  Tallies are recounted from the ballots on every vote, so clearing tallies alone
  gets resurrected on the next vote.

- **Supabase publishable keys (`sb_publishable_…`) are not JWTs** and are rejected
  on an `Authorization: Bearer` header. `supabaseHeaders()` sends `Bearer` only
  when the key starts with `eyJ`; otherwise `apikey` alone is used.

- **All asset paths are relative** (`data/books.json`, `bookshelf-bg.jpg`). Keep it
  that way — it is why the site can move to any host or path unchanged.

- **Supabase is CORS-blocked over `file://`.** To test voting locally you must
  serve over HTTP: `python -m http.server 8000`.

## Known data debt

Fixed (2026) — kept here because the failure mode is the interesting part:

- Enrichment used to call Google Books keyless, which returns **HTTP 429** from a
  shared runner IP. `fetchGoogleBooksLanguages` swallowed it and returned
  `{ languages: [], cover: "" }`, so a completely failed run still produced a
  green Action and a live commit. Every fetched book ended up `["English"]` with
  no cover, for weeks, unnoticed.
  Now **OpenLibrary** is the primary source — keyless, unthrottled, and it
  aggregates *all editions*, which is exactly what a site about translations
  needs. Google Books is only consulted if `GOOGLE_BOOKS_KEY` is set.
  Result: multi-language 0% → 43%, covers 0% → 83%, 0 failures over 348 books.
- Titles are re-normalised through `toTitleCase` on **every** run, not just on
  insert, so the 41 legacy ALL-CAPS titles are gone and cannot come back.
- The year now comes from the *requested* date, not `bestsellers_date` — a
  Jan-15 list is dated to the prior December, which is what put books in 2015.
- `data/books.json` no longer grows without bound: the current-week fetch is
  capped to the same top-5 as the historical sampler, and books older than the
  window are pruned.

Still outstanding:

- `GOOGLE_TRANSLATE_KEY` is unset, so `titleZh`/`descriptionZh` are all empty.
  This one genuinely cannot be fixed in code — it needs the secret. The script
  says so loudly and the gate tracks the percentage.
- ~17% of books still have no cover and ~57% resolve to English only. That is
  usually a genuinely single-edition book, not a bug.

Fixing any of these lowers the percentage, which the gate then locks in.

### Two traps worth knowing

- **The prune floor has a year of slack** (`PRUNE_SLACK_YEARS`). Removing it
  looks harmless and is not: because January lists carry December dates, a
  strict 10-year floor deletes the boundary year — which on the first run meant
  The Martian, The Girl on the Train and All the Light We Cannot See, three of
  the best-translated books in the set.
- **OpenLibrary returns MARC 21 codes, not ISO 639-1** — `fre` not `fra`, `ger`
  not `deu`, `chi` not `zho`. `MARC_TO_NAME` maps them to the display names the
  filter uses; an unmapped code is dropped rather than shown raw. If you add a
  language, add it to `nativeNames` in `index.html` too or it appears in English.

## Verifying a change

```bash
node scripts/validate-books.js        # publish gate
python -m http.server 8000            # then open http://localhost:8000
```

For anything touching voting, test on `localhost`, not `file://`, and confirm both
the vote *and* the un-vote path, plus the blocked-vote toast.
