# Supabase setup for LinkedIn Job Saver

The extension uses **anonymous Supabase authentication**: there is no email, password or account form.
On first use the service worker creates one anonymous user, stores its session in `chrome.storage.local`, and reuses it.
Saved jobs are **private per anonymous user** (Row Level Security).

> ## Important limitation: anonymous profiles cannot be recovered
> The stored session is the *only* credential. If the extension's data is cleared (Chrome "Clear browsing data" for
> extensions, removing/reinstalling the extension, a new Chrome profile or computer), the same user can never be
> reached again, and its saved jobs become inaccessible (they remain in the database under an orphaned user id).
> The popup states this. If you need recoverable or multi-device data, add real accounts instead (not implemented).

## 1. Project (already done for this repo)
Project URL and publishable key live in `src/shared/supabase-config.js`. Only the publishable key may be used;
the extension refuses `sb_secret_` / `service_role` keys.

## 2. Database migrations
`supabase/migrations/`:

| File | Status | Purpose |
|---|---|---|
| `20261021000100_create_saved_jobs.sql` | applied | `saved_jobs` table, RLS, owner-only policies |
| `20261021000200_upsert_saved_jobs.sql` | applied | merge-safe `upsert_saved_jobs` function |
| `20261022000100_add_application_status.sql` | applied | adds `application_status` (open/closed/NULL), `application_status_text`, `application_status_at`; replaces `upsert_saved_jobs` so a known status is never erased by an unknown one |
| `20261022000200_job_detail_fields.sql` | **prepared - NOT applied (needs your approval)** | adds `country`, `seniority_level`, `salary_currency`, `salary_period`, `application_method`, `hiring_insight`, `preferred_qualifications`, `education_requirements`, `certifications`, `extraction_status`, `extraction_warnings`, `application_url`, `benefits`, `industry`, `company_size`; replaces `upsert_saved_jobs` with the same merge rules extended to them. Additive only. See `docs/FIELDS.md`. |
| `20261023000100_multi_provider_identity.sql` | **not applied - not needed** | optional, only for non-LinkedIn sources (the dormant batch engine). Its RPC was updated (file never applied) to keep the detail fields above; it requires `20261022000200` first. Do not apply it unless you decide to add another job source. |

Extension 0.9.2 works on the three applied migrations: the extra detail fields are extracted and shown in Preview, but
only stored after `20261022000200` is applied (reads fall back automatically; nothing fails). Applied migration files are
never edited; changes ship as new files.

**Applying `20261022000200` (only after you approve it).** Do NOT use `npx supabase db push`: it would also apply the
optional fourth file. Apply just this file, then record it:
```
npx supabase db query --linked -f supabase/migrations/20261022000200_job_detail_fields.sql
npx supabase migration repair --status applied 20261022000200
npx supabase migration list        # 000100, 000200, 20261022000100, 20261022000200 show a Remote entry
```
Then verify (read-only):
```
npx supabase db query --linked "select count(*) from public.saved_jobs"     # same number as before (143 on 2026-10-22)
npx supabase db query --linked "select column_name from information_schema.columns where table_schema='public' and table_name='saved_jobs' and column_name in ('country','application_method','extraction_status','extraction_warnings') order by 1"   # 4 rows
npx supabase db query --linked "select count(*) filter (where description is not null) as with_description, count(*) filter (where source='card') as card_only from public.saved_jobs"   # unchanged
```
Then reload the extension (its worker remembers the old schema until reloaded); Preview extraction stops listing fields
as "Not stored until the database update". Rows saved earlier keep their values; their new columns stay empty until the
job is saved again.
**No migration changes were needed for anonymous sign-in.** Anonymous users use the same Postgres role as signed-in users
(`authenticated`) and carry a real `auth.uid()`, so the existing owner-only policies (`user_id = auth.uid()`) isolate them.
`anon`/`public` have no table or function access.

## 3. Dashboard settings required for anonymous sign-in
1. **Authentication -> Sign In / Providers -> "Allow anonymous sign-ins": turn ON.** Without it the popup shows:
   *"Anonymous sign-ins are turned off for this Supabase project..."*
2. **Do NOT enable CAPTCHA protection** (Authentication -> Attack Protection). The extension cannot solve a CAPTCHA,
   so sign-in would fail with *"This Supabase project requires CAPTCHA..."*.
3. **Authentication -> Rate Limits**: keep the limit for anonymous sign-ins (default 30 per hour per IP) or lower it.
   This is your main brake on abuse. Anyone who has the extension (and therefore the URL and publishable key) can create
   anonymous users, so keep the extension private or monitor Authentication -> Users.
4. The **Email** provider is no longer used by the extension. You may disable it (stops email sign-ups through the API).
5. Housekeeping: anonymous users accumulate (every cleared profile leaves one behind). Periodically delete stale ones
   (Authentication -> Users); deleting a user cascades to their saved jobs.

## 4. Build and load
```
npm install
npm run build          # bundles the service worker into dist/service-worker.js
```
`chrome://extensions` -> Developer mode -> **Load unpacked** (or Reload) -> select the project folder.
Rebuild after changing anything under `src/db`, `src/background` or `src/shared`.

## 5. Live verification checklist (NOT yet run by the author)
1. Popup opens, briefly shows "Setting up your private profile...", then **Private profile on this browser (xxxxxxxx...)**,
   `Saved jobs: 0`, and the "cannot be recovered" note. No email/password fields anywhere.
2. Authentication -> Users shows **one** new anonymous user. Close and reopen the popup several times: still **one** user
   and the same short id (the session is reused).
3. Open a job (`/jobs/view/<id>/`), wait for it to load, **Save job** -> "1 new job saved." Count = 1.
4. **Save job** again -> "1 duplicate (already saved, updated)." Count stays 1.
5. Search-results page -> **Save all loaded jobs** -> new + duplicate counts add up to the cards shown.
6. Table Editor -> `saved_jobs`: rows carry that anonymous user's `user_id`.
7. Reload the extension (chrome://extensions) -> popup shows the **same** short id (service-worker restart, session persisted).
8. Turn Wi-Fi off, open the popup with a session already stored -> it still opens (no new user is created offline).
   Save -> clear "can't reach the server" error and the extracted data stays visible.
9. Cross-profile isolation: use a second Chrome profile (or clear the extension's storage via the extension's
   service-worker DevTools: `chrome.storage.local.clear()`) -> a new user id with `Saved jobs: 0`; the earlier jobs are no
   longer visible there (and are unreachable from the cleared profile, as documented above).

## 6. Application status, saved-jobs table and export (version 0.4.0)
- **Status** is read from the job panel: **closed** when LinkedIn shows the "No longer accepting applications" notice,
  **open** when the Apply / Easy Apply button is present, otherwise **unknown** (empty, never guessed).
  The popup's Preview extraction shows `applicationStatus` before anything is saved; Save job mentions it.
- **Saved jobs table**: popup -> **Open saved jobs table** opens `src/library/library.html` in a tab. Keyword search,
  company / location / skills / workplace / employment filters, **Applications: Open / Closed / Unknown**, paging (25 per page),
  Details (full description, notice text), and Delete (explicit confirmation).
- **Export**: choose Excel (.xlsx) or CSV, then **Export filtered results** (the filters you last searched) or
  **Export all saved jobs**. Columns include *Application status*, *Application notice* and *Status checked at*.
  Export only reads; it never deletes or edits saved jobs. CSV cells starting with `= + - @` are prefixed with `'`
  so spreadsheets cannot run them as formulas; XLSX cells are stored as text.
- Live checklist for these features (NOT yet run by the author):
  1. After applying migration 3: Table Editor -> `saved_jobs` shows the three `application_status*` columns.
  2. Open a **closed** job, Preview extraction -> `applicationStatus: "closed"`; Save job -> "... no longer accepting applications."
  3. Open an **open** job, Preview -> `"open"`; Save job. Re-save the closed job later -> status stays closed.
  4. Saved jobs table: both jobs listed with Closed / Open badges; the Applications filter works; the title links to LinkedIn.
  5. Export all as CSV and as Excel: open them; the *Application status* column reads Open / Closed / Unknown and Description is complete.
  6. Export filtered with Applications = Closed: only closed jobs are in the file.
  7. Delete one job from the table (Confirm delete): it disappears and the popup count drops by one.

## 7. Auto-save and download (version 0.9.2)
Everything happens in the extension popup:

| Control | What it does |
|---|---|
| **Start** | Turns on **auto-save for the LinkedIn tab you are on**. Then click each job in the LinkedIn list yourself: LinkedIn shows the full details of one job at a time (right-hand panel), and each job you open is saved **with its full details** about two seconds after they appear (still-loading panels are read again a few times). By default list cards are **not** saved, so no new "Card only" rows are created. |
| **Also save list cards** | Optional (remembered): also save every visible card (title, company, location only, marked "Card only"). Opening such a job later upgrades the same row to full details. |
| **Badges on LinkedIn cards** | While auto-save runs each listed job shows *Next to save*, *Full details saved*, *Partial* or *Failed* (visual only, never clickable; removed on Stop). A job is marked saved only after Supabase confirmed it; jobs saved with full details in earlier sessions are recognised (read-only lookup by job ID). |
| **Current job** | The popup shows the open job's title and company and its state: Waiting for job, Extracting, Saving, Full details saved, Partial or Failed. The content script detects when the opened job's details have rendered (checked every 150 ms, at most 8 s) instead of waiting a fixed time. |
| **Checklist** | While auto-save runs the popup shows the open job's state (saving / saved with full details / still loading / could not be read), "This page: X of N jobs saved with full details" and **Next to open: <title> - <company>**. You click that job in LinkedIn; the extension never clicks it for you. |
| **Stop** | Ends auto-save. A save already in flight finishes (its jobs are kept), no further batch starts, and nothing more is read. Saved jobs are never deleted. |
| **Save open job only** | Saves just the open job with its full details. |
| **Download CSV** | Downloads **every job you have saved** as one CSV file with all saved fields. It only reads; nothing is changed. |
| **Open saved jobs table** | Search, filter, review, delete, and export CSV or Excel. |

**Counters:** Pages, Discovered (unique jobs seen), Processed, Saved (new rows), Already saved (existing rows updated), Skipped (unusable records), Partial (saved without complete details: cards, or a detail read missing a core field), Failed (rejected by the database). A job is counted only after Supabase confirms its save.

**How auto-save works, and what it never does:**
- The extension **never clicks, scrolls, opens or navigates anything** on LinkedIn. You do the browsing; it only saves
  the pages you choose to view, in the one tab where you pressed Start.
- When the page in that tab changes, the content script sends the worker a *data-free* "page changed" ping (only while
  auto-save is on). The worker accepts it only from its own content script in the top frame of the watched
  `www.linkedin.com` tab, waits ~1 s for LinkedIn to finish rendering, then reads the page itself (read-only).
  Content scripts still cannot save, list or control anything.
- Within a session each job is saved once; a job whose card was saved earlier is saved again **once** when you open it,
  to add its full details. Across sessions, jobs already in your database are updated (non-empty values win, empty
  values never erase), never duplicated.
- Job cards in a results list carry no description: open a job to save its full details.
- Connection problems are retried automatically (a few times); the affected jobs are saved on the next page you open
  if retries run out. Batches the database rejects count as Failed and are shown as "Last problem".
- Auto-save ends when you press Stop, close the watched tab, reload/update the extension, or restart the browser.

**Live progress** (shown again when you reopen the popup): Pages, Discovered (unique jobs seen this session),
Processed, Saved (new rows), Already saved (existing rows updated), Skipped (records with no usable fields), Failed,
the current activity (Reading / Saving / Auto-save is on / Stopped) and the last problem if any. A job is only counted
as saved after Supabase confirms its batch.

### Chrome checklist for 0.7.0 (NOT yet run by the author)
1. `npm run build`, then `chrome://extensions` -> **Reload** LinkedIn Job Saver (version **0.7.0**), then **reload your
   LinkedIn tabs** (tabs opened before the reload keep the old content script and send no pings).
2. Open LinkedIn job search results and click one job so its details load on the right.
3. Popup: Auto-save shows **Start**, **Stop** (disabled), Save open job only, seven counters.
4. **Start** -> "Saving... 5 of 25 processed." ... -> "Auto-save is on: 25 new jobs saved ...". Start is now disabled, Stop enabled.
5. Close the popup. Click **Next** on LinkedIn yourself. Reopen the popup -> Pages 2, about 50 discovered and saved.
6. Click a few jobs in the list -> "Already saved" goes up by one per job (its details were added), Saved does not.
7. Scroll the results list so more cards load -> the new cards are saved.
8. In a **second** LinkedIn tab, browse results -> nothing changes (only the Start tab is saved); its popup says
   auto-save is on for another tab and can Stop it.
9. **Stop** -> "Stopped by you. ... Jobs saved so far are kept." Click Next again -> counters do not change.
10. **Start** again -> a new session: on an already-saved page, every job counts as "Already saved".
11. Start, then close the LinkedIn tab -> the popup (opened on another tab) shows "Stopped because the LinkedIn tab was closed."
12. **Download CSV** -> `linkedin-saved-jobs-YYYY-MM-DD.csv`; opened jobs have a Description.
13. On a non-LinkedIn tab: Start is disabled with a hint; Download CSV still works.

### Automatic pagination / other sources
LinkedIn search results are never paged or opened automatically (LinkedIn's terms and this project's rules). The
extension already contains a source-adapter interface for an **authorised** job-data source: `src/sources/registry.js`
(`assertJobSource`: `search(params, cursor)` → refs + next cursor, `getDetails(ref)`, `normalize(raw)`) driven by the
run controller in `src/batch/` (bounded pages, rate limits, retries, repeated-cursor detection, job/page limits,
progress, Stop, incremental saves). No such source is enabled. To add one we need: a source you are permitted to use,
its documented API (endpoints, pagination, rate limits, terms), and any credential handling it requires.

## 8. Full job details: one job from extraction to CSV (version 0.9.2, NOT yet run by the author)
1. `npm run build`; `chrome://extensions` -> **Reload** (version **0.9.2**); reload the LinkedIn tab.
2. Open one job, e.g. `https://www.linkedin.com/jobs/view/<id>/`, and wait until "About the job" is shown.
3. Popup -> Selector check -> **Preview extraction**. Check the `summary` line: "Open job: complete - N fields found",
   the missing / not-stated lists, "Mapping: … nothing dropped", and (before the migration) the list of fields
   "Not stored until the database update". Compare `detail` with the page: title, company, location, country, posted,
   applicants, workplace, employment, salary + currency/period (if shown), application method (Easy Apply vs external),
   hiring insight, and the full description (ends with the last line of the posting, no "… more").
4. **Save open job only** -> "1 new job saved." (or "already saved, updated"), plus "Partial extraction (…)" if a core field
   was missing.
5. **Open saved jobs table** -> the job's row; Details shows the groups Job / Employment / Application / Requirements /
   Record and the full description. A card-only row shows a "Card only" badge.
6. Supabase dashboard -> Table editor -> `saved_jobs` -> that row: the same values (after the migration also `country`,
   `application_method`, `extraction_status` …).
7. **Download CSV** -> open the file: one row for the job; the headers listed in `docs/FIELDS.md`; description complete,
   multi-line cells intact, ₹ and other Unicode readable.

## Security notes
- Client code holds only the project URL and publishable key. Authorization is enforced by RLS in the database.
- The popup never names a user: ownership comes from the session held by the service worker, and the database sets
  `user_id` from `auth.uid()`. Any user id a caller supplies is ignored (and tested).
- The session (access + refresh token) is stored unencrypted in `chrome.storage.local`, readable only by this extension.
- All database/auth messages are accepted only from the extension's own pages, never from content scripts or web pages.
  The content script may send exactly one message, the data-free PAGE_CHANGED ping used by auto-save.
- A network failure never creates a new user. A new anonymous user is created only when no session exists, or when
  the stored session is permanently unrecoverable (the popup then warns that earlier jobs are no longer accessible).
- Job text is stored in your Supabase project. It is public job-posting content; no recruiter or personal profile data is read or saved.
