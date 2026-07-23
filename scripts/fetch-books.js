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
const FETCH_HISTORY = process.env.FETCH_HISTORY === 'true';
const DATA_FILE = path.join(__dirname, '..', 'data', 'books.json');

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

  // Extract the year from the list's published date
  const listDate = results.bestsellers_date || results.published_date || date;
  const listYear = date === 'current'
    ? new Date().getFullYear()
    : parseInt(listDate.substring(0, 4), 10) || parseInt(date.substring(0, 4), 10);

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

async function fetchGoogleBooksLanguages(title, author) {
  const query = encodeURIComponent(`${title} ${author}`);
  const url = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=5&fields=items(volumeInfo(language,imageLinks))`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { languages: [], cover: "" };
    const json = await res.json();
    if (!json.items) return { languages: [], cover: "" };

    const languages = [...new Set(json.items.map(i => i.volumeInfo.language).filter(Boolean))];
    const cover = json.items[0]?.volumeInfo?.imageLinks?.thumbnail || "";

    const langMap = {
      en: "English", es: "Spanish", fr: "French", de: "German",
      pt: "Portuguese", it: "Italian", nl: "Dutch", ja: "Japanese",
      ko: "Korean", zh: "Chinese", ar: "Arabic", ru: "Russian",
      pl: "Polish", tr: "Turkish", sv: "Swedish", no: "Norwegian",
      da: "Danish", fi: "Finnish", cs: "Czech", el: "Greek",
      he: "Hebrew", hi: "Hindi", th: "Thai", vi: "Vietnamese",
      is: "Icelandic",
    };

    const langNames = languages.map(code => langMap[code.split('-')[0]] || code).filter(Boolean);
    return { languages: langNames, cover: cover.replace("http://", "https://") };
  } catch {
    return { languages: [], cover: "" };
  }
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
  if (!NYT_API_KEY) {
    console.error("NYT_API_KEY not set. Skipping NYT fetch.");
    console.log("To set up: Add NYT_API_KEY to your repo secrets.");
    console.log("Sign up at: https://developer.nytimes.com/accounts/create");
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify({ books: [], lastUpdated: new Date().toISOString() }, null, 2));
    }
    return;
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
  if (!hasHistory || FETCH_HISTORY) {
    const currentYear = new Date().getFullYear();
    const startYear = currentYear - 10;
    const dates = getHistoricalDates(startYear, currentYear - 1);

    console.log(`\nFetching historical NYT data (${startYear}–${currentYear - 1})...`);
    console.log(`Total API calls: ${dates.length * NYT_LISTS.length} (this will take ~${Math.ceil(dates.length * NYT_LISTS.length * 13 / 60)} minutes)\n`);

    for (const date of dates) {
      for (const list of NYT_LISTS) {
        console.log(`  Fetching ${list} for ${date}...`);
        const books = await fetchNYTList(list, date);
        // Only keep top 5 from each historical list to focus on notable books
        nytBooks = nytBooks.concat(books.slice(0, 5));
        await rateLimitDelay();
      }
    }
    console.log(`\nFetched ${nytBooks.length} historical books`);
  }

  // Always fetch current week's list
  console.log('\nFetching current NYT lists...');
  for (const list of NYT_LISTS) {
    console.log(`  Fetching ${list} (current)...`);
    const books = await fetchNYTList(list, 'current');
    nytBooks = nytBooks.concat(books);
    await rateLimitDelay();
  }

  console.log(`\nTotal fetched: ${nytBooks.length} books from NYT`);

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

  // Enrich with Google Books data (languages & covers)
  console.log('\nEnriching with Google Books data...');
  for (let i = 0; i < nytBooks.length; i++) {
    const book = nytBooks[i];
    console.log(`  [${i + 1}/${nytBooks.length}] ${book.title}`);
    const { languages, cover } = await fetchGoogleBooksLanguages(book.title, book.author);
    if (languages.length > 0) {
      book.languages = [...new Set([...book.languages, ...languages])];
    }
    if (cover) {
      book.googleCover = cover;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Translate to Chinese using Google Translate API (batch to save quota)
  if (GOOGLE_TRANSLATE_KEY) {
    console.log('\nTranslating to Chinese...');
    const booksNeedingTranslation = nytBooks.filter(b => !b.titleZh);
    const batchSize = 20; // Translate 20 books at a time

    for (let i = 0; i < booksNeedingTranslation.length; i += batchSize) {
      const batch = booksNeedingTranslation.slice(i, i + batchSize);
      console.log(`  Batch ${Math.floor(i / batchSize) + 1}: translating ${batch.length} books...`);

      // Translate titles
      const titles = await translateToChinese(batch.map(b => b.title));
      // Translate authors
      const authors = await translateToChinese(batch.map(b => b.author));
      // Translate descriptions
      const descriptions = await translateToChinese(batch.map(b => b.description || ""));

      batch.forEach((book, idx) => {
        book.titleZh = titles[idx] || "";
        book.authorZh = authors[idx] || "";
        book.descriptionZh = descriptions[idx] || "";
      });

      // Small delay between batches
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`  Translated ${booksNeedingTranslation.length} books`);
  } else {
    console.log('\nGOOGLE_TRANSLATE_KEY not set — skipping Chinese translations.');
    console.log('To enable: Add GOOGLE_TRANSLATE_KEY to your repo secrets.');
    console.log('Get a key at: https://console.cloud.google.com/apis/credentials');
  }

  // Merge with existing data
  nytBooks.forEach(nytBook => {
    const key = nytBook.title.toLowerCase();
    const existingIdx = existingBooks.findIndex(b => b.title.toLowerCase() === key);
    if (existingIdx >= 0) {
      existingBooks[existingIdx].rank = nytBook.rank;
      existingBooks[existingIdx].weeksOnList = nytBook.weeksOnList;
      existingBooks[existingIdx].lastUpdated = nytBook.lastUpdated;
      if (nytBook.languages.length > existingBooks[existingIdx].languages.length) {
        existingBooks[existingIdx].languages = nytBook.languages;
      }
      if (nytBook.googleCover && !existingBooks[existingIdx].googleCover) {
        existingBooks[existingIdx].googleCover = nytBook.googleCover;
      }
    } else {
      existingBooks.push(nytBook);
    }
  });

  // Save
  const output = {
    books: existingBooks,
    lastUpdated: new Date().toISOString(),
    sources: ["NYT Books API", "Google Books API"],
    historyFetched: true,
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${existingBooks.length} books to ${DATA_FILE}`);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});

