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
| `index.html` | The entire app — markup, CSS, i18n, 135 curated books, voting engine. ~1,900 lines |
| `data/books.json` | **Generated.** NYT data refreshed weekly by the Action |
| `scripts/fetch-books.js` | The weekly pipeline (NYT + OpenLibrary + Google Translate) |
| `scripts/validate-books.js` | Publish gate. Runs in CI between fetch and commit |
| `scripts/smoke-test.js` | Headless UI assertions. See the `verify-ui` skill |
| `supabase-setup.sql` | Backend schema for global ratings. Safe to re-run |
| `higashino-keigo.html` | Standalone tribute page |
| `.github/workflows/update-books.yml` | Monday 09:00 UTC refresh |

The page merges two sources at runtime: the 135 books hardcoded in `index.html`
(curated, hand-written Chinese) and everything in `data/books.json` (NYT, now
enriched with languages and covers from OpenLibrary but no Chinese). Merge is by
lowercased title; `loadDynamicBooks()` runs **async after** first paint, so
counting cards immediately after load undercounts — ~135 rather than ~450.

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

## Data state and history

Current coverage, as reported by `node scripts/validate-books.js`:

| Metric | Value |
|---|---|
| Books in `data/books.json` | 348 |
| More than one language | ~43% |
| With a cover image | ~83% |
| With a Chinese title | 0% until the next successful Action run |

The remaining gaps are mostly genuine — a book with one edition really does have
one language. Improvements lower the percentage, which the gate then locks in as
the new ceiling.

### Resolved failures worth remembering

Every one of these was **silent**: the run went green, the commit landed, and
the data was wrong. That pattern is the thing to watch for in this repo.

- **Google Books returned HTTP 429** from shared runner IPs, and
  `fetchGoogleBooksLanguages` swallowed it into `{ languages: [], cover: "" }`.
  Every fetched book ended up `["English"]` with no cover, for weeks.
  **OpenLibrary** is now primary — keyless, unthrottled, and it aggregates *all
  editions*, which is what a site about translations actually needs. Google
  Books is consulted only when `GOOGLE_BOOKS_KEY` is set. Result: multi-language
  0% → 43%, covers 0% → 83%, zero failures across 348 books.

- **The Google Translate key was sent in the JSON POST body**, where the
  Cloud Translation v2 API ignores it. Every call returned
  `403 "unregistered callers"`, swallowed into empty strings — indistinguishable
  from an unset secret, which is what everyone assumed for weeks. The key was
  configured correctly the whole time. It now travels in the `X-Goog-Api-Key`
  header. To re-diagnose placement: key in body → `403`; key in header or query
  → `400 "API key not valid"`, which proves Google actually read it.

- **41 ALL-CAPS titles** persisted because `toTitleCase` ran only on insert.
  It now re-runs over every book on every run. The same function also treated an
  apostrophe as a word boundary and produced `It'S`, `Don'T`, `The Handmaid'S
  Tale`, and because it only ever ran on ALL-CAPS input, anything it had already
  mangled was never revisited. The suffix repair now runs on every input and is
  idempotent, and only lowers known contractions so `O'Brien` and `D'Angelo`
  survive.

- **Ten books were dated to the wrong year** because the year came from
  `bestsellers_date`; a Jan-15 list is dated to the prior December.

- **The language filter was built once at startup**, so the 20 languages added
  by enrichment were in the data but unreachable in the dropdown. It is now
  rebuilt by `populateLangFilter()` after the async load. `scripts/smoke-test.js`
  asserts against exactly this.

### Three traps worth knowing

- **All book text must go through `escapeHtml()` before it reaches markup.**
  `render()` builds cards by string concatenation, and titles, authors and
  descriptions come from the NYT and OpenLibrary feeds. Descriptions already
  contain quotes today (`"Dungeon Crawler Carl"`), and an unescaped title with a
  quote breaks `alt="…"` while `<img src=x onerror=…>` in any field becomes a
  live XSS. Verified by injecting a hostile book: pre-fix it put a working
  `onerror` handler in the DOM, post-fix it renders as literal text.

- **The prune floor has a year of slack** (`PRUNE_SLACK_YEARS`). Removing it
  looks harmless and is not: because January lists carry December dates, a
  strict 10-year floor deletes the boundary year — which on the first run meant
  The Martian, The Girl on the Train and All the Light We Cannot See, three of
  the best-translated books in the set.
- **OpenLibrary returns MARC 21 codes, not ISO 639-1** — `fre` not `fra`, `ger`
  not `deu`, `chi` not `zho`. `MARC_TO_NAME` maps them to the display names the
  filter uses; an unmapped code is dropped rather than shown raw. If you add a
  language, add it to `nativeNames` in `index.html` too or it appears in English.

## Skills

Task-specific playbooks live in `.github/skills/`. Read the relevant one before
starting — each encodes failures that have already happened here.

| Skill | Use it for |
|---|---|
| `publish` | Shipping. Gate, RPC-contract check, secret scan, then the push command |
| `add-book` | Adding or correcting a curated book in `index.html` |
| `i18n` | Any user-facing string — the app is fully bilingual and fails silently |
| `verify-ui` | Proving the page still works after a change |
| `data-health` | Diagnosing missing covers, languages, or translations |
| `supabase-migrate` | Changing the ratings schema without orphaning votes |

## Verifying a change

```bash
node scripts/validate-books.js        # publish gate — data structure and quality
python -m http.server 8000            # serve (never test over file://)
node scripts/smoke-test.js            # headless UI assertions
```

The smoke test needs `npm install --no-save jsdom`. It is optional and exits 0
when absent, so it can never block a publish for being unconfigured.

For anything touching voting, test on `localhost`, not `file://`, and confirm both
the vote *and* the un-vote path, plus the blocked-vote toast.
