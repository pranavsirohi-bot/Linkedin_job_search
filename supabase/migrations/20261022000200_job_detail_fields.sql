-- More job detail per saved job, plus extraction quality tracking.
-- NOT APPLIED automatically. Review, then apply only with the owner's explicit approval.
--
-- BACKWARD COMPATIBLE: only ADDS nullable / defaulted columns and REPLACES upsert_saved_jobs (same signature, same
-- grants). Nothing is dropped, no existing row is rewritten, NOT NULL / RLS / grants on existing columns are unchanged.
-- Until this is applied the extension keeps working: the current RPC ignores the new keys, and list queries fall back
-- to the columns that exist.
--
-- Why each column is needed (none of them can be represented by the existing schema):
--   country                  country named in the location text ("Pune, Maharashtra, India" -> India)
--   seniority_level          seniority shown as a job pill ("Mid-Senior level"); never guessed from the title
--   salary_currency          ISO 4217 code, only when the salary text names it unambiguously (INR, EUR, GBP, USD...)
--   salary_period            hour | day | week | month | year, only when the salary text says so
--   application_method       easy_apply | external, from the Apply button LinkedIn shows
--   hiring_insight           the insight line under the job header ("Responses managed off LinkedIn")
--   preferred_qualifications description lines under a "Preferred / Nice to have" heading
--   education_requirements   description lines that state a degree / education requirement
--   certifications           description lines that state a certification
--   extraction_status        complete | partial (a card-only record is always partial)
--   extraction_warnings      what was missing or could not be read when the job was last extracted
--   application_url          the employer's application page, from the external Apply link's href (never a LinkedIn URL)
--   benefits                 LinkedIn's "Benefits found in job post" list
--   industry, company_size   from the "About the company" section ("Business Consulting and Services", "1001-5000 employees")

alter table public.saved_jobs
  add column country                  text,
  add column seniority_level          text,
  add column salary_currency          text,
  add column salary_period            text,
  add column application_method       text,
  add column hiring_insight           text,
  add column preferred_qualifications text[] not null default '{}',
  add column education_requirements   text[] not null default '{}',
  add column certifications           text[] not null default '{}',
  add column extraction_status        text,
  add column extraction_warnings      text[] not null default '{}',
  add column application_url          text,
  add column benefits                 text[] not null default '{}',
  add column industry                 text,
  add column company_size             text;

alter table public.saved_jobs
  add constraint saved_jobs_seniority_level_valid check (seniority_level is null or seniority_level in
    ('Internship', 'Entry level', 'Associate', 'Mid-Senior level', 'Director', 'Executive')),
  add constraint saved_jobs_salary_currency_format check (salary_currency is null or salary_currency ~ '^[A-Z]{3}$'),
  add constraint saved_jobs_salary_period_valid check (salary_period is null or salary_period in ('hour', 'day', 'week', 'month', 'year')),
  add constraint saved_jobs_application_method_valid check (application_method is null or application_method in ('easy_apply', 'external')),
  add constraint saved_jobs_extraction_status_valid check (extraction_status is null or extraction_status in ('complete', 'partial')),
  add constraint saved_jobs_detail_text_limits check (
    char_length(coalesce(country, '')) <= 100 and
    char_length(coalesce(hiring_insight, '')) <= 500 and
    char_length(coalesce(industry, '')) <= 200 and
    char_length(coalesce(company_size, '')) <= 100
  ),
  add constraint saved_jobs_detail_array_limits check (
    cardinality(preferred_qualifications) <= 100 and cardinality(education_requirements) <= 20 and
    cardinality(certifications) <= 20 and cardinality(extraction_warnings) <= 50 and cardinality(benefits) <= 30
  ),
  -- https only, no spaces/quotes/credentials, never a LinkedIn URL (a link to the job itself is job_url).
  add constraint saved_jobs_application_url_format check (
    application_url is null or (
      char_length(application_url) <= 2048
      and application_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^\s"<>]*)?$'
      and application_url !~ '^https://([^/]*\.)?linkedin\.com(/|:|$)'
    )
  );

-- Owners may update the new columns (identity columns stay locked, as before).
grant update (
  country, seniority_level, salary_currency, salary_period, application_method, hiring_insight,
  preferred_qualifications, education_requirements, certifications, extraction_status, extraction_warnings,
  application_url, benefits, industry, company_size
) on public.saved_jobs to authenticated;

-- ---------------------------------------------------------------------------
-- upsert_saved_jobs: every existing column merges exactly as in 20261022000100. New columns:
--   * text values: a non-empty new value wins, an empty one never erases (COALESCE)
--   * arrays: replaced only by a non-empty array
--   * extraction_status: 'complete' is sticky (a later card-only or weaker read cannot downgrade it)
--   * extraction_warnings: follow the latest DETAIL extraction; a card-only save never replaces a detail's
--     warnings; cleared when the merged record is complete
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
    select distinct on (j.linkedin_job_id) j.*
    from jsonb_to_recordset(p_jobs) as j(
      linkedin_job_id text, job_url text, job_title text, company_name text, company_url text, location text,
      posted_text text, posted_date_approx text, applicants_text text, workplace_type text, employment_type text,
      description text, skills jsonb, responsibilities jsonb, qualifications jsonb, other_pills jsonb,
      experience_required text, salary text, source text, has_full_detail boolean, scraped_at timestamptz,
      application_status text, application_status_text text,
      country text, seniority_level text, salary_currency text, salary_period text, application_method text,
      hiring_insight text, preferred_qualifications jsonb, education_requirements jsonb, certifications jsonb,
      extraction_status text, extraction_warnings jsonb, application_url text, benefits jsonb,
      industry text, company_size text
    )
    order by j.linkedin_job_id, (j.source = 'detail') desc nulls last
  ),
  cleaned as (
    select
      i.linkedin_job_id,
      i.job_url,
      nullif(btrim(i.job_title), '') as job_title,
      nullif(btrim(i.company_name), '') as company_name,
      nullif(btrim(i.company_url), '') as company_url,
      nullif(btrim(i.location), '') as location,
      nullif(btrim(i.posted_text), '') as posted_text,
      nullif(btrim(i.posted_date_approx), '')::date as posted_date_approx,
      nullif(btrim(i.applicants_text), '') as applicants_text,
      nullif(btrim(i.workplace_type), '') as workplace_type,
      nullif(btrim(i.employment_type), '') as employment_type,
      nullif(btrim(i.description), '') as description,
      coalesce((select array_agg(distinct lower(btrim(e))) from jsonb_array_elements_text(coalesce(i.skills, '[]'::jsonb)) as e
                where btrim(e) <> ''), '{}'::text[]) as skills,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(i.responsibilities, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as responsibilities,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(i.qualifications, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as qualifications,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(i.other_pills, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as other_pills,
      nullif(btrim(i.experience_required), '') as experience_required,
      nullif(btrim(i.salary), '') as salary,
      coalesce(nullif(i.source, ''), 'detail') as source,
      coalesce(i.has_full_detail, false) as has_full_detail,
      coalesce(i.scraped_at, now()) as scraped_at,
      nullif(btrim(i.application_status), '') as application_status,
      nullif(btrim(i.application_status_text), '') as application_status_text,
      nullif(btrim(i.country), '') as country,
      nullif(btrim(i.seniority_level), '') as seniority_level,
      nullif(btrim(i.salary_currency), '') as salary_currency,
      nullif(btrim(i.salary_period), '') as salary_period,
      nullif(btrim(i.application_method), '') as application_method,
      nullif(btrim(i.hiring_insight), '') as hiring_insight,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(i.preferred_qualifications, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as preferred_qualifications,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(i.education_requirements, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as education_requirements,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(i.certifications, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as certifications,
      nullif(btrim(i.extraction_status), '') as extraction_status,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(i.extraction_warnings, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as extraction_warnings,
      nullif(btrim(i.application_url), '') as application_url,
      coalesce((select array_agg(btrim(e) order by o) from jsonb_array_elements_text(coalesce(i.benefits, '[]'::jsonb))
                with ordinality as t(e, o) where btrim(e) <> ''), '{}'::text[]) as benefits,
      nullif(btrim(i.industry), '') as industry,
      nullif(btrim(i.company_size), '') as company_size
    from incoming i
  ),
  upserted as (
    insert into public.saved_jobs as s (
      user_id, linkedin_job_id, job_url, job_title, company_name, company_url, location, posted_text,
      posted_date_approx, applicants_text, workplace_type, employment_type, description, skills,
      responsibilities, qualifications, other_pills, experience_required, salary, source, has_full_detail, scraped_at,
      application_status, application_status_text, application_status_at,
      country, seniority_level, salary_currency, salary_period, application_method, hiring_insight,
      preferred_qualifications, education_requirements, certifications, extraction_status, extraction_warnings,
      application_url, benefits, industry, company_size
    )
    select
      v_uid, c.linkedin_job_id, c.job_url, c.job_title, c.company_name, c.company_url, c.location, c.posted_text,
      c.posted_date_approx, c.applicants_text, c.workplace_type, c.employment_type, c.description, c.skills,
      c.responsibilities, c.qualifications, c.other_pills, c.experience_required, c.salary, c.source,
      c.has_full_detail, c.scraped_at,
      c.application_status, c.application_status_text,
      case when c.application_status is not null then c.scraped_at end,
      c.country, c.seniority_level, c.salary_currency, c.salary_period, c.application_method, c.hiring_insight,
      c.preferred_qualifications, c.education_requirements, c.certifications, c.extraction_status,
      case when c.extraction_status = 'complete' then '{}'::text[] else c.extraction_warnings end,
      c.application_url, c.benefits, c.industry, c.company_size
    from cleaned c
    on conflict (user_id, linkedin_job_id) do update set
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

-- CREATE OR REPLACE keeps the existing grants; restated so this file is self-explanatory and idempotent.
revoke all on function public.upsert_saved_jobs(jsonb) from public, anon;
grant execute on function public.upsert_saved_jobs(jsonb) to authenticated;
