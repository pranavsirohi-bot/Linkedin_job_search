// Pure text/URL normalization helpers. No DOM access.
(function (root) {
  const LJS = (root.LJS = root.LJS || {});

  const WORKPLACE = [
    [/^remote$/i, "Remote"],
    [/^hybrid$/i, "Hybrid"],
    [/^on[-\s]?site$/i, "On-site"],
  ];
  const EMPLOYMENT = [
    [/^full[-\s]?time$/i, "Full-time"],
    [/^part[-\s]?time$/i, "Part-time"],
    [/^contract$/i, "Contract"],
    [/^temporary$/i, "Temporary"],
    [/^internship$/i, "Internship"],
    [/^volunteer$/i, "Volunteer"],
    [/^apprenticeship$/i, "Apprenticeship"],
  ];

  // LinkedIn's seniority vocabulary. Recognised only when a pill shows exactly one of these values.
  const SENIORITY = [
    [/^entry[-\s]?level$/i, "Entry level"],
    [/^associate$/i, "Associate"],
    [/^mid[-\s]?senior level$/i, "Mid-Senior level"],
    [/^director$/i, "Director"],
    [/^executive$/i, "Executive"],
  ];

  const UNIT_MS = {
    minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3,
  };

  // Collapse all whitespace (incl. NBSP / zero-width) to single spaces.
  function cleanText(s) {
    if (s == null) return "";
    return String(s).replace(/[ ​‌‍﻿]/g, " ").replace(/\s+/g, " ").trim();
  }

  // Keep line structure; tidy blank lines. Used for descriptions.
  function cleanMultiline(s) {
    if (s == null) return "";
    return String(s)
      .replace(/[ ​‌‍﻿]/g, " ")
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Returns https://www.linkedin.com/jobs/view/<id>/ or null. Rejects non-LinkedIn hosts.
  function canonicalJobUrl(href, base) {
    if (!href) return null;
    let u;
    try { u = new URL(href, base || "https://www.linkedin.com/"); } catch { return null; }
    if (u.protocol !== "https:" || !/(^|\.)linkedin\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{5,})/);
    return m ? `https://www.linkedin.com/jobs/view/${m[1]}/` : null;
  }

  function jobIdFromUrl(href) {
    const c = canonicalJobUrl(href);
    return c ? c.match(/(\d+)\/$/)[1] : null;
  }

  // https://www.linkedin.com/company/<slug>/ or null.
  function canonicalCompanyUrl(href, base) {
    if (!href) return null;
    let u;
    try { u = new URL(href, base || "https://www.linkedin.com/"); } catch { return null; }
    if (u.protocol !== "https:" || !/(^|\.)linkedin\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/company\/([^/]+)/);
    return m ? `https://www.linkedin.com/company/${m[1]}/` : null;
  }

  // "5 days ago" -> approximate ISO date relative to `now`. Returns null if not a relative time.
  function parseRelativeDate(text, now) {
    const m = cleanText(text).match(/(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/i);
    if (!m) return null;
    const ms = Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
    return new Date((now || new Date()).getTime() - ms).toISOString().slice(0, 10);
  }

  function matchVocab(table, text) {
    const t = cleanText(text);
    for (const [re, label] of table) if (re.test(t)) return label;
    return null;
  }

  // A pill that is a pay figure ("₹3L/yr - ₹5L/yr", "$120K/yr - $150K/yr"): a currency marker directly before a number.
  const SALARY_PILL_RE = /^(?:up to |from )?(?:[$€£₹]|USD|INR|EUR|GBP|CAD|AUD|SGD|AED|Rs\.?)\s?\d/i;

  // pills -> { workplaceType, employmentType, seniorityLevel, salary, otherPills[] } by text, never by position.
  function classifyPills(texts) {
    const out = { workplaceType: "", employmentType: "", seniorityLevel: "", salary: "", otherPills: [] };
    for (const raw of texts) {
      const t = cleanText(raw);
      if (!t) continue;
      const w = matchVocab(WORKPLACE, t);
      const e = matchVocab(EMPLOYMENT, t);
      const lvl = matchVocab(SENIORITY, t);
      if (w) { if (!out.workplaceType) out.workplaceType = w; }
      else if (e) { if (!out.employmentType) out.employmentType = e; }
      else if (lvl) { if (!out.seniorityLevel) out.seniorityLevel = lvl; }
      else if (SALARY_PILL_RE.test(t) && t.length <= 80) { if (!out.salary) out.salary = t; }
      else out.otherPills.push(t);
    }
    return out;
  }

  // Country named in the location text: the whole text or its last comma part must be a country name.
  // ("Pune, Maharashtra, India" -> "India"; "Mumbai Metropolitan Region" -> ""; never guessed from a city.)
  const COUNTRIES = [
    "Afghanistan", "Argentina", "Australia", "Austria", "Bangladesh", "Belgium", "Brazil", "Bulgaria", "Canada", "Chile",
    "China", "Colombia", "Croatia", "Cyprus", "Czechia", "Czech Republic", "Denmark", "Egypt", "Estonia", "Finland",
    "France", "Germany", "Ghana", "Greece", "Hong Kong", "Hong Kong SAR", "Hungary", "Iceland", "India", "Indonesia",
    "Ireland", "Israel", "Italy", "Japan", "Jordan", "Kenya", "Kuwait", "Latvia", "Lithuania", "Luxembourg", "Malaysia",
    "Malta", "Mexico", "Morocco", "Nepal", "Netherlands", "New Zealand", "Nigeria", "Norway", "Oman", "Pakistan", "Peru",
    "Philippines", "Poland", "Portugal", "Qatar", "Romania", "Saudi Arabia", "Serbia", "Singapore", "Slovakia",
    "Slovenia", "South Africa", "South Korea", "Spain", "Sri Lanka", "Sweden", "Switzerland", "Taiwan", "Thailand",
    "Turkey", "Türkiye", "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Vietnam",
  ];
  const COUNTRY_SET = new Map(COUNTRIES.map((c) => [c.toLowerCase(), c]));
  function countryFromLocation(text) {
    const t = cleanText(text).replace(/\s*\([^)]*\)\s*$/, "");
    if (!t) return "";
    const parts = t.split(",").map((x) => x.trim()).filter(Boolean);
    return COUNTRY_SET.get((parts[parts.length - 1] || "").toLowerCase()) || "";
  }

  // Currency and pay period of a salary text, only when the text states them unambiguously.
  // A bare "$" is NOT mapped (USD, CAD, AUD, SGD ... all use it); "US$" / "USD" are.
  const CURRENCY = [
    [/\bUSD\b|US\$/i, "USD"], [/\bINR\b|₹|\bRs\.?\s?\d|\blakhs?\b|\bLPA\b/i, "INR"], [/\bEUR\b|€/i, "EUR"],
    [/\bGBP\b|£/i, "GBP"], [/\bCAD\b|CA\$/i, "CAD"], [/\bAUD\b|A\$/i, "AUD"], [/\bSGD\b|S\$/i, "SGD"], [/\bAED\b/i, "AED"],
  ];
  const PERIOD = [
    [/(?:\/\s?|\bper\s|\ban?\s)(?:hour|hr)\b|\bhourly\b/i, "hour"],
    [/(?:\/\s?|\bper\s|\ban?\s)day\b|\bdaily\b/i, "day"],
    [/(?:\/\s?|\bper\s|\ban?\s)week\b|\bweekly\b/i, "week"],
    [/(?:\/\s?|\bper\s|\ban?\s)(?:month|mo)\b|\bmonthly\b/i, "month"],
    [/(?:\/\s?|\bper\s|\ban?\s)(?:year|yr|annum)\b|\bannual(?:ly)?\b|\bLPA\b|\bp\.a\./i, "year"],
  ];
  function parseSalaryDetails(salaryText) {
    const t = cleanText(salaryText);
    if (!t) return { currency: "", period: "" };
    let currency = "";
    for (const [re, code] of CURRENCY) if (re.test(t)) { currency = code; break; }
    let period = "";
    for (const [re, p] of PERIOD) if (re.test(t)) { period = p; break; }
    return { currency, period };
  }

  // Explicit "Key: value" lines in the description ("Employment Type: Full-time", "Location: Remote").
  // A value is used only when it is exactly one known vocabulary term.
  function parseKeyValueFields(description) {
    const out = { workplaceType: "", employmentType: "" };
    for (const line of String(description || "").split("\n")) {
      const m = line.match(/^\s*(?:-\s*)?(employment type|job type|type of employment|work(?:place)? (?:type|mode|model)|location)\s*:\s*(.+?)\s*$/i);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = cleanText(m[2]);
      if (/employment|job type/.test(key)) { if (!out.employmentType) out.employmentType = matchVocab(EMPLOYMENT, val) || ""; }
      else if (!out.workplaceType) out.workplaceType = matchVocab(WORKPLACE, val) || "";
    }
    return out;
  }

  // "About the company" facts line (EVIDENCE 2026-10-22): name, "N followers", industry, " • ", "1001-5000 employees",
  // " • ", "N on LinkedIn". Industry is the one remaining short text; it is only taken when a size or followers line
  // confirms this is the facts block.
  function parseCompanyFacts(texts, companyName) {
    const t = (texts || []).map(cleanText).filter((x) => x && x !== "•");
    const size = t.find((x) => /^\d[\d,]*\+?(\s?[-–]\s?\d[\d,]*)?\s+employees$/i.test(x)) || "";
    const anchored = !!size || t.some((x) => /\bfollowers$/i.test(x));
    const name = cleanText(companyName).toLowerCase();
    const rest = t.filter((x) => x !== size && !/\bfollowers$|\bon linkedin$|\bemployees$/i.test(x) && x.toLowerCase() !== name);
    const industry = anchored ? rest.find((x) => x.length <= 100 && !/\d{3,}/.test(x)) || "" : "";
    return { industry, companySize: size };
  }

  // Employer application URL from the external Apply link. LinkedIn wraps it as
  // https://www.linkedin.com/safety/go/?url=<encoded employer URL>&urlhash=... (EVIDENCE 2026-10-22). Only a plain https
  // URL on a non-LinkedIn host is returned; anything else (tracking-only links, javascript:, LinkedIn pages) gives "".
  function externalApplyUrl(href) {
    let u;
    try { u = new URL(href, "https://www.linkedin.com/"); } catch { return ""; }
    let target = u;
    if (/(^|\.)linkedin\.com$/.test(u.hostname)) {
      if (u.pathname !== "/safety/go/" && u.pathname !== "/safety/go") return "";
      try { target = new URL(u.searchParams.get("url") || ""); } catch { return ""; }
    }
    if (target.protocol !== "https:" || target.username || target.password || /(^|\.)linkedin\.com$/.test(target.hostname)) return "";
    const s = target.href;
    return s.length <= 2048 && !/[\s"<>]/.test(s) ? s : "";
  }

  // The Apply button LinkedIn shows: "Easy Apply to this job" -> easy_apply; "Apply on company website" -> external.
  function classifyApplyLabel(label) {
    const t = cleanText(label);
    if (/^easy apply\b/i.test(t)) return "easy_apply";
    if (/^apply\b/i.test(t)) return "external";
    return "";
  }

  // "India (Remote)" -> { location: "India", workplaceType: "Remote" }
  function splitLocation(text) {
    const t = cleanText(text);
    const m = t.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (m) {
      const w = matchVocab(WORKPLACE, m[2]);
      if (w) return { location: m[1], workplaceType: w };
    }
    return { location: t, workplaceType: "" };
  }

  // Classify the "location · posted · applicants" spans by content, not position.
  function classifyMeta(spanTexts) {
    const out = { location: "", postedText: "", applicantsText: "", extra: [] };
    for (const raw of spanTexts) {
      const t = cleanText(raw);
      if (!t || t === "·") continue;
      if (/\bago\b/i.test(t) && !out.postedText) out.postedText = t;
      else if (/(applicant|clicked apply|people)/i.test(t) && !out.applicantsText) out.applicantsText = t;
      else if (!out.location) out.location = t;
      else out.extra.push(t);
    }
    return out;
  }

  // ---- Best-effort parsing of the free-text description (HEURISTIC, not DOM-based) ----
  // Apostrophes may be straight or curly, so "what you.ll" tolerates either.
  // "What You Do" (EVIDENCE 2026-10-22), "What you'll do", "What you will be doing", "Your responsibilities" ...
  const RESP_RE = /(responsibilit|your role|what you(?:.{1,3}ll| will)? (?:be )?(do|doing|work on)\b|in this role|duties|role expectations|what we expect)/i;
  // Headings that END a section (benefits, culture, company, process ...). Not saved as requirements.
  const STOP_RE = /(benefit|perks|why you|why join|why work|what we offer|we offer|compensation|salary|about (us|the company|the team)|who we are|our (culture|values|story|mission)|life at|equal opportunit|diversity|hiring process|interview process|selection process|how to apply|next steps|we are |candidate details|application form|apply (now|here|at|via)|to apply|contact|regards|thank|we look forward|interested candidates)/i;
  // A prose line that starts application instructions ("Please share the following details ...") ends any section.
  const APPLY_INSTRUCTIONS_RE = /^(please|kindly) (share|send|fill|email|mail|apply)|^(share|send|email|mail) (us )?your|^interested candidates|^to apply\b/i;
  // List markers: "-" (from <li>), "•", "*", "●", "▪", "➤", check marks "✔️ ✓ ✅ ☑" (EVIDENCE: "✔️ Developers with ...").
  const BULLET_RE = /^(?:[-•*●▪◦➢➤►]|[✔✓✅☑]️?)\s*/;
  const isBulletLine = (l) => /^(?:[-•*●▪◦➢➤►]\s|[✔✓✅☑]️?\s?\S)/.test(l);
  const QUAL_RE = /(qualification|requirement|your profile|what you bring|what we.{0,3}re looking for|who you are|must have|experience required|(mandatory|required|key|technical|core|essential) skills|skills (required|needed|&|and)|skill set|who can apply|eligibility|what you need|you should have)/i;
  const PREF_RE = /(preferred|nice[-\s]to[-\s]have|good[-\s]to[-\s]have|bonus points|desirable|would be a plus|is a plus)/i;
  const EDU_HEAD_RE = /^(education|educational qualifications?|academic qualifications?)\b/i;
  const CERT_HEAD_RE = /^(certifications?|licen[cs]es?( (and|&) certifications?)?)\b/i;

  // A short line that is not a bullet and does not end like a sentence. "!" is allowed: LinkedIn shows headings such
  // as "Benefits of working at Optiphoenix!" (EVIDENCE 2026-10-22), which must END the previous section.
  // "?" is allowed too ("Who Can Apply?"); a sentence ending in "." never is.
  function isHeadingLine(l) {
    return l.length > 0 && l.length <= 60 && !isBulletLine(l) && !/\.$/.test(l);
  }

  // Heading-based sections. Lines are copied as written; nothing is generated.
  //  * an unknown heading inside Responsibilities is a sub-heading ("Security", "Integrations" ...): the section goes on
  //    (EVIDENCE 2026-10-22, job 4454777534); elsewhere an unknown heading ends the section
  //  * STOP headings (benefits, culture, hiring process ...) always end it
  //  * a long prose paragraph after a section's bullet list (e.g. an equal-opportunity statement) ends it
  const SECTION_MAX = 100;
  function parseSections(description) {
    const out = { responsibilities: [], qualifications: [], preferredQualifications: [], education: [], certifications: [] };
    let current = null;
    let bullets = 0;
    for (const line of String(description || "").split("\n").map((l) => l.trim()).filter(Boolean)) {
      const isBullet = isBulletLine(line);
      if (isHeadingLine(line)) {
        let next;
        if (STOP_RE.test(line) && !RESP_RE.test(line) && !QUAL_RE.test(line)) next = null;
        else if (EDU_HEAD_RE.test(line)) next = "education";
        else if (CERT_HEAD_RE.test(line)) next = "certifications";
        else if (PREF_RE.test(line)) next = "preferredQualifications"; // before QUAL_RE: "Preferred qualifications"
        else if (RESP_RE.test(line)) next = "responsibilities";
        else if (QUAL_RE.test(line)) next = "qualifications";
        else next = current === "responsibilities" ? "responsibilities" : null;
        if (next !== current) bullets = 0;
        current = next;
        continue;
      }
      if (!current) continue;
      if (!isBullet && (APPLY_INSTRUCTIONS_RE.test(line) || (bullets > 0 && line.length > 150))) { current = null; continue; }
      if (isBullet) bullets++;
      const item = line.replace(BULLET_RE, "").trim();
      if (item && out[current].length < SECTION_MAX) out[current].push(item);
    }
    return out;
  }

  const bullet = (l) => cleanText(String(l).replace(/^\s*[-•*]\s*/, ""));
  function collector(max) {
    const out = [];
    const add = (l) => { const t = bullet(l); if (t && t.length <= 300 && !out.includes(t) && out.length < max) out.push(t); };
    return { out, add };
  }
  // Lines that state an education requirement: an "Education:" line, an Education section, or a line naming a degree.
  const DEGREE_RE = /\b(bachelor(?:'s|’s|s)?|master(?:'s|’s|s)(?=\s|$|[,.;)])|masters? (?:of|in) |(?<![\d-])degree|b\.?\s?tech|m\.?\s?tech|b\.?\s?sc|m\.?\s?sc|b\.?\s?com|bca|mca|mba|ph\.?\s?d|doctorate|diploma|post[-\s]?graduat(?:e|ion))\b/i;
  function parseEducation(description, sectionLines = []) {
    const { out, add } = collector(10);
    for (const l of sectionLines) add(l);
    for (const line of String(description || "").split("\n")) {
      const m = line.match(/^\s*(?:-\s*)?education(?:al qualifications?)?\s*:\s*(.+)$/i);
      if (m) add(m[1]);
      else if (DEGREE_RE.test(line) && line.trim().length <= 300) add(line);
    }
    return out;
  }

  // Lines that name a certification / certificate / licence.
  const CERT_RE = /\b[Cc]ertifications?\b|\b[Cc]ertificates?\b|\b[A-Z][A-Za-z0-9+&.-]*\s+[Cc]ertified\b/;
  // Not a credential the candidate must hold: the employer's own badges, or technical certificates (SSL/TLS ...).
  const CERT_NOT_CANDIDATE_RE = /\b(we are|we're|our (company|team|office|products?)|b corp|great place to work|iso\s?\d+|company is|ssl|tls|https?|x\.?509|code[- ]signing|certificate (authority|management|renewal|requirements?))\b/i;
  function parseCertifications(description, sectionLines = []) {
    const { out, add } = collector(10);
    for (const l of sectionLines) add(l);
    for (const line of String(description || "").split("\n")) {
      if (CERT_RE.test(line) && !CERT_NOT_CANDIDATE_RE.test(line) && line.trim().length <= 300) add(line);
    }
    return out;
  }

  // A pay figure in the description counts as the salary only when its line is about pay: a pay word
  // (salary, compensation, CTC, stipend, ...) or a pay period right after the figure. Company facts such as
  // "raised $20M" or "a ₹500 crore company" are never taken as a salary.
  const SALARY_FIGURE_RE = /(?:(?:[Uu]p to|[Ff]rom|[Ss]tarting at)\s+)?(?:[$€£₹]|USD|INR|EUR|GBP|Rs\.?)\s?\d[\d,.]*\s?(?:[kKmM]|lakhs?|LPA)?(?:\s?(?:-|–|to)\s?(?:[$€£₹]|USD|INR|EUR|GBP|Rs\.?)?\s?\d[\d,.]*\s?(?:[kKmM]|lakhs?|LPA)?)?(?:\s?(?:per|\/|a|an)\s?(?:year|yr|annum|month|hour|hr|week|day))?/;
  const LPA_RE = /\d+(?:\.\d+)?\s?(?:-|–|to)\s?\d+(?:\.\d+)?\s?(?:LPA|lakhs? per annum)\b|\d+(?:\.\d+)?\s?(?:LPA|lakhs? per annum)\b/i;
  const PAY_WORD_RE = /\b(salary|salaries|compensation|ctc|stipend|pay|paid|package|remuneration|wages?|base|ote|earn(?:ing)?s?)\b/i;
  const PAY_PERIOD_AFTER_RE = /^\s?(?:per|\/|a|an)\s?(?:year|yr|annum|month|hour|hr|week|day)\b/i;
  function parseSalary(description) {
    for (const line of String(description || "").split("\n")) {
      const m = line.match(SALARY_FIGURE_RE);
      const payLine = PAY_WORD_RE.test(line);
      if (m) {
        const after = line.slice(m.index + m[0].length);
        if (payLine || /(?:per|\/|\ba\b|\ban\b)\s?(?:year|yr|annum|month|hour|hr|week|day)\b/i.test(m[0]) || PAY_PERIOD_AFTER_RE.test(after)) return cleanText(m[0]);
      }
      const l = payLine ? line.match(LPA_RE) : null;
      if (l) return cleanText(l[0]);
    }
    return "";
  }

  function parseExperience(description) {
    // Prefer an explicit "Experience: ..." line (optionally a list item) over a years-pattern guess.
    const line = description.match(/^\s*(?:-\s*)?(?:required )?experience\s*(?:level|required)?\s*[:\-]\s*(.+)$/im);
    if (line) return cleanText(line[1]);
    // A years phrase counts only on a line that is about experience ("Founded 15 years ago" is not a requirement).
    for (const l of String(description || "").split("\n")) {
      if (!/\bexperience/i.test(l)) continue;
      const m = l.match(/(\d{1,2})\s?\+?\s?(?:(?:-|–|to)\s?(\d{1,2})\s?\+?\s?)?(?:years?|yrs?)\b[^.\n]{0,200}/i);
      if (m) return cleanText(m[0].length > 180 ? m[0].slice(0, 180).replace(/\s+\S*$/, "") : m[0]); // never cut mid-word
    }
    return "";
  }

  // Only explicit "Skills: a, b, c" lines; no guessing from a vocabulary.
  function parseSkills(description) {
    const m = description.match(/^\s*(?:key |required |technical )?skills?\s*[:\-]\s*(.+)$/im);
    if (!m) return [];
    return m[1].split(/[,;•|]/).map(cleanText).filter((s) => s && s.length <= 60).slice(0, 40);
  }

  // Wording of the "closed" notice (English). The notice is first located by structure (see xpath-selectors.js);
  // this only decides whether its text really says applications are closed.
  const CLOSED_NOTICE_RE = /\b(no longer|not) accepting\b|\bapplications?\b[^.]{0,20}\bclosed\b|\bposition (has been )?(filled|closed)\b|\bexpired\b/i;
  function classifyApplicationNotice(text) {
    return CLOSED_NOTICE_RE.test(cleanText(text)) ? "closed" : null;
  }

  LJS.normalize = {
    classifyApplicationNotice,
    cleanText, cleanMultiline, canonicalJobUrl, jobIdFromUrl, canonicalCompanyUrl, parseRelativeDate,
    classifyPills, splitLocation, classifyMeta, parseSections, parseSalary, parseExperience, parseSkills,
    countryFromLocation, parseSalaryDetails, parseKeyValueFields, classifyApplyLabel, parseEducation, parseCertifications,
    externalApplyUrl, parseCompanyFacts,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = LJS;
})(typeof globalThis !== "undefined" ? globalThis : this);
