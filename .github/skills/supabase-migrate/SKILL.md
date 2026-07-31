---
name: supabase-migrate
description: Change and verify the Supabase backend for The World's Bookshelf global ratings. Covers editing supabase-setup.sql, handing the SQL to the user to run, and proving the result with live probes. Use when asked to change voting rules, reset ratings, alter the schema, fix the vote function, or debug votes not saving.
---

# Supabase migration

The agent has no database credentials. You edit `supabase-setup.sql`, the **user**
runs it in the Supabase SQL editor, and then you verify against the live API.
Never report a migration as done before probing it.

## Security model — do not weaken it

- `book_votes` (tallies) — readable by anyone, writable by nobody.
- `book_voters` (ballots) — RLS on with **zero policies**, plus revoked grants.
  Two independent layers. It must never become readable.
- All writes go through `security definer` `public.vote_book(...)`.
- Tallies are **recounted from ballots** on every vote so they cannot drift.
- The anon key is a publishable key and is assumed public. Nothing relies on
  hiding it. If a probe fails, fix the policy — never loosen RLS to make it pass.
- The IP salt in the repo is a **placeholder**. The real value is set by the user
  in Supabase and must never be committed.

## Changing the vote function

If you change the signature, you must also `drop` the old one — Postgres keeps
overloads, and the client silently keeps calling whichever still exists. Add the
drop **above** the new definition:

```sql
drop function if exists public.vote_book(text, integer, integer);
```

Then update the `fetch` body in `index.html` in the same change so the parameter
names still match. A mismatch makes every vote fail silently while the UI looks
completely normal.

## Handing over

Put the SQL on the clipboard and tell the user to paste it into the Supabase SQL
editor:

```powershell
Get-Content supabase-setup.sql -Raw | Set-Clipboard
```

**Do not overwrite the clipboard afterwards.** Copying something else before the
user has pasted has silently lost a migration here before. Wait for confirmation.

## Verify with live probes

After the user confirms, run all of these. Expected results in brackets.

```bash
# tallies readable                              [200]
curl -s -o /dev/null -w "%{http_code}\n" "$URL/rest/v1/book_votes?select=*&limit=1" -H "apikey: $ANON"

# ballots NOT readable                          [empty array or 401 — never real rows]
curl -s "$URL/rest/v1/book_voters?select=*&limit=1" -H "apikey: $ANON"

# direct tally write blocked                    [401]
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL/rest/v1/book_votes" \
  -H "apikey: $ANON" -H "Content-Type: application/json" -d '{"book_key":"x","up":999}'

# current function exists                       [200]
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL/rest/v1/rpc/vote_book" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"p_key":"probe::probe","p_voter":"00000000-0000-0000-0000-000000000000","p_direction":0}'

# invalid direction rejected                    [400]
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL/rest/v1/rpc/vote_book" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"p_key":"probe::probe","p_voter":"00000000-0000-0000-0000-000000000000","p_direction":5}'
```

A dropped signature must return **404**. If it still returns 200, the drop did not run.

## Resetting ratings

Delete the **ballots**, not the tallies. Clearing `book_votes` alone looks like it
worked, then the counts come back on the next vote because they are recounted from
`book_voters`.

```sql
delete from public.book_voters;
delete from public.book_votes;
```

Do **not** tell the user to clear their browser's `bookshelf_voter_id` — that is
exactly the bypass the one-vote-per-device rule exists to prevent.

## Testing votes locally

Supabase is CORS-blocked over `file://`. Serve over HTTP:

```bash
python -m http.server 8000
```

Test the vote, the un-vote, and the blocked-vote toast. Reset any test rows when
you are done.
