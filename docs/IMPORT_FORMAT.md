# Bulk import format (CSV / JSON)

Extension popup -> **Batch import (CSV / JSON)** (choose a file, or paste its contents if the file dialog closes the popup),
then **Start import**. Nothing is read from LinkedIn: the jobs come from your file, are processed automatically, and the run can
be paused, resumed or stopped. Files are validated in the popup (preview) and validated again in the extension's background
worker before anything is saved. Saving goes through the same merge-safe upsert as every other save.

> **Database requirement.** Imported jobs are stored with their own source (`file`), which needs migrations
> `20261022000200` and `20261023000100` (see [SUPABASE_SETUP.md](SUPABASE_SETUP.md)). Until they are applied the popup says so and
> **Start import refuses to run** (nothing is saved). Both are prepared in `supabase/migrations/` and NOT applied.

## Limits
| Limit | Value |
|---|---|
| File types | `.csv`, `.json` (anything else is rejected before reading) |
| File size | 2 MB |
| Records per run | the panel's **Maximum records** (default 200, hard limit 500) |
| Description | first 20,000 characters kept |
| Batches | saved 10 at a time; each page of the file (page size) is checkpointed |

## Fields
Column names (CSV header or JSON keys) are matched case-insensitively; spaces, `-` and `_` are ignored.

| Field | Required | Accepted names | Rules |
|---|---|---|---|
| Title | **yes** | `title`, `job title`, `position`, `role`, `name` | plain text, max 500 chars |
| URL | **yes** | `url`, `job url`, `link`, `job link`, `apply url`, `application url` | must be `https://`, no credentials, no spaces |
| Id | no | `id`, `external id`, `job id`, `reference`, `ref`, `requisition id` | letters, digits, `. _ : / -` (max 200). If missing/invalid, a stable id is derived from the URL |
| Company | no | `company`, `company name`, `employer`, `organization` | |
| Company URL | no | `company url`, `company website`, `website` | https only, otherwise dropped |
| Location | no | `location`, `city`, `job location` | |
| Description | no | `description`, `job description`, `details`, `summary` | HTML is converted to plain text (never rendered) |
| Posted date | no | `posted date`, `date posted`, `date`, `published`, `posted` | `YYYY-MM-DD` (other formats are ignored) |
| Salary | no | `salary`, `compensation`, `pay` | free text |
| Employment type | no | `employment type`, `job type`, `type`, `contract type` | Full-time, Part-time, Contract, Temporary, Internship, Volunteer, Apprenticeship (case/spacing tolerant) |
| Workplace | no | `workplace type`, `work mode`, `remote`, `work type` | Remote, Hybrid, On-site; `yes`/`true`/`1` in a "remote" column means Remote |
| Skills | no | `skills`, `skill`, `tags`, `keywords` | separated by `;` `,` or `|` (JSON: array allowed); stored lower-case |
| Experience | no | `experience`, `experience required`, `seniority`, `level` | free text |
| Status | no | `application status`, `status` | `open` or `closed`; anything else = unknown |

Unknown columns are ignored.

## Behaviour
- **Invalid rows** (no title, no URL, non-https URL, not an object) are listed with their row number and reason and are not
  imported; valid rows in the same file still are.
- **Duplicates inside the file** (same id, or same URL when there is no id) are collapsed to the first occurrence.
- **Repeated imports are idempotent:** a job is identified by `(provider "file", id)`. Importing the same file again updates
  the existing jobs and reports them as "already saved"; no duplicate rows are created.
- **Empty optional fields never erase saved values:** if a later import leaves e.g. `salary` empty, the saved salary is kept.
- **Counts shown:** rows in the file, valid, invalid, duplicate in file, over the limit, imported (new), already saved, failed.
- **Partial failures:** a network or session problem pauses the run with the error shown; unsaved records stay queued and
  Resume continues. Records the database rejects are counted as failed/skipped individually.
- Imported jobs appear in the saved-jobs table with Source = **Imported file**, and in exports.
- **Incomplete rows are saved as partial, never filled in:** a row without a description or without a company is stored
  (extraction status *partial*, warning `missing:description` / `missing:company`) and counted under **Partial**.
- **Controls:** Start import, Pause (the batch in progress finishes first), Resume (shown as **Retry** after a connection or
  save problem), Stop (the save in progress finishes; saved jobs are kept). Progress, the job being processed and the last
  error are shown, and survive closing the popup; after a browser restart the run shows as *interrupted* and Resume continues it.
- **Per-record results and Retry failed:** every record gets an outcome - *saved (new)*, *updated (already existed)*, *saved*
  (new or updated could not be told apart in that batch), *partial*, *skipped* or *failed* - with a reason where there is one.
  **Download results** saves them as a CSV. **Retry failed (N)** appears when a finished or stopped run has failed records and runs
  again with only those. The run's records are kept while there is something to retry, and released once nothing is left to retry
  (or when you press Clear result). Skipped records (nothing usable) are not retried.
- **Temporary failures** (network, rate limiting) are retried with exponential backoff (1 s, 2 s, 4 s, ...). Five failures in a
  row pause the run so you can look; Resume continues with the remaining records.

## Examples
CSV: [`docs/sample-jobs.csv`](sample-jobs.csv) (3 valid rows) and [`docs/sample-jobs-invalid.csv`](sample-jobs-invalid.csv)
(2 valid, 4 invalid, 1 duplicate).

JSON ([`docs/sample-jobs.json`](sample-jobs.json)) - either an array or `{ "jobs": [...] }`:
```json
[
  {
    "id": "EX-301",
    "title": "Frontend Engineer",
    "company": "Example Co",
    "url": "https://careers.example.com/jobs/301",
    "location": "Remote",
    "employmentType": "Full-time",
    "workplaceType": "Remote",
    "skills": ["javascript", "css"],
    "postedDate": "2026-10-12",
    "description": "<p>Build fast, accessible interfaces.</p>"
  }
]
```
