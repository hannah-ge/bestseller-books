---
name: i18n
description: Add or change user-facing text on The World's Bookshelf, which is fully bilingual English/Chinese. Covers the i18n object, the updateUI wiring, the four separate translation maps, and the initial-paint trap that renders new text blank until the user toggles language. Use when adding a label, button, heading, tooltip, empty state, or any visible string, or when text appears in the wrong language.
---

# Adding or changing UI text

Every visible string exists twice. There is no framework and no `data-i18n`
attribute scheme — `updateUI()` sets each element by ID by hand. Adding a string
therefore takes **three coordinated edits**, and skipping any one of them fails
in a way that is invisible in English.

## The trap that catches everyone

`updateUI()` runs **only from `setLang()`**. It does not run on initial page
load — first paint relies on the English text already sitting in the static
HTML.

So if you add a string to the `i18n` object and wire it into `updateUI()` but
leave the markup empty, the element renders **blank** until the user clicks the
language toggle. In English, the default, it stays blank forever. This is
exactly how the footer release date shipped broken.

**Rule: any element `updateUI()` writes to must also contain its English text as
static markup**, or be populated by a helper that is called during initial
render as well. `updateFooterRelease()` is the reference pattern — it is called
both from `updateUI()` and again at startup.

## The three edits

**1. Add the key to both language blocks.** They currently hold 30 keys each and
parity is exact — keep it that way.

```js
const i18n = {
  en: { …, myNewLabel: "Sort by year" },
  zh: { …, myNewLabel: "按年份排序" },
};
```

Some keys are **functions**, not strings, because they interpolate:

| Key | Args | English form |
|---|---|---|
| `showing` | 2 | `Showing {n} of {total} books` |
| `langLabel` | 1 | `Available in {n} languages` |
| `footerRelease` | 1 | `Last released <strong>{date}</strong>` |
| `voteCount` | 1 | `{n} votes` |
| `ratingAria` | 1 | `Rated {n} out of 5 stars` |

Match the arity in both languages. Chinese word order often differs, so write
the translation as its own template rather than substituting into the English
one.

**2. Wire it into `updateUI()`.** It currently writes to: `pageTitle`,
`pageSubtitle`, `eyebrowText`, `feedbackTitle`, `feedbackSubtitle`,
`feedbackName`, `feedbackMessage`, `feedbackSubmitBtn`, `tributeText`,
`tributeLink`, `footerTagline`.

```js
document.getElementById("myNewLabel").textContent = t.myNewLabel;
```

Use `textContent`. Only use `innerHTML` when the string genuinely contains
markup — `title` and `footerRelease` do.

**3. Put the English text in the static markup.**

```html
<span id="myNewLabel">Sort by year</span>
```

## The other four translation maps

Not everything lives in `i18n`. Text derived from data has its own map, and
adding a value without adding its translation makes it silently render in
English inside Chinese mode:

| Map | Covers | Miss looks like |
|---|---|---|
| `i18n.en` / `i18n.zh` | Static UI chrome | Blank or English text |
| `genreTranslations` | Genre filter options | English genre in the zh dropdown |
| `countries` (`name` / `nameZh`) | Country filter | English country name |
| `nativeNames` | Language filter | Language shown in English, not its own script |

`nativeNames` is deliberately **not** English-then-translated — each language
appears in its own script (`Français`, `日本語`, `Русский`), the same in both
modes. An unmapped language falls back to its English name, which is why adding
a language to `MARC_TO_NAME` in `scripts/fetch-books.js` also requires adding it
to `nativeNames`.

## Rebuilt controls need their placeholder re-set

Anything that rebuilds a `<select>` must restore the localised first option,
because `innerHTML` wipes it. `populateLangFilter()` shows the pattern:

```js
langFilter.innerHTML =
  `<option value="">${currentLang === "zh" ? "所有语言" : "All Languages"}</option>`;
```

Cards are rebuilt by `render()` on every filter change, so card text reads from
`i18n[currentLang]` at render time and needs no separate refresh.

## Verify

```bash
python -m http.server 8000
node scripts/smoke-test.js
```

The smoke test asserts the title is non-empty **before** any toggle, that the
Chinese toggle actually changes it, and that the footer is filled — the three
symptoms of a botched i18n edit. Then look at the page in both modes: a missing
`zh` value is invisible in English and obvious in Chinese.

Quick parity check when adding several keys at once:

```bash
node -e "const h=require('fs').readFileSync('index.html','utf8');const s=h.indexOf('const i18n');let i=h.indexOf('{',s),d=0,e=i;for(;i<h.length;i++){if(h[i]==='{')d++;else if(h[i]==='}'&&!--d){e=i+1;break}}const o=eval('('+h.slice(h.indexOf('{',s),e)+')');const a=Object.keys(o.en),b=Object.keys(o.zh);console.log('en',a.length,'zh',b.length,'| missing in zh:',a.filter(k=>!b.includes(k)).join(',')||'none')"
```
