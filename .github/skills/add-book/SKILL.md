---
name: add-book
description: Add or edit a curated book on The World's Bookshelf. Handles the inline book array in index.html with the correct schema, both language variants, and validation. Use when asked to add a book, add a title, feature a book, add a country's bestseller, or correct a book's details.
---

# Add a curated book

Curated books live in the `books` array inside `index.html` (around line 900–1100).
They are the entries with real language coverage and Chinese translations — the
weekly NYT feed cannot produce those.

**Never add a book to `data/books.json`.** That file is generated and your edit is
erased on the next Monday run.

## Schema

Every field is required. Match the surrounding entries exactly — one object per
line, in the same key order.

```js
{ title: "The Women", titleZh: "女人们", author: "Kristin Hannah", authorZh: "克里斯汀·汉娜", year: 2024, country: "US", genre: "Historical Fiction", isbn: "1250178630", description: "A young nurse volunteers for duty in Vietnam and returns to a country that doesn't acknowledge her service.", descriptionZh: "一位年轻护士自愿前往越南服役，回到一个不承认她贡献的国家。", languages: ["English", "Spanish", "French", "German"] },
```

| Field | Rule |
|---|---|
| `title` / `author` | Title Case. Never ALL CAPS — the pipeline normalises generated titles, but curated entries are never touched by it |
| `titleZh` / `authorZh` / `descriptionZh` | Required. The site has full zh i18n; empty values fall back to English and look broken in Chinese mode. This is the main reason to add a book here rather than let the NYT feed carry it |
| `year` | Integer, within the last 10 years, unless `genre` is `Classics` |
| `country` | One of `US CN JP RU IN GB FR DE NL NO IS IT` — anything else silently disappears from the country filter |
| `genre` | Reuse an existing value, do not invent one, or you fragment the filter: `Classics, Fantasy, Historical Fiction, Illustrated, Literary Fiction, Memoir, Mystery, Non-Fiction, Romance, Science Fiction, Self-Help, Thriller` |
| `isbn` | ISBN-13 preferred. Used for the OpenLibrary cover fallback, so a wrong one shows a placeholder |
| `description` | One or two sentences, no spoilers |
| `languages` | Array of English language **names**, not codes. `["English", "Spanish"]`, never `["en", "es"]` |

To re-read the valid values rather than trusting this list:

```bash
grep -n "const countries" -A 15 index.html
```

## Duplicates

The runtime merge keys on **lowercased title**, so a curated entry suppresses any
NYT entry with the same title. That is usually what you want — it is how a book
gets rich language data. But check first, because two different books can share a
title:

```bash
grep -n "title: \"Your Title\"" index.html
```

## After editing

```bash
node scripts/validate-books.js     # guards the generated file is untouched
python -m http.server 8000
node scripts/smoke-test.js         # asserts cards render and both languages work
```

Confirm in the browser that the new card appears, its cover resolves, and it
renders correctly in **both** languages — toggle to Chinese and back. A missing
`titleZh` is invisible in English and obvious in Chinese.

If the book introduces a language not already in the filter, add it to
`nativeNames` in `index.html` as well, or it displays in English instead of its
own script. See the `i18n` skill.
