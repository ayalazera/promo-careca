import type { WaGroup } from "../db/index.js";

function campaignSlug(group?: WaGroup | null): string {
  const raw = `${group?.categories || group?.name || "geral"}`
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return raw || "geral";
}

/** UTM só em URLs longas do ML — meli.la fica curto, sem query. */
export function withGroupUtm(url: string, group?: WaGroup | null): string {
  const raw = String(url || "").trim();
  if (!raw) return raw;
  if (/meli\.la\//i.test(raw)) {
    try {
      const u = new URL(raw);
      u.search = "";
      u.hash = "";
      return u.toString().replace(/\/$/, "");
    } catch {
      return raw.split("?")[0] || raw;
    }
  }
  if (!/mercadolivre\.com\.br/i.test(raw)) return raw;
  try {
    const u = new URL(raw);
    if (!u.searchParams.has("utm_source")) {
      u.searchParams.set("utm_source", "carecavip");
    }
    u.searchParams.set("utm_medium", "whatsapp");
    u.searchParams.set("utm_campaign", campaignSlug(group));
    return u.toString();
  } catch {
    return raw;
  }
}
