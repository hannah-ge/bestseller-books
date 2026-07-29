-- ===========================================================
--  The World's Bookshelf — global ratings backend
--  One vote per device AND one vote per IP address, per book.
--
--  Paste this whole file into the Supabase SQL Editor and Run.
--  It is safe to re-run.
-- ===========================================================

-- -----------------------------------------------------------
-- 1. Public tallies. This is the only table the website reads.
-- -----------------------------------------------------------
create table if not exists public.book_votes (
  book_key   text primary key,
  up         integer     not null default 0,
  down       integer     not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.book_votes enable row level security;

-- Anyone may read the tallies...
drop policy if exists "public read tallies" on public.book_votes;
create policy "public read tallies"
  on public.book_votes for select
  to anon, authenticated
  using (true);

-- ...and nobody may write them directly. There are deliberately no
-- insert/update/delete policies, so all writes must go through
-- vote_book() below, which enforces the one-vote rules.


-- -----------------------------------------------------------
-- 2. Individual ballots: one row per (book, device).
--    Private — never exposed to the website.
-- -----------------------------------------------------------
create table if not exists public.book_voters (
  book_key   text        not null,
  voter_id   uuid        not null,
  ip_hash    text        not null,
  direction  smallint    not null check (direction in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (book_key, voter_id)
);

-- The hard limit you asked for: one ballot per IP per book.
create unique index if not exists book_voters_one_per_ip
  on public.book_voters (book_key, ip_hash);

create index if not exists book_voters_book_idx
  on public.book_voters (book_key);

-- RLS on with no policies at all => the public key can neither
-- read nor write this table. Only vote_book() can touch it.
alter table public.book_voters enable row level security;

-- Defence in depth: also strip the table grants, so the ballots stay
-- private even if RLS were ever accidentally disabled later.
revoke all on table public.book_voters from anon, authenticated;


-- -----------------------------------------------------------
-- 3. Salt used to hash IP addresses.
--    Raw IPs are NEVER stored — only a salted SHA-256 hash.
--    >>> Change the string below to any random text you like. <<<
-- -----------------------------------------------------------
create or replace function public.vote_ip_salt()
returns text
language sql
immutable
as $$
  select 'change-me-to-any-random-string-8f2a1c'
$$;

revoke all on function public.vote_ip_salt() from public, anon, authenticated;


-- -----------------------------------------------------------
-- 4. Remove the OLD unrestricted voting function.
--    This matters: if it survives, the old "add +1 to anything"
--    endpoint stays callable and the limits below mean nothing.
-- -----------------------------------------------------------
drop function if exists public.vote_book(text, integer, integer);
drop function if exists public.vote_book(text, smallint, smallint);


-- -----------------------------------------------------------
-- 5. The one and only way to vote.
--    p_direction:  1 = thumbs up, -1 = thumbs down, 0 = remove my vote
--    Returns: { "status": "ok" | "ip_taken", "up": n, "down": n }
-- -----------------------------------------------------------
create or replace function public.vote_book(
  p_key       text,
  p_voter     uuid,
  p_direction smallint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip     text;
  v_hash   text;
  v_owner  uuid;
  v_up     integer;
  v_down   integer;
  v_status text := 'ok';
begin
  -- Validate input; never trust the browser.
  if p_key is null or btrim(p_key) = '' or length(p_key) > 300 then
    raise exception 'invalid book key';
  end if;
  if p_voter is null then
    raise exception 'missing voter id';
  end if;
  if p_direction is null or p_direction not in (-1, 0, 1) then
    raise exception 'invalid direction';
  end if;

  -- Caller's IP = first hop of x-forwarded-for. The browser cannot
  -- forge this: Supabase's edge sets it, overwriting anything sent.
  v_ip := btrim(split_part(
            coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''),
            ',', 1));
  if v_ip = '' then
    v_ip := 'unknown';
  end if;

  v_hash := encode(sha256((v_ip || '|' || vote_ip_salt())::bytea), 'hex');

  -- Has a *different* device on this same IP already voted on this book?
  select voter_id into v_owner
    from book_voters
   where book_key = p_key
     and ip_hash  = v_hash;

  if v_owner is not null and v_owner <> p_voter then
    v_status := 'ip_taken';               -- reject, change nothing

  elsif p_direction = 0 then
    delete from book_voters
     where book_key = p_key
       and voter_id = p_voter;            -- user cleared their vote

  else
    insert into book_voters (book_key, voter_id, ip_hash, direction)
    values (p_key, p_voter, v_hash, p_direction)
    on conflict (book_key, voter_id)
    do update set direction = excluded.direction,
                  ip_hash   = excluded.ip_hash;
  end if;

  -- Recount from the ballots so the tally can never drift.
  select count(*) filter (where direction =  1),
         count(*) filter (where direction = -1)
    into v_up, v_down
    from book_voters
   where book_key = p_key;

  insert into book_votes (book_key, up, down, updated_at)
  values (p_key, v_up, v_down, now())
  on conflict (book_key)
  do update set up = excluded.up,
                down = excluded.down,
                updated_at = now();

  return jsonb_build_object('status', v_status, 'up', v_up, 'down', v_down);
end;
$$;

revoke all on function public.vote_book(text, uuid, smallint) from public;
grant execute on function public.vote_book(text, uuid, smallint) to anon, authenticated;
