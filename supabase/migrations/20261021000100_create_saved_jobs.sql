-- LinkedIn Job Saver: saved_jobs table, indexes, row level security.
-- Ownership model: private per user. A row is visible/writable only to the authenticated user in user_id.
-- Review before applying; nothing here runs automatically against a remote project.

create extension if not exists pg_trgm with schema extensions;

create table public.saved_jobs (
  id                  uuid primary key default gen_random_uuid(),
  -- Default lets inserts omit it; RLS WITH CHECK still forces it to equal auth.uid().
  user_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,

  -- Identity / dedup key (unique per user, see constraint below)
  linkedin_job_id     text not null,
  job_url             text not null,

  -- Header fields (NULL when the extractor found nothing; never the empty string)
  job_title           text,
  company_name        text,
  company_url         text,
  location            text,
  posted_text         text,
  posted_date_approx  date,
  applicants_text     text,
  workplace_type      text,
  employment_type     text,

  -- Description-derived fields
  description         text,
  skills              text[] not null default '{}',
  responsibilities    text[] not null default '{}',
  qualifications      text[] not null default '{}',
  other_pills         text[] not null default '{}',
  experience_required text,
  salary              text,

  -- Provenance
  source              text not null default 'detail',   -- 'card' (list entry only) or 'detail' (full page/panel)
  has_full_detail     boolean not null default false,   -- true once a description has been captured
  scraped_at          timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Full-text search over title (A), company (B), description (C)
  search_tsv tsvector generated always as (
    setweight(to_tsvector('english', coalesce(job_title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(company_name, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) stored,

  constraint saved_jobs_user_job_unique unique (user_id, linkedin_job_id),
  constraint saved_jobs_job_id_format check (linkedin_job_id ~ '^[0-9]{5,20}$'),
  constraint saved_jobs_job_url_format check (job_url ~ '^https://www\.linkedin\.com/jobs/view/[0-9]+/$'),
  constraint saved_jobs_company_url_format
    check (company_url is null or company_url ~ '^https://www\.linkedin\.com/company/[^/]+/$'),
  constraint saved_jobs_workplace_type_valid
    check (workplace_type is null or workplace_type in ('Remote', 'Hybrid', 'On-site')),
  constraint saved_jobs_employment_type_valid
    check (employment_type is null or employment_type in
      ('Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Volunteer', 'Apprenticeship')),
  constraint saved_jobs_source_valid check (source in ('card', 'detail')),
  -- Size caps keep a single bad payload from bloating the table.
  constraint saved_jobs_text_limits check (
    char_length(coalesce(job_title, '')) <= 500 and
    char_length(coalesce(company_name, '')) <= 500 and
    char_length(coalesce(location, '')) <= 500 and
    char_length(coalesce(description, '')) <= 100000
  ),
  constraint saved_jobs_array_limits check (
    cardinality(skills) <= 100 and cardinality(responsibilities) <= 100 and
    cardinality(qualifications) <= 100 and cardinality(other_pills) <= 50
  )
);

comment on table public.saved_jobs is 'Jobs a user chose to save from LinkedIn. Private per user via RLS.';

-- Indexes (the unique constraint already indexes (user_id, linkedin_job_id)).
create index saved_jobs_user_created_idx on public.saved_jobs (user_id, created_at desc);
create index saved_jobs_search_tsv_idx on public.saved_jobs using gin (search_tsv);
create index saved_jobs_company_trgm_idx on public.saved_jobs using gin (company_name extensions.gin_trgm_ops);
create index saved_jobs_location_trgm_idx on public.saved_jobs using gin (location extensions.gin_trgm_ops);
create index saved_jobs_skills_idx on public.saved_jobs using gin (skills);

-- updated_at maintenance
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger saved_jobs_set_updated_at
  before update on public.saved_jobs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Security: deny by default, then grant deliberately.
-- Supabase's default privileges grant new public tables to anon/authenticated; revoke them explicitly.
-- ---------------------------------------------------------------------------
alter table public.saved_jobs enable row level security;

revoke all on public.saved_jobs from public, anon, authenticated;
grant select, insert, delete on public.saved_jobs to authenticated;
-- Column-level UPDATE: identity columns (id, user_id, linkedin_job_id, created_at) can never be changed.
grant update (
  job_url, job_title, company_name, company_url, location, posted_text, posted_date_approx, applicants_text,
  workplace_type, employment_type, description, skills, responsibilities, qualifications, other_pills,
  experience_required, salary, source, has_full_detail, scraped_at
) on public.saved_jobs to authenticated;

create policy saved_jobs_select_own on public.saved_jobs
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy saved_jobs_insert_own on public.saved_jobs
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy saved_jobs_update_own on public.saved_jobs
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy saved_jobs_delete_own on public.saved_jobs
  for delete to authenticated
  using ((select auth.uid()) = user_id);
