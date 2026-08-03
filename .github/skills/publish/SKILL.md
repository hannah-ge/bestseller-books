---
name: publish
description: Pre-flight checks before publishing The World's Bookshelf. Validates generated data, confirms the client/database RPC contract still matches, scans for secrets, checks for stale copies, then hands over the push command. Use whenever the user wants to ship, publish, deploy, push changes, or go live.
---

# Publish

Run every check below **before** proposing a commit. Stop at the first failure and
report it — do not push a partially verified change.

The agent cannot push this repo (403). Always finish by giving the user the exact
command to run themselves.

## 1. Validate generated data

```bash
node scripts/validate-books.js
```

Must exit 0. Warnings are existing debt and are fine; `FAIL` lines are blocking.

## 1b. Prove the page still works

Structural validity does not mean the UI renders. Run the headless assertions:

```bash
python -m http.server 8000     # separate terminal
node scripts/smoke-test.js
```

Must exit 0. If `jsdom` is not installed it exits 0 with instructions — install
it (`npm install --no-save jsdom`) rather than skipping this, because it is the
only check that catches a silent async-load failure. See the `verify-ui` skill.

## 2. Confirm the RPC contract still matches

This is the check that matters most. The client and the database schema live in
different files and are edited at different times. Shipping `index.html` against a
function signature that no longer exists makes **every vote silently fail** — the
UI still looks fine.

```bash
grep -n "rpc/vote_book" -A 4 index.html
grep -n "create or replace function public.vote_book" -A 4 supabase-setup.sql
grep -n "drop function" supabase-setup.sql
```

The JSON body keys in `index.html` must exactly match the parameter names in the
`create or replace function` signature. Current contract:

| Client sends | Function expects |
|---|---|
| `p_key` | `p_key text` |
| `p_voter` | `p_voter uuid` |
| `p_direction` | `p_direction smallint` |

Also confirm the client is **not** calling any signature listed in a
`drop function` line.

If the database is reachable, prove it rather than assuming:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$SUPABASE_URL/rest/v1/rpc/vote_book" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"p_key":"contract::probe","p_voter":"00000000-0000-0000-0000-000000000000","p_direction":0}'
```

`404` means the function signature is missing — do not publish.

## 3. Scan for secrets

The Supabase **publishable** key (`sb_publishable_…`) is intentionally committed —
do not flag it. Block on anything else:

```bash
grep -rniE "service_role|BEGIN [A-Z ]*PRIVATE KEY|ghp_|github_pat_" \
  --include="*.html" --include="*.js" --include="*.sql" .
```

`supabase-setup.sql` must contain only a **placeholder** IP salt. The real salt is
set by the user directly in Supabase and must never appear in the repo.

## 4. Check for stale copies

If any file was edited outside the repo (a scratch directory, a session folder),
confirm the two copies are identical before committing. Shipping the stale one is
a real failure mode that has happened here.

```bash
git status --porcelain
git --no-pager diff --stat
```

## 5. Confirm paths stay relative

The site must keep working at any host or subpath:

```bash
grep -nE "(src|href)=\"/|fetch\('/" index.html
```

Any absolute path is a bug. Expect no matches.

## 6. Commit, then hand over

Commit with a message describing behaviour, not files. Then tell the user:

```bash
cd <repo> && git push origin main
```

Report what changed and what you verified. Do not claim the site is live until the
user confirms the push and the deploy has landed.
