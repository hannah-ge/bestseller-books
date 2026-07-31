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

The weekly pipeline is currently degraded, and the gate reports it as warnings
rather than blocking, so the Action stays green:

- Google Books enrichment returns **HTTP 429** (keyless, shared runner IP), which
  `fetchGoogleBooksLanguages` swallows — so `languages` is `["English"]` and
  `googleCover` is empty for **every** fetched book.
- `GOOGLE_TRANSLATE_KEY` is unset, so `titleZh`/`descriptionZh` are all empty.
- 41 titles are stored ALL-CAPS: `toTitleCase` was added later and the merge path
  only refreshes `rank`/`weeksOnList`, never the title.
- 10 books are dated 2015 — a Jan-15 list's `bestsellers_date` falls in the prior year.
- `data/books.json` only grows; there is no removal path.

Fixing any of these lowers the percentage, which the gate then locks in.

## Verifying a change

```bash
node scripts/validate-books.js        # publish gate
python -m http.server 8000            # then open http://localhost:8000
```

For anything touching voting, test on `localhost`, not `file://`, and confirm both
the vote *and* the un-vote path, plus the blocked-vote toast.
