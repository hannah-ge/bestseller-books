#!/usr/bin/env node
/**
 * Headless smoke test for index.html.
 *
 * Why this exists: the app has no build step and no test framework, so the only
 * way anyone checked a change was to open a browser and look. That is fine for
 * layout and useless for logic that runs after an async fetch. A real example:
 * the language filter was built once at startup from the curated list, so the
 * 20 languages added by enrichment were present in the data but unreachable in
 * the dropdown. The page looked completely normal.
 *
 * This loads the real page, waits for loadDynamicBooks() to finish, and asserts
 * on the resulting DOM.
 *
 * Usage:
 *   python -m http.server 8000     # in the repo root, separately
 *   node scripts/smoke-test.js
 *   node scripts/smoke-test.js --url http://localhost:3000
 *
 * jsdom is an optional dev-only dependency and is deliberately not committed as
 * a package.json entry — the repo ships as static files with no install step.
 * If it is missing this exits 0 with instructions rather than failing CI.
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = flag('--url', 'http://localhost:8000');
const PAGE = `${BASE}/index.html`;
// Generous, because it covers a real network fetch of data/books.json.
const SETTLE_MS = Number(flag('--settle', 8000));

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.log('jsdom is not installed, so the smoke test cannot run.');
  console.log('Install it locally (it is not needed to run or ship the site):');
  console.log('\n  npm install --no-save jsdom\n');
  process.exit(0);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  // Fail fast with a clear message rather than a jsdom stack trace.
  try {
    const probe = await fetch(PAGE);
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
  } catch (err) {
    console.error(`Cannot reach ${PAGE} (${err.message})`);
    console.error('Start a server first:  python -m http.server 8000');
    process.exit(1);
  }

  const pageErrors = [];

  const dom = await JSDOM.fromURL(PAGE, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(w) {
      // jsdom lacks these; the page uses them at startup and would otherwise
      // die before any assertion runs.
      w.matchMedia = () => ({
        matches: false,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {},
      });
      w.scrollTo = () => {};
      // Resolve relative URLs against the server, not the jsdom sandbox.
      w.fetch = (u, o) => fetch(new URL(u, `${BASE}/`).toString(), o);
      w.addEventListener('error', e => pageErrors.push(e.message));
    },
  });

  const w = dom.window;
  await new Promise(r => w.addEventListener('load', r));
  await new Promise(r => setTimeout(r, SETTLE_MS));
  const d = w.document;

  const $ = sel => [...d.querySelectorAll(sel)];
  const cards = () => $('#grid > *').length;

  console.log(`\nSmoke test — ${PAGE}\n`);

  // The curated list alone renders ~135. Anything at or below that means the
  // async load silently failed, which is the exact bug this file exists to catch.
  const rendered = cards();
  check('books render', rendered > 200, `${rendered} cards`);
  check('dynamic data merged', rendered > 140,
    rendered > 140 ? 'loadDynamicBooks() ran' : 'only curated books — data/books.json did not load');

  const langs = $('#langFilter option').map(o => o.value).filter(Boolean);
  check('language filter populated', langs.length > 30, `${langs.length} languages`);
  // Enrichment-only languages. If the filter is not rebuilt after the async
  // load, these are in the data but missing here.
  const enriched = ['Ukrainian', 'Catalan', 'Hungarian', 'Romanian'].filter(l => langs.includes(l));
  check('enriched languages selectable', enriched.length >= 3, enriched.join(', ') || 'none found');

  const years = $('#yearFilter option').map(o => o.value).filter(Boolean);
  check('year filter populated', years.length > 5, `${years.length} years`);

  const covers = $('#grid img');
  const withSrc = covers.filter(i => (i.getAttribute('src') || '').startsWith('http')).length;
  check('covers have image URLs', withSrc > covers.length * 0.5,
    `${withSrc}/${covers.length}`);

  // Exercise a filter end to end — options existing does not prove they filter.
  const sel = d.getElementById('langFilter');
  const filterBy = async value => {
    sel.value = value;
    sel.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 300));
    return cards();
  };
  const jp = await filterBy('Japanese');
  check('filtering narrows results', jp > 0 && jp < rendered, `Japanese → ${jp} cards`);
  const restored = await filterBy('');
  check('clearing filter restores all', restored === rendered, `${restored} cards`);

  // i18n: the known trap is text that is only wired up inside updateUI(), so it
  // renders blank until the user toggles language.
  const title = () => d.getElementById('pageTitle')?.textContent?.trim() || '';
  const beforeLang = title();
  check('title renders before any toggle', beforeLang.length > 0, JSON.stringify(beforeLang.slice(0, 40)));

  if (typeof w.setLang === 'function') {
    w.setLang('zh');
    await new Promise(r => setTimeout(r, 400));
    const zh = title();
    check('Chinese mode changes title', zh !== beforeLang && /[\u4e00-\u9fff]/.test(zh),
      JSON.stringify(zh.slice(0, 40)));
    check('cards survive language switch', cards() === rendered, `${cards()} cards`);
    w.setLang('en');
    await new Promise(r => setTimeout(r, 400));
    check('switching back restores English', title() === beforeLang);
  } else {
    check('setLang reachable', false, 'not exposed on window — cannot test i18n');
  }

  // The footer is the canonical example of the updateUI() trap: it is populated
  // by updateFooterRelease(), which must run on initial paint as well as from
  // setLang(). It previously rendered blank until the user toggled language.
  const footer = d.getElementById('footerRelease')?.textContent?.trim() || '';
  check('footer release date filled', footer.length > 0, JSON.stringify(footer.slice(0, 40)) || 'blank');

  check('no uncaught page errors', pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | ') || 'clean');

  dom.window.close();

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailed:');
    failed.forEach(f => console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`));
    process.exit(1);
  }
  console.log('OK\n');
}

main().catch(err => {
  console.error(`Smoke test crashed: ${err.message}`);
  process.exit(1);
});
