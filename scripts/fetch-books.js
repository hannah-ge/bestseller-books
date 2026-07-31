/**
 * Fetches current + historical NYT bestseller lists and merges with existing book data.
 * Run weekly via GitHub Actions to keep the site updated.
 * 
 * On first run (or when FETCH_HISTORY=true), fetches top #1 books from 2016–present.
 * On subsequent runs, fetches only the current week's list.
 * 
 * Requires: NYT_API_KEY environment variable
 * Optional: FETCH_HISTORY=true to force historical fetch
 * Sign up at: https://developer.nytimes.com/accounts/create
 */

const fs = require('fs');
const path = require('path');

const NYT_API_KEY = process.env.NYT_API_KEY;
const GOOGLE_TRANSLATE_KEY = process.env.GOOGLE_TRANSLATE_KEY;
const GOOGLE_BOOKS_KEY = process.env.GOOGLE_BOOKS_KEY;
const FETCH_HISTORY = process.env.FETCH_HISTORY === 'true';
const DATA_FILE = path.join(__dirname, '..', 'data', 'books.json');

// The site shows the last decade, so anything older is pruned rather than kept
// forever. This is also what stops data/books.json growing without bound.
const YEARS_BACK = 10;
// One extra year of slack before pruning. An early-January list carries a
// bestsellers_date in the previous December, so the catalogue legitimately
// spans eleven calendar years at the boundary. Without this slack the first
// prune deleted ten of the best-translated books in the set (The Martian,
// The Girl on the Train, All the Light We Cannot See) purely as an artefact
// of where the NYT week fell.
const PRUNE_SLACK_YEARS = 1;
// Historical sampling keeps the top 5 of each list; the current week now does
// the same, so the current year is not over-represented.
const TOP_N_PER_LIST = 5;
// Safety valve on the backfill so a first run cannot take hours.
const MAX_BACKFILL_PER_RUN = Number(process.env.MAX_BACKFILL || 400);

const NYT_LISTS = [
  'combined-print-and-e-book-fiction',
  'combined-print-and-e-book-nonfiction',
];

// Rate limit helper: NYT allows 5 req/min, so wait 13s between calls
async function rateLimitDelay() {
  await new Promise(r => setTimeout(r, 13000));
}

async function fetchNYTList(listName, date = 'current') {
  const url = `https://api.nytimes.com/svc/books/v3/lists/${date}/${listName}.json?api-key=${NYT_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  Failed to fetch NYT list ${listName} (${date}): ${res.status}`);
    return [];
  }
  const json = await res.json();
  const results = json.results;
  if (!results || !results.books) return [];

  // bestsellers_date for an early-January list falls in the *previous* year,
  // which is how ten books ended up dated 2015 on a "last ten years" site. The
  // requested date is the sampling point we chose, so trust that instead.
  const listYear =
    date === 'current' ? new Date().getFullYear() : parseInt(date.substring(0, 4), 10);

  return results.books.map(book => ({
    title: toTitleCase(book.title.split(':')[0].trim()),
    titleZh: "",
    author: book.author,
    authorZh: "",
    year: listYear,
    country: "US",
    genre: listName.includes('nonfiction') ? 'Non-Fiction' : 'Fiction',
    isbn: book.primary_isbn13 || book.primary_isbn10 || "",
    description: book.description || "",
    descriptionZh: "",
    languages: ["English"],
    weeksOnList: book.weeks_on_list,
    rank: book.rank,
    source: "nyt",
    lastUpdated: new Date().toISOString().split('T')[0],
  }));
}

// Convert "ALL CAPS TITLE" to "All Caps Title"
function toTitleCase(str) {
  if (str !== str.toUpperCase()) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\b(A|An|And|As|At|But|By|For|In|Nor|Of|On|Or|So|The|To|Up|Yet)\b/g,
      (m, p1, offset) => offset === 0 ? m : m.toLowerCase());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// OpenLibrary asks for a descriptive User-Agent identifying the caller.
const OPENLIBRARY_UA = 'worldsbookshelf/1.0 (+https://github.com/hannah-ge/bestseller-books)';

// OpenLibrary reports MARC 21 codes, which differ from ISO 639-1 in several
// places (fre not fra, ger not deu, chi not zho, dut not nld). The names on the
// right must match the ones the curated books in index.html already use, or the
// language filter fragments into near-duplicate entries.
// Codes deliberately absent — "mul" (multiple) and "und" (undetermined) — are
// dropped, because they are not languages a reader can pick.
const MARC_TO_NAME = {
  eng: 'English', fre: 'French', ger: 'German', spa: 'Spanish', ita: 'Italian',
  jpn: 'Japanese', kor: 'Korean', dut: 'Dutch', chi: 'Chinese', por: 'Portuguese',
  rus: 'Russian', pol: 'Polish', swe: 'Swedish', tur: 'Turkish', ara: 'Arabic',
  nor: 'Norwegian', hin: 'Hindi', dan: 'Danish', cze: 'Czech', ice: 'Icelandic',
  tha: 'Thai', vie: 'Vietnamese', fin: 'Finnish', heb: 'Hebrew', gre: 'Greek',
  ben: 'Bengali', ind: 'Indonesian', hun: 'Hungarian', rum: 'Romanian',
  ukr: 'Ukrainian', bul: 'Bulgarian', cat: 'Catalan', slo: 'Slovak',
  slv: 'Slovenian', srp: 'Serbian', hrv: 'Croatian', est: 'Estonian',
  lav: 'Latvian', lit: 'Lithuanian', per: 'Persian', tam: 'Tamil',
  may: 'Malay', afr: 'Afrikaans', gle: 'Irish', wel: 'Welsh', lat: 'Latin',
  bel: 'Belarusian', grn: 'Guarani',
};

// Counters so a total upstream outage becomes a hard failure instead of a
// green build full of empty fields.
const enrichStats = { attempted: 0, withLanguages: 0, withCover: 0, failed: 0 };

/**
 * Fetch JSON with retry and exponential backoff. Returns { data } or { error }.
 * Retries on 429 and 5xx only — a 404 is a real answer, not a transient fault.
 */
async function httpJson(url, headers = {}, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429 || res.status >= 500) {
        if (attempt === attempts - 1) return { error: `HTTP ${res.status} after ${attempts} attempts` };
        const wait = 2000 * Math.pow(2, attempt);
        console.warn(`    ${res.status} — backing off ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return { data: await res.json() };
    } catch (err) {
      if (attempt === attempts - 1) return { error: err.message };
      await sleep(2000 * Math.pow(2, attempt));
    }
  }
  return { error: 'exhausted retries' };
}

/**
 * OpenLibrary aggregates every edition of a work, so it reports the full set of
 * languages a book has been published in — exactly what this site is about.
 * It needs no API key and does not rate-limit shared CI runner IPs, which is why
 * it is the primary source rather than Google Books.
 */
async function enrichFromOpenLibrary(title, author) {
  const params = new URLSearchParams({
    q: `${title} ${author}`,
    fields: 'language,cover_i',
    limit: '20',
  });
  const { data, error } = await httpJson(
    `https://openlibrary.org/search.json?${params}`,
    { 'User-Agent': OPENLIBRARY_UA }
  );
  if (error) return { languages: [], cover: '', error };

  const docs = (data && data.docs) || [];
  const codes = new Set();
  docs.forEach((d) => (d.language || []).forEach((c) => codes.add(c)));

  const languages = [...codes].map((c) => MARC_TO_NAME[c]).filter(Boolean);
  const withCover = docs.find((d) => d.cover_i);
  const cover = withCover ? `https://covers.openlibrary.org/b/id/${withCover.cover_i}-L.jpg` : '';

  return { languages, cover, error: null };
}

/**
 * Optional supplement. The keyless Google Books endpoint returns 429 from CI
 * runners, so it is only used when GOOGLE_BOOKS_KEY is configured.
 */
async function enrichFromGoogleBooks(title, author) {
  if (!GOOGLE_BOOKS_KEY) return { languages: [], cover: '', error: 'no key' };
  const params = new URLSearchParams({
    q: `${title} ${author}`,
    maxResults: '5',
    fields: 'items(volumeInfo(language,imageLinks))',
    key: GOOGLE_BOOKS_KEY,
  });
  const { data, error } = await httpJson(`https://www.googleapis.com/books/v1/volumes?${params}`);
  if (error) return { languages: [], cover: '', error };

  const items = (data && data.items) || [];
  const iso2 = {
    en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese',
    it: 'Italian', nl: 'Dutch', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
    ar: 'Arabic', ru: 'Russian', pl: 'Polish', tr: 'Turkish', sv: 'Swedish',
    no: 'Norwegian', da: 'Danish', fi: 'Finnish', cs: 'Czech', el: 'Greek',
    he: 'Hebrew', hi: 'Hindi', th: 'Thai', vi: 'Vietnamese', is: 'Icelandic',
  };
  const languages = [
    ...new Set(items.map((i) => i.volumeInfo && i.volumeInfo.language).filter(Boolean)),
  ]
    .map((c) => iso2[c.split('-')[0]])
    .filter(Boolean);
  const thumb =
    (items[0] && items[0].volumeInfo && items[0].volumeInfo.imageLinks &&
      items[0].volumeInfo.imageLinks.thumbnail) || '';

  return { languages, cover: thumb.replace('http://', 'https://'), error: null };
}

/**
 * Combine both sources. Failure is recorded, never swallowed silently.
 */
async function enrichBook(title, author) {
  enrichStats.attempted++;
  const primary = await enrichFromOpenLibrary(title, author);
  const secondary = await enrichFromGoogleBooks(title, author);

  if (primary.error && (secondary.error && secondary.error !== 'no key')) {
    enrichStats.failed++;
    console.warn(`    enrichment failed: ${primary.error}`);
    return { languages: [], cover: '' };
  }

  const languages = [...new Set([...primary.languages, ...secondary.languages])];
  const cover = primary.cover || secondary.cover || '';
  if (languages.length > 0) enrichStats.withLanguages++;
  if (cover) enrichStats.withCover++;
  return { languages, cover };
}

// Translate text to Chinese using Google Translate API
async function translateToChinese(texts) {
  if (!GOOGLE_TRANSLATE_KEY || texts.length === 0) return texts.map(() => "");

  try {
    const url = 'https://translation.googleapis.com/language/translate/v2';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: texts,
        source: 'en',
        target: 'zh',
        key: GOOGLE_TRANSLATE_KEY,
        format: 'text',
      }),
    });

    if (!res.ok) {
      console.error(`  Google Translate error: ${res.status}`);
      return texts.map(() => "");
    }

    const json = await res.json();
    return json.data.translations.map(t => t.translatedText);
  } catch (err) {
    console.error(`  Translation failed: ${err.message}`);
    return texts.map(() => "");
  }
}

// Generate sample dates for historical fetches: mid-year for each year
function getHistoricalDates(startYear, endYear) {
  const dates = [];
  for (let y = startYear; y <= endYear; y++) {
    // Sample 4 points per year (Jan, Apr, Jul, Oct) to catch seasonal #1s
    dates.push(`${y}-01-15`, `${y}-04-15`, `${y}-07-15`, `${y}-10-15`);
  }
  return dates;
}

async function main() {
  // Without a key we cannot fetch new lists, but the repair phase — retitling,
  // pruning and enrichment backfill — still works on whatever is already on
  // disk, so run in that mode instead of bailing out entirely.
  if (!NYT_API_KEY) {
    console.warn("NYT_API_KEY not set — skipping the NYT fetch, running repair only.");
    console.log("To enable fetching: add NYT_API_KEY to your repo secrets.");
    console.log("Sign up at: https://developer.nytimes.com/accounts/create");
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify({ books: [], lastUpdated: new Date().toISOString() }, null, 2));
      return;
    }
  }

  // Load existing data
  let existingBooks = [];
  let hasHistory = false;
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      existingBooks = raw.books || [];
      hasHistory = raw.historyFetched === true;
    } catch {}
  }

  console.log(`Existing books: ${existingBooks.length}`);

  let nytBooks = [];

  // Fetch historical data if first run or explicitly requested
  if (NYT_API_KEY && (!hasHistory || FETCH_HISTORY)) {
    const currentYear = new Date().getFullYear();
    const startYear = currentYear - 10;
    const dates = getHistoricalDates(startYear, currentYear - 1);

    console.log(`\nFetching historical NYT data (${startYear}–${currentYear - 1})...`);
    console.log(`Total API calls: ${dates.length * NYT_LISTS.length} (this will take ~${Math.ceil(dates.length * NYT_LISTS.length * 13 / 60)} minutes)\n`);

    for (const date of dates) {
      for (const list of NYT_LISTS) {
        console.log(`  Fetching ${list} for ${date}...`);
        const books = await fetchNYTList(list, date);
        // Only keep the top few from each historical list to focus on notable books
        nytBooks = nytBooks.concat(books.slice(0, TOP_N_PER_LIST));
        await rateLimitDelay();
      }
    }
    console.log(`\nFetched ${nytBooks.length} historical books`);
  }

  // Always fetch current week's list
  if (NYT_API_KEY) {
    console.log('\nFetching current NYT lists...');
    for (const list of NYT_LISTS) {
      console.log(`  Fetching ${list} (current)...`);
      const books = await fetchNYTList(list, 'current');
      // Same top-N cap as the historical path, otherwise the current year keeps
      // accumulating every rank every week and dwarfs previous years.
      nytBooks = nytBooks.concat(books.slice(0, TOP_N_PER_LIST));
      await rateLimitDelay();
    }
    console.log(`\nTotal fetched: ${nytBooks.length} books from NYT`);
  }

  // Deduplicate fetched books (same title might appear across multiple dates)
  const seen = new Map();
  nytBooks.forEach(book => {
    const key = book.title.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, book);
    } else {
      // Keep the entry with the highest weeks-on-list count
      const existing = seen.get(key);
      if ((book.weeksOnList || 0) > (existing.weeksOnList || 0)) {
        book.year = existing.year; // keep earliest year
        seen.set(key, book);
      }
    }
  });
  nytBooks = [...seen.values()];
  console.log(`After dedup: ${nytBooks.length} unique books`);

  // Merge with existing data. Enrichment happens afterwards, in one pass over
  // everything, so books that were added before enrichment worked get repaired
  // too rather than being stuck with whatever the first broken run produced.
  nytBooks.forEach(nytBook => {
    const key = nytBook.title.toLowerCase();
    const existingIdx = existingBooks.findIndex(b => b.title.toLowerCase() === key);
    if (existingIdx >= 0) {
      existingBooks[existingIdx].rank = nytBook.rank;
      existingBooks[existingIdx].weeksOnList = nytBook.weeksOnList;
      existingBooks[existingIdx].lastUpdated = nytBook.lastUpdated;
    } else {
      existingBooks.push(nytBook);
    }
  });

  // Re-apply the title transform to every book on every run. toTitleCase was
  // added after the first scrape, and the merge above only refreshes rank and
  // weeks, so 41 shouty titles had been frozen in place. Applying it here means
  // any future transform fix backfills automatically.
  // Safe for ratings: the vote key is `title::author` LOWERCASED, so changing
  // "YESTERYEAR" to "Yesteryear" leaves the key byte-identical.
  let retitled = 0;
  existingBooks.forEach(b => {
    if (typeof b.title !== 'string') return;
    const fixed = toTitleCase(b.title);
    if (fixed !== b.title) { b.title = fixed; retitled++; }
  });
  if (retitled) console.log(`\nNormalised ${retitled} title(s) out of ALL CAPS`);

  // Prune outside the ten-year window. This is the removal path the merge never
  // had — without it data/books.json only ever grows. The floor carries a year
  // of slack so books sitting on the January boundary are kept rather than
  // deleted; they are real bestsellers, not bad rows.
  const currentYear = new Date().getFullYear();
  const windowStart = currentYear - YEARS_BACK - PRUNE_SLACK_YEARS;
  const kept = existingBooks.filter(
    b => Number.isInteger(b.year) && b.year >= windowStart && b.year <= currentYear + 1
  );
  if (kept.length !== existingBooks.length) {
    const dropped = existingBooks.filter(b => !kept.includes(b));
    console.log(`\nPruned ${dropped.length} book(s) outside ${windowStart}–${currentYear + 1}:`);
    dropped.slice(0, 12).forEach(b => console.log(`  - ${b.year}  ${b.title}`));
    if (dropped.length > 12) console.log(`  … and ${dropped.length - 12} more`);
    existingBooks = kept;
  }

  // Enrich anything lacking a cover or with no language beyond English.
  const needsEnrichment = b =>
    !b.coverUrl || !Array.isArray(b.languages) || b.languages.length <= 1;
  const queue = existingBooks.filter(needsEnrichment).slice(0, MAX_BACKFILL_PER_RUN);

  if (queue.length) {
    console.log(`\nEnriching ${queue.length} book(s) via OpenLibrary${GOOGLE_BOOKS_KEY ? ' + Google Books' : ''}...`);
    for (let i = 0; i < queue.length; i++) {
      const book = queue[i];
      const { languages, cover } = await enrichBook(book.title, book.author);
      if (languages.length > 0) {
        book.languages = [...new Set([...(book.languages || []), ...languages])];
      }
      if (cover && !book.coverUrl) book.coverUrl = cover;
      if ((i + 1) % 25 === 0 || i === queue.length - 1) {
        console.log(`  [${i + 1}/${queue.length}] languages ${enrichStats.withLanguages}, covers ${enrichStats.withCover}, failed ${enrichStats.failed}`);
      }
      await sleep(1000); // OpenLibrary asks for roughly one request per second
    }
  }

  // Translate to Chinese using Google Translate API (batch to save quota)
  if (GOOGLE_TRANSLATE_KEY) {
    console.log('\nTranslating to Chinese...');
    const booksNeedingTranslation = existingBooks.filter(b => !b.titleZh);
    const batchSize = 20; // Translate 20 books at a time

    for (let i = 0; i < booksNeedingTranslation.length; i += batchSize) {
      const batch = booksNeedingTranslation.slice(i, i + batchSize);
      console.log(`  Batch ${Math.floor(i / batchSize) + 1}: translating ${batch.length} books...`);

      const titles = await translateToChinese(batch.map(b => b.title));
      const authors = await translateToChinese(batch.map(b => b.author));
      const descriptions = await translateToChinese(batch.map(b => b.description || ""));

      batch.forEach((book, idx) => {
        book.titleZh = titles[idx] || "";
        book.authorZh = authors[idx] || "";
        book.descriptionZh = descriptions[idx] || "";
      });

      await sleep(500);
    }
    console.log(`  Translated ${booksNeedingTranslation.length} books`);
  } else {
    console.log('\nGOOGLE_TRANSLATE_KEY not set — skipping Chinese translations.');
    console.log('To enable: Add GOOGLE_TRANSLATE_KEY to your repo secrets.');
    console.log('Get a key at: https://console.cloud.google.com/apis/credentials');
  }

  // Coverage summary. The old script logged per-book progress and nothing else,
  // so a run where every single upstream call failed looked identical to a
  // healthy one.
  const total = existingBooks.length;
  const pct = n => (total ? ((n / total) * 100).toFixed(1) : '0.0');
  const multiLang = existingBooks.filter(b => (b.languages || []).length > 1).length;
  const withCover = existingBooks.filter(b => b.coverUrl).length;
  const withZh = existingBooks.filter(b => b.titleZh).length;

  console.log('\n' + '='.repeat(58));
  console.log(`  books                    ${total}`);
  console.log(`  more than one language   ${multiLang} (${pct(multiLang)}%)`);
  console.log(`  with a cover             ${withCover} (${pct(withCover)}%)`);
  console.log(`  with Chinese             ${withZh} (${pct(withZh)}%)`);
  console.log(`  enrichment attempted     ${enrichStats.attempted}, failed ${enrichStats.failed}`);
  console.log('='.repeat(58));

  // A total upstream outage must fail the build. Partial failure is normal —
  // some books genuinely have one edition — but zero successes across a whole
  // queue means the API is refusing us, which is exactly what went unnoticed
  // when Google Books started returning 429.
  if (enrichStats.attempted > 0 && enrichStats.withLanguages === 0) {
    console.error(
      `\nEnrichment returned no language data for any of ${enrichStats.attempted} books. ` +
      `Upstream is failing — refusing to write a degraded file.`
    );
    process.exit(1);
  }

  const output = {
    books: existingBooks,
    lastUpdated: new Date().toISOString(),
    sources: ["NYT Books API", "OpenLibrary", ...(GOOGLE_BOOKS_KEY ? ["Google Books API"] : [])],
    historyFetched: true,
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${existingBooks.length} books to ${DATA_FILE}`);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
