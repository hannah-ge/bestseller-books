#!/usr/bin/env node
/**
 * Validation gate for data/books.json.
 *
 * Runs between the fetch step and the commit step in the weekly Action so that a
 * degraded scrape can never be published silently.
 *
 * Two tiers of checks:
 *
 *   Structural  - always fail. The file must parse, contain a non-empty `books`
 *                 array, have the required fields on every entry, contain no
 *                 duplicate title::author, and never lose books.
 *
 *   Quality     - regression only. Measured as a PERCENTAGE of the catalogue and
 *                 compared against the previous committed version. Pre-existing
 *                 debt is reported as a warning and does not fail the build, so
 *                 the gate is safe to adopt against imperfect data. Because the
 *                 comparison is a ratio, any improvement is locked in: once the
 *                 enrichment is fixed and the English-only share drops, it can
 *                 never silently climb back.
 *
 * Usage:
 *   node scripts/validate-books.js                    compare against git HEAD
 *   node scripts/validate-books.js --baseline <file>  compare against a file
 *   node scripts/validate-books.js --file <path>      validate a file other than data/books.json
 *   node scripts/validate-books.js --strict           also fail on existing debt
 *   node scripts/validate-books.js --json             machine-readable output
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const REQUIRED_FIELDS = ['title', 'author', 'year', 'country', 'genre'];
const YEARS_BACK = 10;
// Absorbs sampling noise on small weekly deltas.
const TOLERANCE_PCT = 1.0;

const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const AS_JSON = argv.includes('--json');
const baselineFlag = argv.indexOf('--baseline');
const BASELINE_FILE = baselineFlag >= 0 ? argv[baselineFlag + 1] : null;
const fileFlag = argv.indexOf('--file');
const DATA_FILE = fileFlag >= 0 ? argv[fileFlag + 1] : path.join(REPO_ROOT, 'data', 'books.json');

const errors = [];
const warnings = [];

function parseBooks(raw, label) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
  if (!doc || !Array.isArray(doc.books)) {
    throw new Error(`${label} has no "books" array`);
  }
  return doc;
}

function loadBaseline() {
  if (BASELINE_FILE) {
    if (!fs.existsSync(BASELINE_FILE)) return null;
    return parseBooks(fs.readFileSync(BASELINE_FILE, 'utf8'), 'baseline').books;
  }
  try {
    const raw = execFileSync('git', ['show', 'HEAD:data/books.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return parseBooks(raw, 'HEAD:data/books.json').books;
  } catch {
    return null;
  }
}

// A title counts as shouty only if it contains letters and none are lowercase.
function isAllCaps(title) {
  return /[A-Za-z]/.test(title) && title === title.toUpperCase();
}

function bookKey(b) {
  return `${String(b.title || '').trim().toLowerCase()}::${String(b.author || '').trim().toLowerCase()}`;
}

function measure(books) {
  const nowYear = new Date().getFullYear();
  const count = (fn) => books.filter(fn).length;
  return {
    total: books.length,
    allCaps: count((b) => isAllCaps(String(b.title || ''))),
    englishOnly: count(
      (b) => Array.isArray(b.languages) && b.languages.length === 1 && b.languages[0] === 'English'
    ),
    noCover: count((b) => !b.googleCover),
    noChinese: count((b) => !b.titleZh),
    outOfWindow: count(
      (b) => !Number.isInteger(b.year) || b.year < nowYear - YEARS_BACK || b.year > nowYear + 1
    ),
  };
}

function pct(part, total) {
  return total === 0 ? 0 : (part / total) * 100;
}

function checkStructure(books) {
  if (books.length === 0) {
    errors.push('books array is empty');
    return;
  }

  const seen = new Map();
  books.forEach((b, i) => {
    const where = `books[${i}] (${b && b.title ? b.title : 'untitled'})`;

    for (const field of REQUIRED_FIELDS) {
      const v = b[field];
      if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
        errors.push(`${where}: missing required field "${field}"`);
      }
    }
    if (!Number.isInteger(b.year)) {
      errors.push(`${where}: year must be an integer, got ${JSON.stringify(b.year)}`);
    }
    if (!Array.isArray(b.languages) || b.languages.length === 0) {
      errors.push(`${where}: languages must be a non-empty array`);
    }

    const key = bookKey(b);
    if (seen.has(key)) {
      errors.push(`duplicate title::author "${key}" at books[${seen.get(key)}] and books[${i}]`);
    } else {
      seen.set(key, i);
    }
  });
}

const QUALITY_CHECKS = [
  ['englishOnly', 'only "English" in languages'],
  ['noCover', 'no googleCover'],
  ['noChinese', 'no Chinese title'],
  ['allCaps', 'ALL-CAPS title'],
  ['outOfWindow', 'year outside the 10-year window'],
];

function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`FAIL  data/books.json does not exist at ${DATA_FILE}`);
    process.exit(1);
  }

  let doc;
  try {
    doc = parseBooks(fs.readFileSync(DATA_FILE, 'utf8'), 'data/books.json');
  } catch (err) {
    console.error(`FAIL  ${err.message}`);
    process.exit(1);
  }

  const books = doc.books;
  const now = measure(books);
  const baselineBooks = loadBaseline();
  const before = baselineBooks ? measure(baselineBooks) : null;

  checkStructure(books);

  if (before) {
    if (now.total < before.total) {
      errors.push(
        `book count dropped from ${before.total} to ${now.total} — the merge should never lose books`
      );
    }
    for (const [key, label] of QUALITY_CHECKS) {
      const wasPct = pct(before[key], before.total);
      const nowPct = pct(now[key], now.total);
      if (nowPct > wasPct + TOLERANCE_PCT) {
        errors.push(
          `regression: ${label} rose from ${wasPct.toFixed(1)}% to ${nowPct.toFixed(1)}% ` +
            `(${before[key]}/${before.total} -> ${now[key]}/${now.total})`
        );
      }
    }
  }

  for (const [key, label] of QUALITY_CHECKS) {
    if (now[key] > 0) {
      const msg = `${now[key]} of ${now.total} books (${pct(now[key], now.total).toFixed(1)}%) have ${label}`;
      if (STRICT) errors.push(msg);
      else warnings.push(msg);
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ metrics: now, baseline: before, errors, warnings }, null, 2));
    process.exit(errors.length ? 1 : 0);
  }

  console.log('data/books.json validation');
  console.log('='.repeat(64));
  console.log(`  total books        ${now.total}` + (before ? `  (baseline ${before.total})` : '  (no baseline)'));
  for (const [key, label] of QUALITY_CHECKS) {
    const nowPct = pct(now[key], now.total).toFixed(1).padStart(5);
    const delta = before ? `  was ${pct(before[key], before.total).toFixed(1)}%` : '';
    console.log(`  ${label.padEnd(34)} ${String(now[key]).padStart(4)}  ${nowPct}%${delta}`);
  }
  console.log('='.repeat(64));

  if (warnings.length) {
    console.log('\nExisting debt (not blocking — fix to lock in the improvement):');
    warnings.forEach((w) => console.log(`  WARN  ${w}`));
  }

  if (errors.length) {
    console.log('\nBlocking problems:');
    errors.forEach((e) => console.log(`  FAIL  ${e}`));
    console.log(`\n${errors.length} blocking problem(s). Refusing to publish.`);
    process.exit(1);
  }

  console.log('\nOK — safe to publish.');
}

main();
