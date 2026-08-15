/** Feriados nacionais BR (fixos + móveis 2025–2027). Domingo de Páscoa não entra. */
const FIXED = ["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "11-20", "12-25"];

const MOVABLE: Record<string, string[]> = {
  "2025": ["03-03", "03-04", "04-18", "06-19"],
  "2026": ["02-16", "02-17", "04-03", "06-04"],
  "2027": ["02-08", "02-09", "03-26", "05-27"],
};

export function brazilHolidayName(now = new Date()): string | null {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value || "";
  const md = `${parts.find((p) => p.type === "month")?.value}-${parts.find((p) => p.type === "day")?.value}`;
  if (FIXED.includes(md)) return `feriado ${md}`;
  if ((MOVABLE[y] || []).includes(md)) return `feriado ${md}`;
  return null;
}

export function isBrazilHoliday(now = new Date()): boolean {
  return Boolean(brazilHolidayName(now));
}
