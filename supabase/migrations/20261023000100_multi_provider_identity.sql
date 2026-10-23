-- Generalises saved_jobs identity from "LinkedIn job id" to (provider, external_id) so jobs from other authorised
-- sources (company job boards, imported files) can be stored and de-duplicated alongside LinkedIn jobs.
--
-- BACKWARD COMPATIBLE:
--   * Existing rows and their ids are preserved; they are backfilled as provider = 'linkedin',
--     external_id = linkedin_job_id. Application-status fields and all other data are untouched.
--   * linkedin_job_id stays (nullable): it is set only for LinkedIn rows, so existing queries keep working.
--   * The old unique (user_id, linkedin_job_id) is kept; the new identity is unique (user_id, provider, external_id).
--   * upsert_saved_jobs still accepts the old payload shape (linkedin_job_id only => provider 'linkedin').
--   * RLS stays enabled with the same owner-only policies; grants are unchanged except for the new columns.
-- Nothing is dropped except two LinkedIn-only CHECK constraints, which are replaced by provider-aware ones below.

-- ---------------------------------------------------------------------------
-- 1. New identity columns (nullable first, backfill, then enforce)
-- ---------------------------------------------------------------------------
alter table public.saved_jobs
  add column provider    text not null default 'linkedin',
  add column external_id text;

-- The backfill is bookkeeping, not an edit: pause the updated_at trigger so existing rows keep their timestamps.
alter table public.saved_jobs disable trigger saved_jobs_set_updated_at;
update public.saved_jobs set external_id = linkedin_job_id where external_id is null;
alter table public.saved_jobs enable trigger saved_jobs_set_updated_at;

alter table public.saved_jobs alter column external_id set not null;
alter table public.saved_jobs alter column linkedin_job_id drop not null;

-- ---------------------------------------------------------------------------
-- 2. Constraints
-- ---------------------------------------------------------------------------
alter table public.saved_jobs
  add constraint saved_jobs_provider_format check (provider ~ '^[a-z][a-z0-9_-]{1,30}$'),
  add constraint saved_jobs_external_id_format check (external_id ~ '^[A-Za-z0-9._:/-]{1,200}$'),
  -- linkedin_job_id exists exactly for LinkedIn rows and mirrors external_id there.
  add constraint saved_jobs_linkedin_identity check (
    (provider = 'linkedin' and linkedin_job_id is not null and linkedin_job_id = external_id)
    or (provider <> 'linkedin' and linkedin_job_id is null)
  ),
  add constraint saved_jobs_provider_external_unique unique (user_id, provider, external_id);

-- The old checks assumed LinkedIn for every row. Replace them with provider-aware versions.
alter table public.saved_jobs drop constraint saved_jobs_job_id_format;
alter table public.saved_jobs drop constraint saved_jobs_job_url_format;
alter table public.saved_jobs drop constraint saved_jobs_company_url_format;

alter table public.saved_jobs
  add constraint saved_jobs_linkedin_job_id_format check (linkedin_job_id is null or linkedin_job_id ~ '^[0-9]{5,20}$'),
  -- LinkedIn rows keep the strict URL shape; other providers may use any https URL (no spaces/credentials/quotes).
  add constraint saved_jobs_job_url_format check (
    char_length(job_url) <= 2048 and (
      (provider = 'linkedin' and job_url ~ '^https://www\.linkedin\.com/jobs/view/[0-9]+/$')
      or (provider <> 'linkedin' and job_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^\s"<>@]*)?$')
    )
  ),
  add constraint saved_jobs_company_url_format check (
    company_url is null or char_length(company_url) <= 2048 and (
      (provider = 'linkedin' and company_url ~ '^https://www\.linkedin\.com/company/[^/]+/$')
      or (provider <> 'linkedin' and company_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^\s"<>@]*)?$')
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Grants and indexes for the new columns
-- ---------------------------------------------------------------------------
-- INSERT is a table-level grant (covers the new columns). Identity columns stay non-updatable: provider and
-- external_id are deliberately NOT added to the column-level UPDATE grant.
create index saved_jobs_user_provider_idx on public.saved_jobs (user_id, provider);

-- ---------------------------------------------------------------------------
-- 4. upsert_saved_jobs: same behaviour, new conflict target
--    * payload may carry provider + external_id; old payloads (linkedin_job_id only) still work
--    * every other column keeps the merge-safe rules from migrations 000200, 20261022000100 and 20261022000200
--      (this migration requires 20261022000200 to be applied first; it sorts after it)
-- ---------------------------------------------------------------------------
create or replace function public.upsert_saved_jobs(p_jobs jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_inserted integer := 0;
  v_duplicates integer := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_jobs is null or jsonb_typeof(p_jobs) <> 'array' then
    raise exception 'p_jobs must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_jobs) > 200 then
    raise exception 'too many jobs in one call (max 200)' using errcode = '22023';
  end if;

  with incoming as (
    select
      j.*,
      coalesce(nullif(btrim(j.provider), ''), 'linkedin') as prov,
      coalesce(nullif(btrim(j.external_id), ''), nullif(btrim(j.linkedin_job_id), '')) as ext
    from jsonb_to_recordset(p_jobs) as j(
      linkedin_job_id text, provider text, external_id text, job_url text, job_title text, company_name text,
      company_url text, location text, posted_text text, posted_date_approx text, applicants_text text,
      workplace_type text, employment_type text, description text, skills jsonb, responsibilities jsonb,
      qualifications jsonb, other_pills jsonb, experience_required text, salary text, source text,
      has_full_detail boolean, scraped_at timestamptz, application_status text, application_status_text text,
      country text, seniority_level text, salary_currency text, salary_period text, application_method text,
      hiring_insight text, preferred_qualifications jsonb, education_requirements jsonb, certifications jsonb,
      extraction_status text, extraction_warnings jsonb, application_url text, benefits jsonb,
      industry text, company_size text
    )
  ),
  deduped as (
    -- If the same job appears twice in one batch, keep the detail version (ON CONFLICT cannot hit a row twice).
    select distinct on (i.prov, i.ext) i.*
    from incoming i
    order by i.prov, i.ext, (i.source = 'detail') desc nulls last
  ),
  cleaned as (
    select
      d.prov as provider,
      d.ext as external_id,
      case when d.prov = 'linkedin' then d.ext end as linkedin_job_id,
      d.job_url,
      nullif(btrim(d.job_title), '') as job_title,
      nullif(btrim(d.company_name), '') as company_name,
      nullif(btrim(d.company_url), '') as company_url,
      nullif(btrim(d.location), '') as location,
      nullif(btrim(d.posted_text), '') as posted_text,
      nullif(btrim(d.posted_date_approx), '')::date as posted_date_approx,
      nullif(btrim(d.applicants_text), '') as applicants_text,
      nullif(btrim(d.workplace_type), '') as workplace_type,
      nullif(btrim(d.employment_type), '') as employment_type,
      nullif(btrim(d.description), '') as description,
      coalesce((select array_agg(distinct lower(btrim(e))) from jsonb_array_elements_text(coalesce(d.skills, '[]'::jsonb)) as e
                where btrim(e) <> ''), '{}'::text[]) as skills,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(d.responsibilities, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as responsibilities,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(d.qualifications, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as qualifications,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(d.other_pills, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as other_pills,
      nullif(btrim(d.experience_required), '') as experience_required,
      nullif(btrim(d.salary), '') as salary,
      coalesce(nullif(d.source, ''), 'detail') as source,
      coalesce(d.has_full_detail, false) as has_full_detail,
      coalesce(d.scraped_at, now()) as scraped_at,
      nullif(btrim(d.application_status), '') as application_status,
      nullif(btrim(d.application_status_text), '') as application_status_text,
      nullif(btrim(d.country), '') as country,
      nullif(btrim(d.seniority_level), '') as seniority_level,
      nullif(btrim(d.salary_currency), '') as salary_currency,
      nullif(btrim(d.salary_period), '') as salary_period,
      nullif(btrim(d.application_method), '') as application_method,
      nullif(btrim(d.hiring_insight), '') as hiring_insight,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(d.preferred_qualifications, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as preferred_qualifications,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(d.education_requirements, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as education_requirements,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(d.certifications, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as certifications,
      nullif(btrim(d.extraction_status), '') as extraction_status,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(d.extraction_warnings, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as extraction_warnings,
      nullif(btrim(d.application_url), '') as application_url,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(d.benefits, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as benefits,
      nullif(btrim(d.industry), '') as industry,
      nullif(btrim(d.company_size), '') as company_size
    from deduped d
  ),
  upserted as (
    insert into public.saved_jobs as s (
      user_id, provider, external_id, linkedin_job_id, job_url, job_title, company_name, company_url, location,
      posted_text, posted_date_approx, applicants_text, workplace_type, employment_type, description, skills,
      responsibilities, qualifications, other_pills, experience_required, salary, source, has_full_detail, scraped_at,
      application_status, application_status_text, application_status_at,
      country, seniority_level, salary_currency, salary_period, application_method, hiring_insight,
      preferred_qualifications, education_requirements, certifications, extraction_status, extraction_warnings,
      application_url, benefits, industry, company_size
    )
    select
      v_uid, c.provider, c.external_id, c.linkedin_job_id, c.job_url, c.job_title, c.company_name, c.company_url, c.location,
      c.posted_text, c.posted_date_approx, c.applicants_text, c.workplace_type, c.employment_type, c.description, c.skills,
      c.responsibilities, c.qualifications, c.other_pills, c.experience_required, c.salary, c.source, c.has_full_detail,
      c.scraped_at, c.application_status, c.application_status_text,
      case when c.application_status is not null then c.scraped_at end,
      c.country, c.seniority_level, c.salary_currency, c.salary_period, c.application_method, c.hiring_insight,
      c.preferred_qualifications, c.education_requirements, c.certifications, c.extraction_status,
      case when c.extraction_status = 'complete' then '{}'::text[] else c.extraction_warnings end,
      c.application_url, c.benefits, c.industry, c.company_size
    from cleaned c
    on conflict (user_id, provider, external_id) do update set
      job_url             = excluded.job_url,
      job_title           = coalesce(excluded.job_title, s.job_title),
      company_name        = coalesce(excluded.company_name, s.company_name),
      company_url         = coalesce(excluded.company_url, s.company_url),
      location            = coalesce(excluded.location, s.location),
      posted_text         = coalesce(excluded.posted_text, s.posted_text),
      posted_date_approx  = coalesce(excluded.posted_date_approx, s.posted_date_approx),
      applicants_text     = coalesce(excluded.applicants_text, s.applicants_text),
      workplace_type      = coalesce(excluded.workplace_type, s.workplace_type),
      employment_type     = coalesce(excluded.employment_type, s.employment_type),
      description         = coalesce(excluded.description, s.description),
      skills              = case when cardinality(excluded.skills) > 0 then excluded.skills else s.skills end,
      responsibilities    = case when cardinality(excluded.responsibilities) > 0 then excluded.responsibilities else s.responsibilities end,
      qualifications      = case when cardinality(excluded.qualifications) > 0 then excluded.qualifications else s.qualifications end,
      other_pills         = case when cardinality(excluded.other_pills) > 0 then excluded.other_pills else s.other_pills end,
      experience_required = coalesce(excluded.experience_required, s.experience_required),
      salary              = coalesce(excluded.salary, s.salary),
      source              = case when s.source = 'detail' or excluded.source = 'detail' then 'detail' else 'card' end,
      has_full_detail     = s.has_full_detail or excluded.has_full_detail,
      scraped_at          = greatest(excluded.scraped_at, s.scraped_at),
      application_status      = coalesce(excluded.application_status, s.application_status),
      application_status_text = case when excluded.application_status is not null then excluded.application_status_text else s.application_status_text end,
      application_status_at   = case when excluded.application_status is not null then excluded.scraped_at else s.application_status_at end,
      country                  = coalesce(excluded.country, s.country),
      seniority_level          = coalesce(excluded.seniority_level, s.seniority_level),
      salary_currency          = coalesce(excluded.salary_currency, s.salary_currency),
      salary_period            = coalesce(excluded.salary_period, s.salary_period),
      application_method       = coalesce(excluded.application_method, s.application_method),
      hiring_insight           = coalesce(excluded.hiring_insight, s.hiring_insight),
      preferred_qualifications = case when cardinality(excluded.preferred_qualifications) > 0 then excluded.preferred_qualifications else s.preferred_qualifications end,
      education_requirements   = case when cardinality(excluded.education_requirements) > 0 then excluded.education_requirements else s.education_requirements end,
      certifications           = case when cardinality(excluded.certifications) > 0 then excluded.certifications else s.certifications end,
      extraction_status        = case when s.extraction_status = 'complete' or excluded.extraction_status = 'complete' then 'complete'
                                      else coalesce(excluded.extraction_status, s.extraction_status) end,
      extraction_warnings      = case
                                   when s.extraction_status = 'complete' or excluded.extraction_status = 'complete' then '{}'::text[]
                                   when excluded.source = 'detail' or s.source <> 'detail' then excluded.extraction_warnings
                                   else s.extraction_warnings end,
      application_url          = coalesce(excluded.application_url, s.application_url),
      benefits                 = case when cardinality(excluded.benefits) > 0 then excluded.benefits else s.benefits end,
      industry                 = coalesce(excluded.industry, s.industry),
      company_size             = coalesce(excluded.company_size, s.company_size)
    returning (xmax = 0) as was_inserted
  )
  select
    count(*) filter (where was_inserted),
    count(*) filter (where not was_inserted)
  into v_inserted, v_duplicates
  from upserted;

  return jsonb_build_object('inserted', v_inserted, 'duplicates', v_duplicates);
end;
$$;

-- CREATE OR REPLACE keeps existing grants; restated so this file is self-explanatory and idempotent.
revoke all on function public.upsert_saved_jobs(jsonb) from public, anon;
grant execute on function public.upsert_saved_jobs(jsonb) to authenticated;
