// Supabase connection settings for the extension (client-side code).
//
// ONLY the project URL and the PUBLISHABLE key belong here. Both are designed to be public; access control is
// enforced by Row Level Security in the database. NEVER put a secret key (sb_secret_...) or a service_role key
// in this file: anything in the extension is readable by every user. isConfigured() refuses such keys.
//
// Fill these in from Supabase Dashboard -> Project Settings -> API (Project URL, Publishable key).
export const SUPABASE_CONFIG = Object.freeze({
  url: "https://sgilspaeabyiggqicodc.supabase.co",
  publishableKey: "sb_publishable_1kOL0utI6ZGmxMo3U21_XQ_4AcL834o",
});

function jwtRole(key) {
  try {
    const part = key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part)).role || null;
  } catch {
    return null;
  }
}

// Returns { ok, reason }. Rejects placeholders, non-Supabase URLs and anything that looks like a privileged key.
export function checkConfig(config = SUPABASE_CONFIG) {
  const { url, publishableKey: key } = config || {};
  if (typeof url !== "string" || !/^https:\/\/[a-z0-9]{8,}\.supabase\.co$/.test(url)) {
    return { ok: false, reason: "Supabase project URL is not configured." };
  }
  if (typeof key !== "string" || key.length < 20 || /YOUR_KEY/.test(key)) {
    return { ok: false, reason: "Supabase publishable key is not configured." };
  }
  if (key.startsWith("sb_secret_") || jwtRole(key) === "service_role") {
    return { ok: false, reason: "A secret/service-role key was supplied. Use the publishable key only." };
  }
  if (!key.startsWith("sb_publishable_") && !key.startsWith("eyJ")) {
    return { ok: false, reason: "Unrecognised key format; use the publishable (or legacy anon) key." };
  }
  return { ok: true, reason: "" };
}

export const isConfigured = (config) => checkConfig(config).ok;
