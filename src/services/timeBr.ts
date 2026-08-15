/** Formatação e “agora” no fuso do Brasil (America/Sao_Paulo). */

export const BR_TZ = "America/Sao_Paulo";

export function nowBrIso(): string {
  // Guarda instante UTC; a exibição converte para BR
  return new Date().toISOString();
}

export function formatBrDateTime(
  value: string | number | Date | null | undefined,
  opts?: { withSeconds?: boolean },
): string {
  if (value == null || value === "") return "—";
  let d: Date;
  if (value instanceof Date) d = value;
  else if (typeof value === "number") d = new Date(value);
  else {
    // SQLite datetime('now') vem sem Z → tratar como UTC
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
      d = new Date(s.replace(" ", "T") + "Z");
    } else {
      d = new Date(s);
    }
  }
  if (!Number.isFinite(d.getTime())) return String(value);
  return d.toLocaleString("pt-BR", {
    timeZone: BR_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: opts?.withSeconds ? "2-digit" : undefined,
  });
}

export function formatBrTime(
  value: string | number | Date | null | undefined,
): string {
  if (value == null || value === "") return "—";
  const full = formatBrDateTime(value);
  const parts = full.split(" ");
  return parts[parts.length - 1] || full;
}

/** Minutos desde 00:00 no fuso de Brasília. */
export function brazilMinutesSinceMidnight(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BR_TZ,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value || 0);
  // Intl pode devolver 24:00 → normaliza
  const hour = h === 24 ? 0 : h;
  return hour * 60 + m;
}

/** Início do dia civil em Brasília, como UTC ISO `YYYY-MM-DD HH:MM:SS` (SQLite). */
export function isoSinceBrazilMidnight(now = new Date()): string {
  const mins = brazilMinutesSinceMidnight(now);
  return new Date(now.getTime() - mins * 60_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

/** 0 = domingo … 6 = sábado (Brasília). */
export function brazilWeekday(now = new Date()): number {
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: BR_TZ,
    weekday: "short",
  }).format(now);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[wd] ?? new Date(now).getDay();
}
