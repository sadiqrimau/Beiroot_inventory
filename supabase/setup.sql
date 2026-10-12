-- =====================================================================
-- Beiroot stock & reconciliation system: database setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run once on a fresh project. See README.md for the full steps.
-- =====================================================================

-- ---------- Reference tables ----------------------------------------

create table if not exists public.locations (
  id          text primary key,                       -- e.g. 'store', 'kitchen', 'tanke'
  name        text not null,
  kind        text not null check (kind in ('store','kitchen','branch')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  username    text not null unique,
  roles       text[] not null default '{}',
  branch_id   text references public.locations(id),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint roles_valid check (roles <@ array['owner','admin','storekeeper','buyer','driver','cook',
                                               'branch_manager','kitchen_lead','cashier','counter']::text[])
);

create table if not exists public.items (
  id                  text primary key,               -- short code, e.g. 'flour'
  name                text not null,
  category            text not null,
  kind                text not null default 'raw' check (kind in ('raw','prepared')),
  count_unit          text,                           -- unit it is counted in (kg, pcs, L ...)
  purchase_unit       text,                           -- unit it is bought in (bag, carton ...)
  units_per_purchase  numeric not null default 1 check (units_per_purchase > 0),
  cost_price          numeric check (cost_price is null or cost_price >= 0), -- per count unit, NGN
  reorder_level       numeric,
  count_frequency     text not null default 'weekly' check (count_frequency in ('daily','weekly')),
  tracks_expiry       boolean not null default false,
  active              boolean not null default true,
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.item_changes (
  id          bigserial primary key,
  item_id     text not null,
  changed_by  uuid,
  changed_at  timestamptz not null default now(),
  field       text not null,
  old_value   text,
  new_value   text
);

create table if not exists public.settings (
  key    text primary key,
  value  jsonb not null
);

-- The ledger: every stock and money entry. Append-only.
create table if not exists public.events (
  id           uuid primary key default gen_random_uuid(),
  seq          bigserial unique,
  type         text not null,
  occurred_at  timestamptz not null default now(),    -- when it happened (set by server unless from paper / write-off)
  recorded_at  timestamptz not null default now(),    -- when it was saved (always server time)
  actor_id     uuid not null,
  actor_name   text not null,
  actor_role   text not null,
  location_id  text,
  source       text not null default 'app' check (source in ('app','paper','import','webhook')),
  paper_page   text,
  data         jsonb not null default '{}'::jsonb
);
create index if not exists events_type_idx   on public.events (type, occurred_at);
create index if not exists events_loc_idx    on public.events (location_id, occurred_at);
create index if not exists events_po_idx     on public.events ((data->>'poId'));
create index if not exists events_req_idx    on public.events ((data->>'reqId'));
create index if not exists events_mov_idx    on public.events ((data->>'movId'));

create sequence if not exists public.po_seq;
create sequence if not exists public.req_seq;
create sequence if not exists public.mov_seq;
create sequence if not exists public.session_seq;
create sequence if not exists public.batch_seq;

-- ---------- Append-only guard ----------------------------------------

create or replace function public._no_change() returns trigger language plpgsql as $$
begin
  raise exception 'Ledger entries cannot be changed or deleted. Record a correction instead.';
end $$;

drop trigger if exists events_no_update on public.events;
create trigger events_no_update before update or delete on public.events
  for each row execute function public._no_change();

-- ---------- Item change audit + owner-only price/unit changes ---------

create or replace function public._item_audit() returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  f text;
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  is_owner boolean := exists (select 1 from profiles where id = auth.uid() and 'owner' = any(roles) and active);
begin
  new.updated_at := now();
  n := to_jsonb(new);
  foreach f in array array['name','category','kind','count_unit','purchase_unit','units_per_purchase',
                           'cost_price','reorder_level','count_frequency','tracks_expiry','active','note'] loop
    if (o->>f) is distinct from (n->>f) then
      -- Only the owner may change a price, unit or conversion once it has been set.
      if f in ('cost_price','count_unit','purchase_unit','units_per_purchase')
         and (o->>f) is not null and not is_owner
         and not (f = 'units_per_purchase' and (o->>f)::numeric = 1 and o->>'purchase_unit' is null) then
        raise exception 'Only the owner can change % once it is set.', f;
      end if;
      insert into item_changes(item_id, changed_by, field, old_value, new_value)
      values (old.id, auth.uid(), f, o->>f, n->>f);
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists items_audit on public.items;
create trigger items_audit before update on public.items
  for each row execute function public._item_audit();

create or replace function public._item_no_delete() returns trigger language plpgsql as $$
begin
  raise exception 'Items are never deleted. Set active = false instead.';
end $$;
drop trigger if exists items_no_delete on public.items;
create trigger items_no_delete before delete on public.items
  for each row execute function public._item_no_delete();

-- ---------- Helpers ---------------------------------------------------

create or replace function public.lagos_today() returns date language sql stable as $$
  select (now() at time zone 'Africa/Lagos')::date
$$;

create or replace function public._me() returns public.profiles
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles;
begin
  select * into p from profiles where id = auth.uid();
  if p.id is null then raise exception 'Your account is not set up. Ask the owner.'; end if;
  if not p.active then raise exception 'Your account has been switched off. Ask the owner.'; end if;
  return p;
end $$;

create or replace function public._has(p public.profiles, r text) returns boolean
language sql immutable as $$ select r = any(p.roles) $$;

create or replace function public._need(p public.profiles, variadic rs text[]) returns void
language plpgsql stable as $$
begin
  if not (p.roles && rs) then
    raise exception 'Your role cannot do this.';
  end if;
end $$;

create or replace function public.is_reviewer() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from profiles where id = auth.uid() and active and roles && array['owner','admin'])
$$;

-- Validates [{code, qty, ...}] lines; returns them normalised.
create or replace function public._lines(p_lines jsonb, p_allow_zero boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  l jsonb; out jsonb := '[]'::jsonb; q numeric; seen text[] := '{}'; c text;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one item.';
  end if;
  if jsonb_array_length(p_lines) > 300 then raise exception 'Too many lines.'; end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    c := l->>'code';
    if c is null or not exists (select 1 from items where id = c) then
      raise exception 'Unknown item: %', coalesce(c, '(blank)');
    end if;
    if c = any(seen) then raise exception 'Item listed twice: %', c; end if;
    seen := seen || c;
    begin q := round((l->>'qty')::numeric, 2);
    exception when others then raise exception 'Quantity for % is not a number.', c; end;
    if q is null or q < 0 or (q = 0 and not p_allow_zero) then
      raise exception 'Quantity for % must be more than zero.', c;
    end if;
    out := out || jsonb_build_array(jsonb_build_object('code', c, 'qty', q) || (l - 'code' - 'qty'));
  end loop;
  return out;
end $$;

-- Writes one ledger entry.
create or replace function public._emit(
  p public.profiles, p_type text, p_loc text, p_data jsonb,
  p_role text, p_occurred timestamptz default null, p_paper text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  eid uuid; occ timestamptz := now(); src text := 'app';
begin
  if p_paper is not null and length(trim(p_paper)) > 0 then
    src := 'paper';
    if p_occurred is null then raise exception 'Give the date and time written on the paper record.'; end if;
  end if;
  if p_occurred is not null then
    if p_occurred > now() + interval '5 minutes' then raise exception 'That time is in the future.'; end if;
    if p_occurred < now() - interval '7 days' then raise exception 'Entries older than 7 days must be added by the owner as a correction.'; end if;
    occ := p_occurred;
  end if;
  insert into events(type, occurred_at, actor_id, actor_name, actor_role, location_id, source, paper_page, data)
  values (p_type, occ, p.id, p.full_name, p_role, p_loc, src, nullif(trim(p_paper), ''), p_data)
  returning id into eid;
  return eid;
end $$;

create or replace function public._open_session() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select o.data->>'sessionId' from events o
  where o.type = 'STORE_OPEN'
    and not exists (select 1 from events c where c.type = 'STORE_CLOSE' and c.data->>'sessionId' = o.data->>'sessionId')
  order by o.seq desc limit 1
$$;

create or replace function public._profile(p_id uuid) returns public.profiles
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles;
begin
  select * into p from profiles where id = p_id and active;
  if p.id is null then raise exception 'That staff member was not found or is switched off.'; end if;
  return p;
end $$;

-- ---------- Everyone ----------------------------------------------------

create or replace function public.my_profile() returns json
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles := _me();
begin
  return json_build_object('id', p.id, 'full_name', p.full_name, 'username', p.username,
    'roles', p.roles, 'branch_id', p.branch_id,
    'branch_name', (select name from locations where id = p.branch_id));
end $$;

-- Names and roles only: used to pick a driver or a witness.
create or replace function public.staff_directory() returns table(id uuid, full_name text, roles text[], branch_id text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform _me();
  return query select s.id, s.full_name, s.roles, s.branch_id from profiles s where s.active order by s.full_name;
end $$;

-- Item names and units for forms (no stock figures).
create or replace function public.item_list() returns table(id text, name text, category text, kind text,
  count_unit text, purchase_unit text, units_per_purchase numeric, count_frequency text, tracks_expiry boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform _me();
  return query select i.id, i.name, i.category, i.kind, i.count_unit, i.purchase_unit, i.units_per_purchase,
    i.count_frequency, i.tracks_expiry from items i where i.active order by i.category, i.name;
end $$;

-- ---------- Store sessions (storekeeper) -------------------------------

create or replace function public.store_status() returns json
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); sid text; e events;
begin
  perform _need(p, 'storekeeper');
  sid := _open_session();
  if sid is null then return json_build_object('open', false); end if;
  select * into e from events where type = 'STORE_OPEN' and data->>'sessionId' = sid;
  return json_build_object('open', true, 'sessionId', sid, 'openedAt', e.occurred_at,
    'reason', e.data->>'reason', 'present', e.data->'present');
end $$;

create or replace function public.store_open(p_reason text, p_present text[] default '{}')
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); sid text;
begin
  perform _need(p, 'storekeeper');
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason for opening the store.'; end if;
  if _open_session() is not null then raise exception 'The store is already open.'; end if;
  sid := 'S-' || lpad(nextval('session_seq')::text, 5, '0');
  perform _emit(p, 'STORE_OPEN', 'store', jsonb_build_object('sessionId', sid, 'reason', trim(p_reason),
    'present', to_jsonb(array_prepend(p.full_name, coalesce(p_present, '{}')))), 'storekeeper');
  return sid;
end $$;

create or replace function public.store_close() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); sid text := _open_session();
begin
  perform _need(p, 'storekeeper');
  if sid is null then raise exception 'The store is not open.'; end if;
  perform _emit(p, 'STORE_CLOSE', 'store', jsonb_build_object('sessionId', sid), 'storekeeper');
end $$;

-- ---------- Purchases (buyer) and goods received (storekeeper) ---------

-- Lines: [{code, qty, inPurchaseUnits?, unitPrice?}]. Stored in counting units.
create or replace function public.log_purchase(p_supplier text, p_lines jsonb, p_invoice_photo text default null,
  p_occurred timestamptz default null, p_paper_page text default null)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); po text; l jsonb; out jsonb := '[]'; f numeric;
begin
  perform _need(p, 'buyer');
  for l in select * from jsonb_array_elements(_lines(p_lines)) loop
    select units_per_purchase into f from items where id = l->>'code';
    if coalesce((l->>'inPurchaseUnits')::boolean, false) then
      out := out || jsonb_build_object('code', l->>'code', 'qty', round((l->>'qty')::numeric * f, 2),
        'purchaseQty', (l->>'qty')::numeric, 'unitPrice', l->'unitPrice');
    else
      out := out || jsonb_build_object('code', l->>'code', 'qty', (l->>'qty')::numeric, 'unitPrice', l->'unitPrice');
    end if;
  end loop;
  po := 'PO-' || lpad(nextval('po_seq')::text, 5, '0');
  perform _emit(p, 'PURCHASE', 'store', jsonb_build_object('poId', po, 'supplier', coalesce(trim(p_supplier), ''),
    'lines', out, 'invoicePhoto', p_invoice_photo), 'buyer', p_occurred, p_paper_page);
  return po;
end $$;

create or replace function public.my_purchases() returns json
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles := _me();
begin
  perform _need(p, 'buyer');
  return coalesce((select json_agg(json_build_object(
      'poId', e.data->>'poId', 'supplier', e.data->>'supplier', 'at', e.occurred_at,
      'items', (select json_agg(i.name) from jsonb_array_elements(e.data->'lines') x join items i on i.id = x->>'code'),
      'received', exists (select 1 from events g where g.type = 'GRN' and g.data->>'poId' = e.data->>'poId'))
    order by e.seq desc)
    from events e where e.type = 'PURCHASE' and e.actor_id = p.id
      and e.occurred_at > now() - interval '30 days'), '[]'::json);
end $$;

-- Blind: item names only, never the purchased quantities.
create or replace function public.pending_purchases() returns json
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles := _me();
begin
  perform _need(p, 'storekeeper');
  return coalesce((select json_agg(json_build_object(
      'poId', e.data->>'poId', 'supplier', e.data->>'supplier', 'at', e.occurred_at, 'buyer', e.actor_name,
      'items', (select json_agg(json_build_object('code', i.id, 'name', i.name, 'unit', i.count_unit,
                  'tracksExpiry', i.tracks_expiry))
                from jsonb_array_elements(e.data->'lines') x join items i on i.id = x->>'code'))
    order by e.seq)
    from events e where e.type = 'PURCHASE'
      and not exists (select 1 from events g where g.type = 'GRN' and g.data->>'poId' = e.data->>'poId')), '[]'::json);
end $$;

-- Lines: [{code, qty, expiry?}] counted at the door. A photo of the goods is required (except paper-book entries).
drop function if exists public.confirm_grn(text, jsonb, timestamptz, text);
create or replace function public.confirm_grn(p_po text, p_lines jsonb,
  p_occurred timestamptz default null, p_paper_page text default null, p_photo text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); pur events;
begin
  perform _need(p, 'storekeeper');
  select * into pur from events where type = 'PURCHASE' and data->>'poId' = p_po;
  if pur.id is null then raise exception 'Purchase % not found.', p_po; end if;
  if exists (select 1 from events where type = 'GRN' and data->>'poId' = p_po) then
    raise exception 'Purchase % was already received.', p_po; end if;
  if pur.actor_id = p.id then raise exception 'You logged this purchase, so someone else must confirm it.'; end if;
  if p_paper_page is null and _open_session() is null then raise exception 'Open the store first.'; end if;
  if p_paper_page is null and p_photo is null then raise exception 'Add a photo of the goods received.'; end if;
  perform _emit(p, 'GRN', 'store', jsonb_build_object('poId', p_po, 'lines', _lines(p_lines, true), 'photoPath', p_photo),
    'storekeeper', p_occurred, p_paper_page);
end $$;

-- ---------- Requests -----------------------------------------------------

-- Cook → kitchen ingredients; branch manager → stock for his branch.
create or replace function public.raise_request(p_kind text, p_lines jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); rq text; dest text; role text;
begin
  if p_kind = 'production' then
    perform _need(p, 'cook'); dest := 'kitchen'; role := 'cook';
  elsif p_kind in ('planned','topup') then
    perform _need(p, 'branch_manager'); role := 'branch_manager';
    dest := p.branch_id;
    if dest is null then raise exception 'Your account has no branch. Ask the owner.'; end if;
  else raise exception 'Unknown request type.'; end if;
  rq := 'REQ-' || lpad(nextval('req_seq')::text, 5, '0');
  perform _emit(p, 'REQUEST', dest, jsonb_build_object('reqId', rq, 'dest', dest, 'branch', dest,
    'kind', p_kind, 'lines', _lines(p_lines)), role);
  return rq;
end $$;

create or replace function public.open_requests() returns json
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles := _me();
begin
  perform _need(p, 'storekeeper');
  return coalesce((select json_agg(json_build_object(
      'reqId', e.data->>'reqId', 'dest', e.data->>'dest', 'destName', (select name from locations where id = e.data->>'dest'),
      'kind', e.data->>'kind', 'by', e.actor_name, 'byId', e.actor_id, 'at', e.occurred_at, 'lines', e.data->'lines') order by e.seq)
    from events e where e.type = 'REQUEST'
      and not exists (select 1 from events r where r.type = 'RELEASE' and r.data->>'reqId' = e.data->>'reqId')
      and e.occurred_at > now() - interval '3 days'), '[]'::json);
end $$;

-- ---------- Releases (storekeeper) ---------------------------------------

drop function if exists public.release_stock(text, jsonb, uuid, timestamptz, text);
create or replace function public.release_stock(p_req text, p_lines jsonb, p_carrier uuid,
  p_occurred timestamptz default null, p_paper_page text default null, p_photo text default null)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); rq events; c profiles; mv text; d jsonb;
begin
  perform _need(p, 'storekeeper');
  select * into rq from events where type = 'REQUEST' and data->>'reqId' = p_req;
  if rq.id is null then raise exception 'Request % not found.', p_req; end if;
  if exists (select 1 from events where type = 'RELEASE' and data->>'reqId' = p_req) then
    raise exception 'Request % was already released.', p_req; end if;
  if p_paper_page is null and _open_session() is null then raise exception 'Open the store first.'; end if;
  if p_paper_page is null and p_photo is null then raise exception 'Add a photo of the stock being released.'; end if;
  mv := 'MOV-' || lpad(nextval('mov_seq')::text, 5, '0');
  d := jsonb_build_object('movId', mv, 'reqId', p_req, 'dest', rq.data->>'dest', 'lines', _lines(p_lines), 'photoPath', p_photo);
  if rq.data->>'dest' = 'kitchen' then
    d := d || jsonb_build_object('receivedBy', rq.actor_name, 'receivedById', rq.actor_id);
  else
    c := _profile(p_carrier);
    if not _has(c, 'driver') then raise exception '% is not a driver.', c.full_name; end if;
    if c.id = rq.actor_id then raise exception 'The driver cannot carry a request he raised himself.'; end if;
    d := d || jsonb_build_object('carrier', c.full_name, 'carrierId', c.id);
  end if;
  perform _emit(p, 'RELEASE', 'store', d, 'storekeeper', p_occurred, p_paper_page);
  return mv;
end $$;

drop function if exists public.emergency_release(text, text, jsonb, uuid);
create or replace function public.emergency_release(p_dest text, p_reason text, p_lines jsonb, p_carrier uuid,
  p_photo text default null)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); c profiles; mv text;
begin
  perform _need(p, 'storekeeper');
  if not exists (select 1 from locations where id = p_dest and kind = 'branch' and active) then
    raise exception 'Choose a branch.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give the reason it could not wait.'; end if;
  if _open_session() is null then raise exception 'Open the store first.'; end if;
  if p_photo is null then raise exception 'Add a photo of the stock being released.'; end if;
  c := _profile(p_carrier);
  if not _has(c, 'driver') then raise exception '% is not a driver.', c.full_name; end if;
  mv := 'MOV-' || lpad(nextval('mov_seq')::text, 5, '0');
  perform _emit(p, 'RELEASE', 'store', jsonb_build_object('movId', mv, 'reqId', null, 'dest', p_dest,
    'reason', trim(p_reason), 'carrier', c.full_name, 'carrierId', c.id, 'lines', _lines(p_lines),
    'photoPath', p_photo), 'storekeeper');
  return mv;
end $$;

-- ---------- Driver ------------------------------------------------------

create or replace function public.my_runs() returns json
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles := _me();
begin
  perform _need(p, 'driver');
  return coalesce((select json_agg(json_build_object(
      'movId', e.data->>'movId', 'dest', (select name from locations where id = e.data->>'dest'), 'at', e.occurred_at,
      'lines', (select json_agg(json_build_object('name', i.name, 'unit', i.count_unit, 'qty', (x->>'qty')::numeric))
                from jsonb_array_elements(e.data->'lines') x join items i on i.id = x->>'code'),
      'received', exists (select 1 from events r where r.type = 'RECEIPT' and r.data->>'movId' = e.data->>'movId'))
    order by e.seq desc)
    from events e where e.type = 'RELEASE' and e.data->>'carrierId' = p.id::text
      and e.occurred_at > now() - interval '14 days'), '[]'::json);
end $$;

-- ---------- Branch manager: receive -----------------------------------

-- Blind: item names only, never the released quantities.
create or replace function public.incoming_deliveries() returns json
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles := _me();
begin
  perform _need(p, 'branch_manager');
  return coalesce((select json_agg(json_build_object(
      'movId', e.data->>'movId', 'carrier', e.data->>'carrier', 'at', e.occurred_at,
      'emergency', (e.data->>'reqId') is null,
      'items', (select json_agg(json_build_object('code', i.id, 'name', i.name, 'unit', i.count_unit))
                from jsonb_array_elements(e.data->'lines') x join items i on i.id = x->>'code'))
    order by e.seq)
    from events e where e.type = 'RELEASE' and e.data->>'dest' = p.branch_id
      and not exists (select 1 from events r where r.type = 'RECEIPT' and r.data->>'movId' = e.data->>'movId')), '[]'::json);
end $$;

create or replace function public.confirm_receipt(p_mov text, p_lines jsonb, p_note text default null,
  p_photo text default null, p_occurred timestamptz default null, p_paper_page text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); rl events;
begin
  perform _need(p, 'branch_manager');
  select * into rl from events where type = 'RELEASE' and data->>'movId' = p_mov;
  if rl.id is null then raise exception 'Delivery % not found.', p_mov; end if;
  if rl.data->>'dest' is distinct from p.branch_id then raise exception 'This delivery is not for your branch.'; end if;
  if exists (select 1 from events where type = 'RECEIPT' and data->>'movId' = p_mov) then
    raise exception 'Delivery % was already received.', p_mov; end if;
  if rl.data->>'carrierId' = p.id::text then raise exception 'You carried this delivery, so someone else must receive it.'; end if;
  if rl.actor_id = p.id then raise exception 'You released this stock, so someone else must receive it.'; end if;
  perform _emit(p, 'RECEIPT', p.branch_id, jsonb_build_object('movId', p_mov, 'lines', _lines(p_lines, true),
    'note', p_note, 'photo', p_photo is not null, 'photoPath', p_photo), 'branch_manager', p_occurred, p_paper_page);
end $$;

-- ---------- Kitchen (cook) ------------------------------------------------

create or replace function public.kitchen_open_issues() returns json
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles := _me();
begin
  perform _need(p, 'cook');
  return coalesce((select json_agg(json_build_object('movId', e.data->>'movId', 'at', e.occurred_at, 'lines', e.data->'lines') order by e.seq)
    from events e where e.type = 'RELEASE' and e.data->>'dest' = 'kitchen'
      and not exists (select 1 from events y where y.type = 'YIELD' and y.data->'issueIds' ? (e.data->>'movId'))
      and e.occurred_at > now() - interval '7 days'), '[]'::json);
end $$;

create or replace function public.report_yield(p_issue_ids text[], p_inputs jsonb, p_outputs jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); b text; o jsonb;
begin
  perform _need(p, 'cook');
  if coalesce(array_length(p_issue_ids, 1), 0) = 0 then raise exception 'Choose the ingredients this batch used.'; end if;
  for o in select * from jsonb_array_elements(_lines(p_outputs)) loop
    if (select kind from items where id = o->>'code') <> 'prepared' then
      raise exception '% is not a kitchen-made item. Ask the owner to add it as prepared.', o->>'code';
    end if;
  end loop;
  b := 'B-' || lpad(nextval('batch_seq')::text, 5, '0');
  perform _emit(p, 'YIELD', 'kitchen', jsonb_build_object('batchId', b, 'issueIds', to_jsonb(p_issue_ids),
    'inputs', _lines(p_inputs, true), 'outputs', _lines(p_outputs)), 'cook');
  return b;
end $$;

-- ---------- Write-offs (spoilage) ----------------------------------------

create or replace function public.record_write_off(p_loc text, p_occurred timestamptz, p_lines jsonb,
  p_reason text, p_witness uuid, p_photo text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); w profiles; role text;
begin
  if p_loc = 'store' then perform _need(p, 'storekeeper'); role := 'storekeeper';
  elsif p_loc = 'kitchen' then perform _need(p, 'cook'); role := 'cook';
  else
    perform _need(p, 'branch_manager'); role := 'branch_manager';
    if p_loc is distinct from p.branch_id then raise exception 'You can only record write-offs for your branch.'; end if;
  end if;
  if p_occurred is null then raise exception 'Give the date and time the spoilage happened or was found.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give the reason.'; end if;
  if p_photo is null then raise exception 'A photo is required for every write-off.'; end if;
  w := _profile(p_witness);
  if w.id = p.id then raise exception 'The witness must be a different person.'; end if;
  perform _emit(p, 'WASTE', p_loc, jsonb_build_object('loc', p_loc, 'lines', _lines(p_lines), 'reason', trim(p_reason),
    'witness', w.full_name, 'witnessId', w.id, 'photoPath', p_photo), role, p_occurred);
end $$;

-- ---------- Counts --------------------------------------------------------

-- Kitchen lead: end-of-day count of his branch. Others (owner, admin, counter): blind count of any location.
create or replace function public.submit_count(p_loc text, p_lines jsonb)
returns json language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); custodian text; lines jsonb := _lines(p_lines, true); d date := lagos_today();
begin
  if not exists (select 1 from locations where id = p_loc and active) then raise exception 'Unknown location.'; end if;
  if _has(p, 'kitchen_lead') and p_loc = p.branch_id then
    if exists (select 1 from events where type = 'KITCHEN_COUNT' and location_id = p_loc
               and (occurred_at at time zone 'Africa/Lagos')::date = d) then
      raise exception 'Tonight''s count for this branch was already submitted.';
    end if;
    perform _emit(p, 'KITCHEN_COUNT', p_loc, jsonb_build_object('loc', p_loc, 'lines', lines, 'businessDate', d), 'kitchen_lead');
    return json_build_object('ok', true);
  end if;
  perform _need(p, 'owner', 'admin', 'counter', 'storekeeper', 'cook');
  -- A count by the person who looks after that stock is recorded but held (see engine SELF_COUNT).
  custodian := case
    when p_loc = 'store' and _has(p, 'storekeeper') then p.full_name
    when p_loc = 'kitchen' and _has(p, 'cook') then p.full_name
    when p_loc = p.branch_id and _has(p, 'branch_manager') then p.full_name
    else 'custodian of ' || p_loc end;
  perform _emit(p, 'COUNT', p_loc, jsonb_build_object('loc', p_loc, 'lines', lines, 'custodian', custodian,
    'partial', true), coalesce(p.roles[1], 'counter'));
  return json_build_object('ok', true, 'held', custodian = p.full_name);
end $$;

-- ---------- Money end of day and Aronium total (both by the cashier) ----------
-- Step 1: the cashier submits the five money sources, delivery fees, refunds and notes.
-- Step 2: only after step 1 is locked can the Aronium total for that day be entered.

drop function if exists public.submit_cash_eod(date, numeric, numeric, numeric, numeric, numeric, jsonb, uuid, jsonb, text);

create or replace function public.submit_cash_eod(p_date date, p_cash numeric, p_transfer numeric, p_card numeric,
  p_chowdeck numeric, p_app numeric, p_delivery_fees jsonb, p_witness uuid, p_photos jsonb, p_note text default null,
  p_refunds jsonb default '[]'::jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); w profiles; fees jsonb := '[]'; refunds jsonb := '[]'; f jsonb;
  total_fees numeric := 0; total_refunds numeric := 0;
begin
  perform _need(p, 'cashier');
  if p.branch_id is null then raise exception 'Your account has no branch. Ask the owner.'; end if;
  if p_date is null or p_date > lagos_today() or p_date < lagos_today() - 1 then
    raise exception 'The date must be today or yesterday.'; end if;
  if exists (select 1 from events where type = 'CASH_EOD' and location_id = p.branch_id and data->>'businessDate' = p_date::text) then
    raise exception 'The end of day for this date was already submitted.'; end if;
  if least(coalesce(p_cash,0), coalesce(p_transfer,0), coalesce(p_card,0), coalesce(p_chowdeck,0), coalesce(p_app,0)) < 0 then
    raise exception 'Amounts cannot be negative.'; end if;
  w := _profile(p_witness);
  if w.id = p.id then raise exception 'The cash witness must be a different person.'; end if;
  if coalesce(jsonb_typeof(p_delivery_fees), 'null') = 'array' then
    for f in select * from jsonb_array_elements(p_delivery_fees) loop
      if coalesce((f->>'amount')::numeric, 0) <= 0 then raise exception 'Each delivery fee needs an amount.'; end if;
      if (f->>'method') is not null and (f->>'method') not in ('cash','transfer','card','chowdeck','app') then
        raise exception 'Choose how each delivery fee was paid.'; end if;
      fees := fees || jsonb_build_object('ref', coalesce(f->>'ref', ''), 'amount', round((f->>'amount')::numeric, 2),
        'method', f->>'method');
      total_fees := total_fees + (f->>'amount')::numeric;
    end loop;
  end if;
  if coalesce(jsonb_typeof(p_refunds), 'null') = 'array' then
    for f in select * from jsonb_array_elements(p_refunds) loop
      if coalesce((f->>'amount')::numeric, 0) <= 0 then raise exception 'Each refund needs an amount.'; end if;
      if coalesce(trim(f->>'reason'), '') = '' then raise exception 'Each refund needs a reason.'; end if;
      refunds := refunds || jsonb_build_object('ref', coalesce(f->>'ref', ''), 'amount', round((f->>'amount')::numeric, 2), 'reason', trim(f->>'reason'));
      total_refunds := total_refunds + (f->>'amount')::numeric;
    end loop;
  end if;
  if (p_photos->>'cash') is null then raise exception 'Add a photo of the counted cash.'; end if;
  if coalesce(p_chowdeck, 0) > 0 and (p_photos->>'chowdeck') is null then raise exception 'Add the Chowdeck screenshot.'; end if;
  if coalesce(p_app, 0) > 0 and (p_photos->>'app') is null then raise exception 'Add the app screenshot.'; end if;
  if coalesce(p_transfer, 0) > 0 and (p_photos->>'transfer') is null then raise exception 'Add the Moniepoint transfer screenshot.'; end if;
  if coalesce(p_card, 0) > 0 and (p_photos->>'card') is null then raise exception 'Add the Moniepoint card screenshot.'; end if;
  perform _emit(p, 'CASH_EOD', p.branch_id, jsonb_build_object('branch', p.branch_id, 'businessDate', p_date,
    'cash', coalesce(p_cash,0), 'transfer', coalesce(p_transfer,0), 'card', coalesce(p_card,0),
    'chowdeck', coalesce(p_chowdeck,0), 'app', coalesce(p_app,0),
    'deliveryFees', fees, 'deliveryTotal', total_fees, 'refunds', refunds, 'refundTotal', total_refunds,
    'transferManual', true, 'witness', w.full_name, 'witnessId', w.id,
    'photos', coalesce(p_photos, '{}'::jsonb), 'note', nullif(trim(p_note), '')), 'cashier');
end $$;

create or replace function public.submit_aronium_total(p_date date, p_total numeric, p_photo text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); role text;
begin
  perform _need(p, 'cashier', 'branch_manager');
  role := case when _has(p, 'cashier') then 'cashier' else 'branch_manager' end;
  if p.branch_id is null then raise exception 'Your account has no branch. Ask the owner.'; end if;
  if p_date is null or p_date > lagos_today() or p_date < lagos_today() - 1 then
    raise exception 'The date must be today or yesterday.'; end if;
  if p_total is null or p_total < 0 then raise exception 'Enter Aronium''s total sales.'; end if;
  if exists (select 1 from sync_devices where branch_id = p.branch_id and active) then
    raise exception 'This branch sends Aronium''s report automatically. Just close the register in Aronium.'; end if;
  if p_photo is null then raise exception 'Add a photo of the Aronium end-of-day report.'; end if;
  -- The money received is locked in first, so it can't be adjusted to match Aronium.
  if not exists (select 1 from events where type = 'CASH_EOD' and location_id = p.branch_id and data->>'businessDate' = p_date::text) then
    raise exception 'Submit the money received for this date first.'; end if;
  if exists (select 1 from events where type = 'ARONIUM_TOTAL' and location_id = p.branch_id and data->>'businessDate' = p_date::text) then
    raise exception 'Aronium''s total for this date was already submitted.'; end if;
  perform _emit(p, 'ARONIUM_TOTAL', p.branch_id, jsonb_build_object('branch', p.branch_id, 'businessDate', p_date,
    'total', round(p_total, 2), 'photoPath', p_photo), role);
end $$;

-- What has this person already submitted today (so forms can say "done").
create or replace function public.my_submissions(p_date date default null) returns json
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); d date := coalesce(p_date, lagos_today());
begin
  return json_build_object(
    'kitchenCount', exists (select 1 from events where type = 'KITCHEN_COUNT' and location_id = p.branch_id
                            and (occurred_at at time zone 'Africa/Lagos')::date = d),
    'cashEod', exists (select 1 from events where type = 'CASH_EOD' and location_id = p.branch_id and data->>'businessDate' = d::text),
    'aroniumTotal', exists (select 1 from events where type in ('ARONIUM_TOTAL','ARONIUM_ZREPORT') and location_id = p.branch_id
                            and data->>'businessDate' = d::text),
    'aroniumAuto', exists (select 1 from sync_devices where branch_id = p.branch_id and active));
end $$;

-- ---------- Owner -----------------------------------------------------------

create or replace function public.record_correction(p_ref uuid, p_reason text, p_loc text, p_lines jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); l jsonb; out jsonb := '[]';
begin
  perform _need(p, 'owner', 'admin');
  if not exists (select 1 from events where id = p_ref) then raise exception 'The entry being corrected was not found.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give the reason for the correction.'; end if;
  if not exists (select 1 from locations where id = p_loc) then raise exception 'Unknown location.'; end if;
  -- Correction lines may be negative (remove) or positive (add).
  for l in select * from jsonb_array_elements(p_lines) loop
    if not exists (select 1 from items where id = l->>'code') then raise exception 'Unknown item: %', l->>'code'; end if;
    if coalesce((l->>'qty')::numeric, 0) = 0 then raise exception 'Each line needs a non-zero quantity.'; end if;
    out := out || jsonb_build_object('code', l->>'code', 'qty', round((l->>'qty')::numeric, 2));
  end loop;
  perform _emit(p, 'CORRECTION', p_loc, jsonb_build_object('refId', p_ref, 'reason', trim(p_reason), 'loc', p_loc, 'lines', out),
    case when _has(p, 'owner') then 'owner' else 'admin' end);
end $$;

-- ---------- Row-level security ----------------------------------------------

alter table public.locations     enable row level security;
alter table public.profiles      enable row level security;
alter table public.items         enable row level security;
alter table public.item_changes  enable row level security;
alter table public.settings      enable row level security;
alter table public.events        enable row level security;

drop policy if exists locations_read on public.locations;
create policy locations_read on public.locations for select to authenticated using (true);
drop policy if exists locations_write on public.locations;
create policy locations_write on public.locations for all to authenticated using (is_reviewer()) with check (is_reviewer());

drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles for select to authenticated using (id = auth.uid() or is_reviewer());

drop policy if exists items_read on public.items;
create policy items_read on public.items for select to authenticated using (true);
drop policy if exists items_insert on public.items;
create policy items_insert on public.items for insert to authenticated with check (is_reviewer());
drop policy if exists items_update on public.items;
create policy items_update on public.items for update to authenticated using (is_reviewer()) with check (is_reviewer());

drop policy if exists item_changes_read on public.item_changes;
create policy item_changes_read on public.item_changes for select to authenticated using (is_reviewer());

drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated using (true);
drop policy if exists settings_write on public.settings;
create policy settings_write on public.settings for all to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and active and 'owner' = any(roles)))
  with check (exists (select 1 from profiles where id = auth.uid() and active and 'owner' = any(roles)));

-- Only the owner and admin can read the ledger. Nobody writes it directly: only through the functions above.
drop policy if exists events_read on public.events;
create policy events_read on public.events for select to authenticated using (is_reviewer());

revoke all on public.events from anon, authenticated;
grant select on public.events to authenticated;
revoke all on public.profiles from anon;
revoke insert, update, delete on public.profiles from authenticated;
grant select on public.profiles to authenticated;
revoke all on public.item_changes from anon, authenticated;
grant select on public.item_changes to authenticated;
revoke delete on public.items from authenticated;
revoke all on public.locations, public.items, public.settings from anon;

-- Functions: signed-in users only; internal helpers not callable from the app.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.proname like '\_%' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

-- ---------- Photo storage ----------------------------------------------------

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('photos', 'photos', false) on conflict (id) do nothing;
    execute 'drop policy if exists photos_upload on storage.objects';
    execute $p$create policy photos_upload on storage.objects for insert to authenticated
      with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
    execute 'drop policy if exists photos_read on storage.objects';
    execute $p$create policy photos_read on storage.objects for select to authenticated
      using (bucket_id = 'photos' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_reviewer()))$p$;
  end if;
end $$;

-- ---------- Seed data -------------------------------------------------------

insert into public.locations (id, name, kind) values
  ('store', 'Central store', 'store'),
  ('kitchen', 'Central kitchen', 'kitchen'),
  ('tanke', 'Tanke branch', 'branch'),
  ('adeta', 'Adeta branch', 'branch')
on conflict (id) do nothing;

insert into public.settings (key, value) values
  ('rules', '{"countTolerancePct":2,"countToleranceAbs":0.5,"countAlertValue":5000,"countAlertQty":2,
              "transitHours":6,"yieldDueHours":24,"purchaseGrnHours":24,"wasteWatchPct":3,"yieldTolerancePct":8,
              "writeOffWitnessValue":5000,"backdateHours":12,"moneyTolerance":500}'::jsonb),
  ('delivery_fee_mode', '"subtract"'::jsonb)
on conflict (key) do nothing;

insert into public.items (id, name, category, kind, count_frequency, tracks_expiry, note) values
  ('flour','Flour','Dry ingredients','raw','weekly',false,null),
  ('sugar','Sugar','Dry ingredients','raw','weekly',false,null),
  ('corn-starch','Corn starch','Dry ingredients','raw','weekly',false,null),
  ('citric-acid','Citric acid','Dry ingredients','raw','weekly',false,null),
  ('maggi','Maggi','Dry ingredients','raw','weekly',false,null),
  ('black-pepper','Black pepper','Dry ingredients','raw','weekly',false,'Dry spice; not fresh pepper or pepper powder'),
  ('thyme','Thyme','Dry ingredients','raw','weekly',false,null),
  ('pepper-powder','Pepper powder','Dry ingredients','raw','weekly',false,'Dry; not fresh pepper'),
  ('curry-masala','Curry masala','Dry ingredients','raw','weekly',false,null),
  ('salt','Salt','Dry ingredients','raw','weekly',false,null),
  ('ginger-powder','Ginger powder','Dry ingredients','raw','weekly',false,null),
  ('garlic-powder','Garlic powder','Dry ingredients','raw','weekly',false,null),
  ('slush-concentrate','Slush concentrate','Wet ingredients','raw','weekly',false,'One item per flavour if bought in flavours (to confirm)'),
  ('food-colours','Food colours','Wet ingredients','raw','weekly',false,null),
  ('vegetable-oil','Vegetable oil','Wet ingredients','raw','weekly',false,null),
  ('lime','Lime','Wet ingredients','raw','weekly',false,null),
  ('tomatoes','Tomatoes','Veggies','raw','daily',true,null),
  ('sweet-potatoes','Sweet potatoes','Veggies','raw','daily',true,null),
  ('irish-potatoes','Irish potatoes','Veggies','raw','daily',true,null),
  ('fresh-pepper','Fresh pepper','Veggies','raw','daily',true,'Fresh; not pepper powder'),
  ('onions','Onions','Veggies','raw','daily',true,null),
  ('green-pepper','Green pepper','Veggies','raw','daily',true,null),
  ('cabbage','Cabbage','Veggies','raw','daily',true,null),
  ('chicken','Chicken','Proteins','raw','daily',true,null),
  ('beef','Beef','Proteins','raw','daily',true,null),
  ('eggs','Eggs','Proteins','raw','daily',true,null),
  ('bama','Bama','Condiments','raw','weekly',false,null),
  ('jago','Jago','Condiments','raw','weekly',false,null),
  ('ketchup','Ketchup','Condiments','raw','weekly',false,null),
  ('sausage','Sausage','Perishables','raw','daily',true,null),
  ('cheese-slices','Cheese slices','Perishables','raw','daily',true,null),
  ('cheese-melt','Cheese melt','Perishables','raw','daily',true,null),
  ('bread-loaves','Bread loaves','Perishables','raw','daily',true,null),
  ('shawarma-bread','Shawarma bread','Perishables','raw','daily',true,null),
  ('burger-bread','Burger bread','Perishables','raw','daily',true,null),
  ('frozen-fries','Frozen fries','Perishables','raw','daily',true,null),
  ('foil-paper','Foil paper','Packaging','raw','weekly',false,null),
  ('slush-cups','Slush cups','Packaging','raw','daily',false,null),
  ('straws','Straws','Packaging','raw','weekly',false,null),
  ('slush-nylon','Slush nylon','Packaging','raw','weekly',false,null),
  ('tissue','Tissue','Packaging','raw','weekly',false,null),
  ('toothpicks','Toothpicks','Packaging','raw','weekly',false,null),
  ('takeaway-nylon','Takeaway nylon','Packaging','raw','weekly',false,null),
  ('food-box-large','Large food box','Packaging','raw','daily',false,null),
  ('food-box-regular','Regular food box','Packaging','raw','daily',false,null),
  ('food-box-mini','Mini food box','Packaging','raw','daily',false,null),
  ('forks','Forks','Packaging','raw','weekly',false,null),
  ('rubber-bands','Rubber bands','Packaging','raw','weekly',false,null),
  ('nylon-gloves','Nylon gloves','Packaging','raw','weekly',false,null),
  ('ketchup-containers','Ketchup sauce containers','Packaging','raw','weekly',false,null),
  ('thousand-island-containers','Thousand island containers','Packaging','raw','weekly',false,null),
  ('detergent','Detergent','Maintenance','raw','weekly',false,null),
  ('towels','Towels','Maintenance','raw','weekly',false,null),
  ('stapler','Stapler','Maintenance','raw','weekly',false,null),
  ('stapler-pins','Stapler pins','Maintenance','raw','weekly',false,null),
  ('pos-paper-58','POS paper 58mm','Maintenance','raw','weekly',false,null),
  ('pos-paper-80','POS paper 80mm','Maintenance','raw','weekly',false,null),
  ('pens','Pens','Maintenance','raw','weekly',false,null),
  ('markers','Markers','Maintenance','raw','weekly',false,null),
  ('air-freshener','Air freshener','Maintenance','raw','weekly',false,null),
  ('glass-cleaner','Glass cleaner','Maintenance','raw','weekly',false,null),
  ('mosquito-spray','Mosquito spray','Maintenance','raw','weekly',false,null),
  ('garlic-sauce','Garlic sauce','Kitchen-made','prepared','daily',true,'Made in the central kitchen. Recipe and batch yield to confirm')
on conflict (id) do nothing;

-- ---------- Branch names (safe to re-run) ----------------------------------
-- The two branches are Tanke branch and Adeta branch. This also fixes a database
-- that was set up with the earlier placeholder "Branch 2".
update public.locations set name = 'Tanke branch' where id = 'tanke';
insert into public.locations (id, name, kind) values ('adeta', 'Adeta branch', 'branch')
  on conflict (id) do update set name = excluded.name, kind = 'branch', active = true;
update public.profiles set branch_id = 'adeta' where branch_id = 'branch2';
delete from public.locations l where l.id = 'branch2'
  and not exists (select 1 from public.events e where e.location_id = 'branch2' or e.data->>'dest' = 'branch2' or e.data->>'branch' = 'branch2');

-- ---------- Menu (owner manages) and measurements per menu item ---------------
-- Safe to re-run. Menu items are switched off, never deleted, so past reports stay correct.

create table if not exists public.menu_items (
  id            text primary key,
  name          text not null,
  category      text not null,
  size          text,
  price         numeric check (price is null or price >= 0),   -- NGN
  aronium_name  text,                                          -- exact name in Aronium, for matching sales later
  note          text,
  sort          int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Measurements: how much of each stock item one portion of a menu item uses.
create table if not exists public.menu_recipe_lines (
  menu_item_id  text not null references public.menu_items(id),
  item_id       text not null references public.items(id),
  qty           numeric not null check (qty > 0),
  primary key (menu_item_id, item_id)
);

create table if not exists public.menu_changes (
  id            bigserial primary key,
  menu_item_id  text not null,
  changed_by    uuid,
  changed_at    timestamptz not null default now(),
  field         text not null,
  old_value     text,
  new_value     text
);

create or replace function public._menu_audit() returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  f text; o jsonb := to_jsonb(old); n jsonb;
  is_owner boolean := exists (select 1 from profiles where id = auth.uid() and 'owner' = any(roles) and active);
begin
  new.updated_at := now(); n := to_jsonb(new);
  foreach f in array array['name','category','size','price','aronium_name','note','sort','active'] loop
    if (o->>f) is distinct from (n->>f) then
      if f = 'price' and (o->>f) is not null and not is_owner then
        raise exception 'Only the owner can change a menu price once it is set.';
      end if;
      insert into menu_changes(menu_item_id, changed_by, field, old_value, new_value) values (old.id, auth.uid(), f, o->>f, n->>f);
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists menu_items_audit on public.menu_items;
create trigger menu_items_audit before update on public.menu_items for each row execute function public._menu_audit();

create or replace function public._menu_no_delete() returns trigger language plpgsql as $$
begin raise exception 'Menu items are never deleted. Switch them off instead.'; end $$;
drop trigger if exists menu_items_no_delete on public.menu_items;
create trigger menu_items_no_delete before delete on public.menu_items for each row execute function public._menu_no_delete();

-- Replace one menu item's measurements in one go, logging what changed.
create or replace function public.save_menu_recipe(p_menu_item text, p_lines jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); l jsonb; newl jsonb := '{}'::jsonb; oldl jsonb; c text;
begin
  perform _need(p, 'owner', 'admin');
  if not exists (select 1 from menu_items where id = p_menu_item) then raise exception 'Menu item not found.'; end if;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if not exists (select 1 from items where id = l->>'code') then raise exception 'Unknown stock item: %', l->>'code'; end if;
    if coalesce((l->>'qty')::numeric, 0) <= 0 then raise exception 'Each measurement needs a quantity above 0.'; end if;
    if newl ? (l->>'code') then raise exception 'A stock item is listed twice.'; end if;
    newl := newl || jsonb_build_object(l->>'code', round((l->>'qty')::numeric, 4));
  end loop;
  select coalesce(jsonb_object_agg(item_id, qty), '{}'::jsonb) into oldl from menu_recipe_lines where menu_item_id = p_menu_item;
  for c in select distinct k from (select jsonb_object_keys(oldl) k union select jsonb_object_keys(newl)) x loop
    if (oldl->>c) is distinct from (newl->>c) then
      insert into menu_changes(menu_item_id, changed_by, field, old_value, new_value)
      values (p_menu_item, p.id, 'measurement: ' || (select name from items where id = c), oldl->>c, newl->>c);
    end if;
  end loop;
  delete from menu_recipe_lines where menu_item_id = p_menu_item;
  insert into menu_recipe_lines(menu_item_id, item_id, qty)
    select p_menu_item, key, value::text::numeric from jsonb_each(newl);
end $$;

alter table public.menu_items        enable row level security;
alter table public.menu_recipe_lines enable row level security;
alter table public.menu_changes      enable row level security;
drop policy if exists menu_read on public.menu_items;
create policy menu_read on public.menu_items for select to authenticated using (is_reviewer());
drop policy if exists menu_insert on public.menu_items;
create policy menu_insert on public.menu_items for insert to authenticated with check (is_reviewer());
drop policy if exists menu_update on public.menu_items;
create policy menu_update on public.menu_items for update to authenticated using (is_reviewer()) with check (is_reviewer());
drop policy if exists menu_recipe_read on public.menu_recipe_lines;
create policy menu_recipe_read on public.menu_recipe_lines for select to authenticated using (is_reviewer());
drop policy if exists menu_changes_read on public.menu_changes;
create policy menu_changes_read on public.menu_changes for select to authenticated using (is_reviewer());
revoke all on public.menu_items, public.menu_recipe_lines, public.menu_changes from anon;
revoke delete on public.menu_items from authenticated;
revoke insert, update, delete on public.menu_recipe_lines, public.menu_changes from authenticated;
grant select, insert, update on public.menu_items to authenticated;
grant select on public.menu_recipe_lines, public.menu_changes to authenticated;
revoke all on function public.save_menu_recipe(text, jsonb) from public, anon;
grant execute on function public.save_menu_recipe(text, jsonb) to authenticated;
revoke all on function public._menu_audit() from public, anon, authenticated;

-- The current menu (orange posters, October 2026). Aronium names to be confirmed.
insert into public.menu_items (id, category, name, size, price, sort, note) values
  ('wrap-regular',            'Chicken wraps',   'Chicken wrap',                              'Regular', 3500, 10, null),
  ('wrap-large',              'Chicken wraps',   'Chicken wrap',                              'Large',   5500, 11, null),
  ('sub-bomb-regular',        'Sub sandwiches',  'Beiroot Bomb (chicken + beef)',             'Regular', 4900, 20, null),
  ('sub-bomb-large',          'Sub sandwiches',  'Beiroot Bomb (chicken + beef)',             'Large',   6900, 21, null),
  ('sub-chicken-beef-regular','Sub sandwiches',  'Chicken or beef sub',                       'Regular', 3500, 22, null),
  ('sub-chicken-beef-large',  'Sub sandwiches',  'Chicken or beef sub',                       'Large',   3900, 23, null),
  ('sub-spicy-egg',           'Sub sandwiches',  'Beiroot sandwich (spicy egg)',              null,      2900, 24, null),
  ('burger-single',           'Chicken burgers', 'Single',                                    null,      4200, 30, null),
  ('burger-single-cheese',    'Chicken burgers', 'Single + cheese',                           null,      4900, 31, null),
  ('burger-bigback',          'Chicken burgers', 'Bigback',                                   null,      5900, 32, null),
  ('burger-bigback-cheese',   'Chicken burgers', 'Bigback + cheese',                          null,      6600, 33, null),
  ('lf-irish-mini-spicy-eggs', 'Loaded fries (Irish potato)', 'Spicy eggs', 'Mini', 3500, 40, null),
  ('lf-irish-mini-chicken-beef', 'Loaded fries (Irish potato)', 'Chicken / beef', 'Mini', 3900, 41, null),
  ('lf-irish-mini-fully-loaded', 'Loaded fries (Irish potato)', 'Fully loaded (crispy chicken + shredded beef)', 'Mini', 5500, 42, null),
  ('lf-irish-regular-chicken-beef', 'Loaded fries (Irish potato)', 'Chicken or beef', 'Regular', 4900, 43, null),
  ('lf-irish-regular-fully-loaded', 'Loaded fries (Irish potato)', 'Fully loaded (crispy chicken + shredded beef)', 'Regular', 6500, 44, null),
  ('lf-irish-large-chicken-beef', 'Loaded fries (Irish potato)', 'Chicken or beef', 'Large', 5900, 45, null),
  ('lf-irish-large-fully-loaded', 'Loaded fries (Irish potato)', 'Fully loaded (crispy chicken + shredded beef)', 'Large', 7500, 46, null),
  ('lf-sweet-mini-spicy-eggs', 'Loaded fries (sweet potato)', 'Spicy eggs', 'Mini', 3500, 48, null),
  ('lf-sweet-mini-chicken-beef', 'Loaded fries (sweet potato)', 'Chicken / beef', 'Mini', 3900, 49, null),
  ('lf-sweet-mini-fully-loaded', 'Loaded fries (sweet potato)', 'Fully loaded (crispy chicken + shredded beef)', 'Mini', 5500, 50, null),
  ('lf-sweet-regular-chicken-beef', 'Loaded fries (sweet potato)', 'Chicken or beef', 'Regular', 4900, 51, null),
  ('lf-sweet-regular-fully-loaded', 'Loaded fries (sweet potato)', 'Fully loaded (crispy chicken + shredded beef)', 'Regular', 6500, 52, null),
  ('lf-sweet-large-chicken-beef', 'Loaded fries (sweet potato)', 'Chicken or beef', 'Large', 5900, 53, null),
  ('lf-sweet-large-fully-loaded', 'Loaded fries (sweet potato)', 'Fully loaded (crispy chicken + shredded beef)', 'Large', 7500, 54, null),
  ('side-tenders-regular',    'Sides',           'Chicken tenders',                           'Regular', 3900, 50, null),
  ('side-tenders-large',      'Sides',           'Chicken tenders',                           'Large',   5900, 51, null),
  ('side-fries-regular',      'Sides',           'Fries',                                     'Regular', 3400, 52, null),
  ('side-fries-large',        'Sides',           'Fries',                                     'Large',   4900, 53, null),
  ('topup-crispy-chicken',    'Top-ups',         'Crispy chicken',                            null,      1200, 60, null),
  ('topup-shredded-chicken',  'Top-ups',         'Shredded chicken',                          null,      1200, 61, null),
  ('topup-shredded-beef',     'Top-ups',         'Shredded beef',                             null,      1200, 62, null),
  ('topup-spicy-eggs',        'Top-ups',         'Spicy eggs',                                null,       600, 63, null),
  ('extra-cream',             'Extras',          'Extra cream',                               null,         0, 70, 'Free'),
  ('extra-sausage',           'Extras',          'Sausage',                                   null,       350, 71, null),
  ('extra-double-sausage',    'Extras',          'Double sausage',                            null,       700, 72, null),
  ('extra-caramelized-onions','Extras',          'Caramelized onions',                        null,       600, 73, null),
  ('extra-omelette',          'Extras',          'Omelette',                                  null,       500, 74, null),
  ('extra-cheese-slice',      'Extras',          'Cheese slice',                              null,       800, 75, null),
  ('extra-cheese-melt',       'Extras',          'Cheese melt',                               null,      1500, 76, null),
  ('dip-garlic',              'Dips',            'Garlic',                                    null,       400, 80, null),
  ('dip-pepper',              'Dips',            'Pepper',                                    null,       400, 81, null),
  ('dip-ketchup',             'Dips',            'Ketchup',                                   null,       400, 82, null),
  ('dip-thousand-island',     'Dips',            'Thousand island',                           null,       500, 83, null),
  ('drink-slush',             'Drinks',          'Slush',                                     'Cup',     2000, 90, null)
on conflict (id) do nothing;

-- Not on the posters; the owner sets the prices in Settings → Menu.
insert into public.menu_items (id, category, name, size, price, sort, note) values
  ('side-crispy-meal',        'Sides',           'Crispy meal',                               null,      null, 56, 'Price to be set by the owner'),
  ('side-extra-fries',        'Sides',           'Extra fries',                               null,      null, 57, 'Price to be set by the owner')
on conflict (id) do nothing;

-- ---------- Aronium sync (branch laptops) --------------------------------------
-- Each branch laptop runs a small program that reads Aronium's own database (read-only)
-- and sends each closed register (Z report) here. The laptop holds a key; only its
-- SHA-256 hash is stored. Reports are written to the ledger as ARONIUM_ZREPORT.

create table if not exists public.sync_devices (
  id            uuid primary key default gen_random_uuid(),
  branch_id     text not null references public.locations(id),
  name          text not null,
  key_hash      text not null unique,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  last_seen_at  timestamptz,
  last_status   jsonb
);

-- Item names as they appear in each branch's Aronium (refreshed by the laptop).
create table if not exists public.aronium_products (
  branch_id     text not null references public.locations(id),
  norm          text not null,
  name          text not null,
  price         numeric,
  grp           text,
  enabled       boolean,
  last_seen_at  timestamptz not null default now(),
  primary key (branch_id, norm)
);

-- Aronium names linked by the owner to a menu item (one menu for all branches).
create table if not exists public.menu_aliases (
  norm          text primary key,
  alias         text not null,
  menu_item_id  text not null references public.menu_items(id),
  created_by    uuid,
  created_at    timestamptz not null default now()
);

-- Names are matched ignoring case and extra spaces ("Chicken Wrap  " = "chicken wrap").
create or replace function public.norm_name(t text) returns text language sql immutable as $$
  select lower(regexp_replace(trim(coalesce(t, '')), '\s+', ' ', 'g'))
$$;

-- Owner/admin: register a laptop. The key is made in the owner's browser and shown once; only its hash comes here.
create or replace function public.create_sync_device(p_branch text, p_name text, p_key_hash text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); d uuid;
begin
  perform _need(p, 'owner', 'admin');
  if not exists (select 1 from locations where id = p_branch and kind = 'branch') then raise exception 'Choose a branch.'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the laptop a name.'; end if;
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid key.'; end if;
  insert into sync_devices(branch_id, name, key_hash, created_by) values (p_branch, trim(p_name), p_key_hash, p.id)
    returning id into d;
  return d;
end $$;

create or replace function public.set_sync_device_active(p_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me();
begin
  perform _need(p, 'owner', 'admin');
  update sync_devices set active = coalesce(p_active, false) where id = p_id;
  if not found then raise exception 'Laptop not found.'; end if;
end $$;

-- Owner/admin: link an Aronium item name to a menu item (or unlink with p_menu_item = null).
create or replace function public.link_aronium_name(p_name text, p_menu_item text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p profiles := _me(); n text := norm_name(p_name); old text;
begin
  perform _need(p, 'owner', 'admin');
  if n = '' then raise exception 'Give the Aronium item name.'; end if;
  select menu_item_id into old from menu_aliases where norm = n;
  if p_menu_item is null then
    if old is null then return; end if;
    delete from menu_aliases where norm = n;
    insert into menu_changes(menu_item_id, changed_by, field, old_value, new_value)
      values (old, p.id, 'Aronium name unlinked', trim(p_name), null);
    return;
  end if;
  if not exists (select 1 from menu_items where id = p_menu_item) then raise exception 'Menu item not found.'; end if;
  if old is not distinct from p_menu_item then return; end if;
  insert into menu_aliases(norm, alias, menu_item_id, created_by) values (n, trim(p_name), p_menu_item, p.id)
    on conflict (norm) do update set alias = excluded.alias, menu_item_id = excluded.menu_item_id,
      created_by = excluded.created_by, created_at = now();
  if old is not null then
    insert into menu_changes(menu_item_id, changed_by, field, old_value, new_value)
      values (old, p.id, 'Aronium name moved to ' || p_menu_item, trim(p_name), null);
  end if;
  insert into menu_changes(menu_item_id, changed_by, field, old_value, new_value)
    values (p_menu_item, p.id, 'Aronium name linked', null, trim(p_name));
end $$;

-- Called only by the server (api/aronium.js) with the hash of the laptop's key.
create or replace function public._aronium_ingest(p_key_hash text, p_kind text, p_body jsonb)
returns json language plpgsql security definer set search_path = public, pg_temp as $$
declare
  dev sync_devices; z jsonb; prev events; closed timestamp; bdate date; pay jsonb; k text; v numeric;
  pr jsonb; n int := 0; body jsonb;
begin
  select * into dev from sync_devices where key_hash = p_key_hash;
  if dev.id is null or not dev.active then raise exception 'unknown or revoked device'; end if;
  update sync_devices set last_seen_at = now(),
    last_status = case when p_kind = 'heartbeat' then p_body->'status' else last_status end
  where id = dev.id;

  if p_kind = 'heartbeat' then
    return json_build_object('ok', true, 'branch', dev.branch_id);

  elsif p_kind = 'products' then
    for pr in select * from jsonb_array_elements(coalesce(p_body->'products', '[]'::jsonb)) limit 3000 loop
      continue when norm_name(pr->>'name') = '';
      insert into aronium_products(branch_id, norm, name, price, grp, enabled, last_seen_at)
      values (dev.branch_id, norm_name(pr->>'name'), trim(pr->>'name'), (pr->>'price')::numeric, pr->>'group',
              coalesce((pr->>'enabled')::boolean, true), now())
      on conflict (branch_id, norm) do update set name = excluded.name, price = excluded.price, grp = excluded.grp,
        enabled = excluded.enabled, last_seen_at = now();
      n := n + 1;
    end loop;
    return json_build_object('ok', true, 'products', n);

  elsif p_kind = 'zreport' then
    z := p_body->'report';
    if z is null or (z->>'zId') is null or (z->>'closedAt') is null then raise exception 'report incomplete'; end if;
    closed := (z->>'closedAt')::timestamp;                     -- Aronium's local (Lagos) time
    bdate := (closed - interval '6 hours')::date;              -- closed before 6am = the previous business day
    -- Payments by type, mapped to the cashier's five sources.
    pay := '{"cash":0,"card":0,"transfer":0,"app":0,"chowdeck":0,"other":0}'::jsonb;
    for k, v in select norm_name(x->>'name'), coalesce((x->>'amount')::numeric, 0)
                from jsonb_array_elements(coalesce(z->'payments', '[]'::jsonb)) x loop
      k := case when k like '%cash%' then 'cash' when k like '%card%' or k like '%pos%' then 'card'
                when k like '%transfer%' or k like '%bank%' then 'transfer' when k like '%chowdeck%' then 'chowdeck'
                when k = 'app' or k like '%app%' then 'app' else 'other' end;
      pay := jsonb_set(pay, array[k], to_jsonb(round((pay->>k)::numeric + v, 2)));
    end loop;
    body := jsonb_build_object('branch', dev.branch_id, 'businessDate', bdate,
      'zId', (z->>'zId')::bigint, 'zNumber', (z->>'zNumber')::bigint, 'closedAt', z->>'closedAt',
      'fromDoc', z->'fromDoc', 'toDoc', z->'toDoc', 'payments', pay, 'paymentsRaw', coalesce(z->'payments', '[]'::jsonb),
      'total', round((pay->>'cash')::numeric + (pay->>'card')::numeric + (pay->>'transfer')::numeric
                     + (pay->>'app')::numeric + (pay->>'chowdeck')::numeric + (pay->>'other')::numeric, 2),
      'salesTotal', z->'salesTotal', 'salesCount', z->'salesCount', 'refundTotal', z->'refundTotal',
      'refundCount', z->'refundCount', 'docCount', z->'docCount', 'missingDocs', coalesce((z->>'missingDocs')::int, 0),
      'items', coalesce(z->'items', '[]'::jsonb), 'device', dev.name, 'deviceId', dev.id);
    select * into prev from events where type = 'ARONIUM_ZREPORT' and location_id = dev.branch_id
      and (data->>'zId')::bigint = (z->>'zId')::bigint order by seq limit 1;
    if prev.id is not null then
      if prev.data->'payments' = body->'payments' and prev.data->>'zNumber' = body->>'zNumber' then
        return json_build_object('ok', true, 'duplicate', true);
      end if;
      -- Same register close sent again with different figures: keep the first, flag it.
      if not exists (select 1 from events where type = 'SYNC_ALERT' and location_id = dev.branch_id
                     and data->>'zId' = z->>'zId' and data->'report'->'payments' = body->'payments') then
        insert into events(type, occurred_at, actor_id, actor_name, actor_role, location_id, source, data)
        values ('SYNC_ALERT', now(), '00000000-0000-0000-0000-000000000000', 'Aronium sync (' || dev.name || ')',
                'system', dev.branch_id, 'import',
                jsonb_build_object('kind', 'conflict', 'zId', (z->>'zId')::bigint, 'firstRef', prev.id, 'report', body));
      end if;
      return json_build_object('ok', true, 'conflict', true);
    end if;
    insert into events(type, occurred_at, actor_id, actor_name, actor_role, location_id, source, data)
    values ('ARONIUM_ZREPORT', least(closed at time zone 'Africa/Lagos', now()), '00000000-0000-0000-0000-000000000000',
            'Aronium sync (' || dev.name || ')', 'system', dev.branch_id, 'import', body);
    return json_build_object('ok', true, 'businessDate', bdate);
  end if;
  raise exception 'unknown kind';
end $$;

-- ---------- Low stock (procurement officer) -----------------------------------
-- Store balance per item: the latest independent count, plus everything since.
create or replace function public._store_balance() returns table(item_id text, qty numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  with base as (
    select distinct on (l->>'code') l->>'code' as code, (l->>'qty')::numeric as q, e.occurred_at as at, e.seq
    from events e cross join lateral jsonb_array_elements(e.data->'lines') l
    where e.type = 'COUNT' and e.location_id = 'store' and e.data->>'custodian' is distinct from e.actor_name
    order by l->>'code', e.occurred_at desc, e.seq desc
  ), mv as (
    select x.code, x.q, e.occurred_at as at, e.seq
    from events e cross join lateral (
      select l->>'code' as code,
             (l->>'qty')::numeric * case when e.type in ('RELEASE','WASTE','USE') then -1 else 1 end as q
      from jsonb_array_elements(case when e.type = 'YIELD' then e.data->'outputs' else e.data->'lines' end) l) x
    where e.type in ('GRN','RELEASE','YIELD')
       or (e.type in ('WASTE','USE','CORRECTION') and e.location_id = 'store')
  )
  select i.id, round(coalesce(b.q, 0) + coalesce((select sum(m.q) from mv m where m.code = i.id
           and (b.code is null or (m.at, m.seq) > (b.at, b.seq))), 0), 2)
  from items i left join base b on b.code = i.id
$$;

-- Items at or below their reorder level. Names only: staff never see stock quantities.
create or replace function public.low_stock() returns json
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles := _me();
begin
  perform _need(p, 'buyer', 'owner', 'admin');
  return coalesce((select json_agg(json_build_object('code', i.id, 'name', i.name, 'category', i.category,
      'unit', i.count_unit, 'purchaseUnit', i.purchase_unit, 'reorderLevel', i.reorder_level,
      'ordered', exists (select 1 from events e where e.type = 'PURCHASE' and e.data->'lines' @> jsonb_build_array(jsonb_build_object('code', i.id))
                         and not exists (select 1 from events g where g.type = 'GRN' and g.data->>'poId' = e.data->>'poId')))
      order by i.category, i.name)
    from items i join _store_balance() b on b.item_id = i.id
    where i.active and i.reorder_level is not null and b.qty <= i.reorder_level), '[]'::json);
end $$;

alter table public.sync_devices     enable row level security;
alter table public.aronium_products enable row level security;
alter table public.menu_aliases     enable row level security;
drop policy if exists sync_devices_read on public.sync_devices;
create policy sync_devices_read on public.sync_devices for select to authenticated using (is_reviewer());
drop policy if exists aronium_products_read on public.aronium_products;
create policy aronium_products_read on public.aronium_products for select to authenticated using (is_reviewer());
drop policy if exists menu_aliases_read on public.menu_aliases;
create policy menu_aliases_read on public.menu_aliases for select to authenticated using (is_reviewer());
revoke all on public.sync_devices, public.aronium_products, public.menu_aliases from anon, authenticated;
grant select on public.sync_devices, public.aronium_products, public.menu_aliases to authenticated;

-- Functions: signed-in users only; internal helpers not callable from the app (covers everything above).
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.proname like '\_%' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
  -- The Aronium endpoint calls in with the service key.
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._aronium_ingest(text, text, jsonb) to service_role';
  end if;
end $$;
