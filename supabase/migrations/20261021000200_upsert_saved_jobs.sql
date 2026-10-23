-- Safe batch upsert for saved_jobs.
--
-- Why an RPC instead of PostgREST's upsert: a plain upsert overwrites every column it is given, and in a batch
-- keys missing from one row can become NULL. That would erase a saved description when a card-only extraction
-- (no description) is saved later. Here every column is merged with COALESCE(new, existing).
--
-- SECURITY INVOKER: runs with the caller's privileges, so RLS applies. user_id comes from auth.uid(),
-- never from the client payload.

create function public.upsert_saved_jobs(p_jobs jsonb)
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
    -- If the same job appears twice in one batch, keep the detail version (ON CONFLICT cannot hit a row twice).
    select distinct on (j.linkedin_job_id) j.*
    from jsonb_to_recordset(p_jobs) as j(
      linkedin_job_id text, job_url text, job_title text, company_name text, company_url text, location text,
      posted_text text, posted_date_approx text, applicants_text text, workplace_type text, employment_type text,
      description text, skills jsonb, responsibilities jsonb, qualifications jsonb, other_pills jsonb,
      experience_required text, salary text, source text, has_full_detail boolean, scraped_at timestamptz
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
      coalesce(i.scraped_at, now()) as scraped_at
    from incoming i
  ),
  upserted as (
    insert into public.saved_jobs as s (
      user_id, linkedin_job_id, job_url, job_title, company_name, company_url, location, posted_text,
      posted_date_approx, applicants_text, workplace_type, employment_type, description, skills,
      responsibilities, qualifications, other_pills, experience_required, salary, source, has_full_detail, scraped_at
    )
    select
      v_uid, c.linkedin_job_id, c.job_url, c.job_title, c.company_name, c.company_url, c.location, c.posted_text,
      c.posted_date_approx, c.applicants_text, c.workplace_type, c.employment_type, c.description, c.skills,
      c.responsibilities, c.qualifications, c.other_pills, c.experience_required, c.salary, c.source,
      c.has_full_detail, c.scraped_at
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
      scraped_at          = greatest(excluded.scraped_at, s.scraped_at)
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

revoke all on function public.upsert_saved_jobs(jsonb) from public, anon;
grant execute on function public.upsert_saved_jobs(jsonb) to authenticated;
