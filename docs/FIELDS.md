# Job fields: extraction → database → table → export (version 0.9.2)

One row per field. **Source** says where the value comes from; nothing is filled in when the page does not state it.
"Card" = a job card in the search-results list; "Detail" = the open job (right-hand panel or `/jobs/view/<id>/`).
Columns marked **M** exist only after migration `20261022000200_job_detail_fields.sql` is applied (until then the
extension still works: these values are extracted and shown in Preview, but not stored).

| Database column | Model property | Source (selector / method) | Saved Jobs display | CSV / Excel header | Availability |
|---|---|---|---|---|---|
| `linkedin_job_id` | `jobId` | card `componentkey="job-card-component-ref-<id>"`; detail `JobDetails_AboutTheJob_<id>` id, else title link, else URL | Details › Job ID | Job ID | required |
| `job_url` | `url` | canonical `https://www.linkedin.com/jobs/view/<id>/` | title link | Job URL | required |
| `job_title` | `title` | card `p/span[@aria-hidden]`; detail title link / header-anchored `<p>` | Job column | Job title | required (core) |
| `company_name` | `company` | company link with its own text | Company column | Company | required (core) |
| `industry` **M** | `industry` | "About the company" facts line (only when a size / followers line confirms the block) | Details › Industry | Industry | detail only |
| `company_size` **M** | `companySize` | "About the company": "1001-5000 employees" | Details › Company size | Company size | detail only |
| `company_url` | `companyUrl` | that link's href, canonicalised | Details › Company page | Company URL | detail only |
| `location` | `location` | card location `<p>`; detail meta line (span classified by content); if blank, the same job's card | Location column | Location | required (core) |
| `country` **M** | `country` | last comma part of the location when it is a country name (list in `normalize.js`) | Details › Country | Country | optional (only if the location names a country) |
| `provider` (implicit) | `provider` | always LinkedIn for this extension | Source column | Source | always |
| `posted_text` | `postedText` | meta line span containing "ago" (incl. "Reposted …") | Posted column | Posted | detail only (core) |
| `posted_date_approx` | `postedDateApprox` | computed from `postedText` and the read time | Posted column | Posted date (approx.) | detail only |
| `description` | `description` | `JobDetails_AboutTheJob_*` › `span[data-testid=expandable-text-box]`, full text with line structure, "… more" button excluded | Details › Full description | Description | detail only (core) |
| `responsibilities` | `responsibilities` | description lines under a responsibilities heading | Details › Responsibilities | Responsibilities | optional |
| `qualifications` | `qualifications` | description lines under a requirements/qualifications heading | Details › Required qualifications | Required qualifications | optional |
| `preferred_qualifications` **M** | `preferredQualifications` | lines under a "Preferred / Nice to have / Good to have" heading | Details › Preferred qualifications | Preferred qualifications | optional |
| `skills` | `skills` | explicit "Skills: a, b, c" line only (lower-cased) | Skills column | Skills | optional |
| `experience_required` | `experience` | explicit "Experience: …" line, else an "N years" phrase on a line that mentions experience ("founded 15 years ago" is ignored) | Details › Experience | Experience required | optional |
| `education_requirements` **M** | `education` | "Education:" line, Education section, or a line naming a degree (Bachelor's, Master's, B.Tech, MBA, diploma …; not "Scrum Master", "master data", "360-degree") | Details › Education | Education | optional |
| `certifications` **M** | `certifications` | Certifications section, or lines with "certification", "certificate" or "<Name> Certified"; the employer's own badges (B Corp, ISO, Great Place to Work) are excluded | Details › Certifications | Certifications | optional |
| `workplace_type` | `workplaceType` | pill text; else "(Remote)" in the location; else an explicit "Location/Work mode: Remote" line | Workplace column | Workplace type | expected |
| `employment_type` | `employmentType` | pill text; else an explicit "Employment Type: …" line | Employment column | Employment type | expected |
| `seniority_level` **M** | `seniorityLevel` | pill with LinkedIn's exact wording (Entry level, Associate, Mid-Senior level, Director, Executive) | Details › Seniority level | Seniority level | optional (not seen in the pasted pages) |
| `salary` | `salary` | pay pill; else a pay figure on a description line about pay (salary, CTC, stipend, compensation …, or a pay period after the figure); "raised $20M" is ignored | Details › Salary | Salary | optional |
| `salary_currency` **M** | `salaryCurrency` | ISO code / unambiguous symbol in the salary text (a bare "$" is left empty) | Details › Salary | Salary currency | optional |
| `salary_period` **M** | `salaryPeriod` | "/month", "per year", "LPA", "hourly" … in the salary text | Details › Salary | Salary period | optional |
| `application_method` **M** | `applicationMethod` | aria-label of the Apply control (a `<button>` or, as seen live on 2026-10-22, an `<a>`): "Easy Apply…" → easy_apply, "Apply on company website" → external | Details › How to apply | Application method | expected |
| `application_url` **M** | `applicationUrl` | href of the external Apply link; LinkedIn's `safety/go/?url=` redirect is decoded; only an https non-LinkedIn URL is kept; never opened | Details › Application page | External application URL | external jobs only |
| `application_status` | `applicationStatus` | closed notice (`aria-live=assertive` + Error icon) → closed; Apply button or link → open; else unknown (NULL) | Applications column | Application status | expected |
| `application_status_text` | `applicationStatusText` | text of the closed notice | Applications badge tooltip, Details | Application notice | only when closed |
| `application_status_at` | `applicationStatusAt` | read time when a status was observed | Details › Status checked | Status checked at | when observed |
| `applicants_text` | `applicantsText` | meta line span with "applicant / clicked apply / people" | Details › Applicants | Applicants | expected |
| `hiring_insight` **M** | `hiringInsight` | the insight `<div><p>` right after the meta line | Details › Hiring insight | Hiring insight | optional |
| `benefits` **M** | `benefits` | LinkedIn's "Benefits found in job post" list under the description | Details › Benefits | Benefits | optional |
| `other_pills` | `otherPills` | pills not recognised as any of the above | Details › Other tags | Other tags | optional |
| `source`, `has_full_detail` | `source`, `hasFullDetail` | card or detail; true once a description is stored | Details › Captured from | Captured from | always |
| `extraction_status` **M** | `extractionStatus` | complete = all core fields present; partial otherwise; cards are always partial | "Card only" / "Partial" badge, Details › Extraction | Extraction status | always (new saves) |
| `extraction_warnings` **M** | `extractionWarnings` | `missing:<field>`, `selector-empty:<field>`, `card-only` | Details › Warnings | Extraction warnings | when any |
| `created_at` | `createdAt` | database | Saved column, Details › First saved | First saved | always |
| `scraped_at` | `collectedAt` | latest read time (merge keeps the newest) | Details › Last checked | Last checked | always |
| `updated_at` | `updatedAt` | database trigger | Details › Last updated | Last updated | always |

When a card and the open job are the same job, blank list fields of the detail are filled from that card (source `job-card`) and the record is graded again; a card's "card-only" warning never overrides the detail's status.

**Core** fields decide "complete". **Expected** fields are normally shown by LinkedIn and produce a warning when
missing. **Optional** fields are present only when the job states them; their absence is not a warning.

## Not extracted, and why
| Field | Reason |
|---|---|
| Job function | Not present in any pasted LinkedIn markup; no evidence to write a selector against. |
| Seniority level (beyond pills) | Only recognised when LinkedIn shows it as a pill; never guessed from the title. |
| Last-updated date (LinkedIn's) | LinkedIn shows only a relative posted / reposted time, which is stored as Posted. |
| Recruiter / hiring contact | Deliberately not read ("People you can reach out to" is other people's profile data). |
| User notes, user application-tracking status | Not part of the current data model; not added in this change. |
