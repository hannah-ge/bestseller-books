/**
 * Fetches current NYT bestseller lists and merges with existing book data.
 * Run weekly via GitHub Actions to keep the site updated.
 * 
 * Requires: NYT_API_KEY environment variable
 * Sign up at: https://developer.nytimes.com/accounts/create
 */

const fs = require('fs');
const path = require('path');

const NYT_API_KEY = process.env.NYT_API_KEY;
const DATA_FILE = path.join(__dirname, '..', 'data', 'books.json');

// NYT bestseller list categories to fetch
const NYT_LISTS = [
  'hardcover-fiction',
  'hardcover-nonfiction',
];

async function fetchNYTList(listName) {
  const url = `https://api.nytimes.com/svc/books/v3/lists/current/${listName}.json?api-key=${NYT_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch NYT list ${listName}: ${res.status}`);
    return [];
  }
  const json = await res.json();
  const results = json.results;
  if (!results || !results.books) return [];

  return results.books.map(book => ({
    title: book.title.split(':')[0].trim(), // Remove subtitle
    titleZh: "",
    author: book.author,
    authorZh: "",
    year: new Date().getFullYear(),
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

    // Map language codes to names
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

async function main() {
  if (!NYT_API_KEY) {
    console.error("NYT_API_KEY not set. Skipping NYT fetch.");
    console.log("To set up: Add NYT_API_KEY to your repo secrets.");
    console.log("Sign up at: https://developer.nytimes.com/accounts/create");
    // Still create/preserve the data file
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify({ books: [], lastUpdated: new Date().toISOString() }, null, 2));
    }
    return;
  }

  // Load existing data
  let existingBooks = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      existingBooks = raw.books || [];
    } catch {}
  }

  console.log(`Existing books: ${existingBooks.length}`);

  // Fetch NYT lists
  let nytBooks = [];
  for (const list of NYT_LISTS) {
    console.log(`Fetching NYT list: ${list}...`);
    const books = await fetchNYTList(list);
    nytBooks = nytBooks.concat(books);
    // Rate limit: NYT allows 5 req/min
    await new Promise(r => setTimeout(r, 12000));
  }

  console.log(`Fetched ${nytBooks.length} books from NYT`);

  // Enrich with Google Books data (languages & covers)
  for (let i = 0; i < nytBooks.length; i++) {
    const book = nytBooks[i];
    console.log(`  Enriching: ${book.title}`);
    const { languages, cover } = await fetchGoogleBooksLanguages(book.title, book.author);
    if (languages.length > 0) {
      book.languages = [...new Set([...book.languages, ...languages])];
    }
    if (cover) {
      book.googleCover = cover;
    }
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  // Merge: update existing NYT books, add new ones
  const existingTitles = new Set(existingBooks.map(b => b.title.toLowerCase()));

  nytBooks.forEach(nytBook => {
    const key = nytBook.title.toLowerCase();
    const existingIdx = existingBooks.findIndex(b => b.title.toLowerCase() === key);
    if (existingIdx >= 0) {
      // Update rank and weeks on list
      existingBooks[existingIdx].rank = nytBook.rank;
      existingBooks[existingIdx].weeksOnList = nytBook.weeksOnList;
      existingBooks[existingIdx].lastUpdated = nytBook.lastUpdated;
      // Update languages if we found more
      if (nytBook.languages.length > existingBooks[existingIdx].languages.length) {
        existingBooks[existingIdx].languages = nytBook.languages;
      }
    } else {
      // New book
      existingBooks.push(nytBook);
    }
  });

  // Save
  const output = {
    books: existingBooks,
    lastUpdated: new Date().toISOString(),
    sources: ["NYT Books API", "Google Books API"],
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  console.log(`Saved ${existingBooks.length} books to ${DATA_FILE}`);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
