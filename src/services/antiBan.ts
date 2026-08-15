import { createHash } from "node:crypto";
import { config } from "../config.js";
import {
  countSendsSince,
  getDb,
  getSetting,
  getSettingNum,
  logAntiBan,
  setSetting,
  type WaGroup,
} from "../db/index.js";
import {
  brazilMinutesSinceMidnight,
  brazilWeekday,
  isoSinceBrazilMidnight,
} from "./timeBr.js";
import { brazilHolidayName, isBrazilHoliday } from "./holidaysBr.js";

export type AntiBanDecision =
  | { allow: true; delayMs: number }
  | { allow: false; reason: string; retryAfterMs?: number };

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3600_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function parseHHMM(raw: string, fallbackMin: number): number {
  const m = String(raw || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallbackMin;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return fallbackMin;
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallbackMin;
  return h * 60 + min;
}

function formatHHMM(mins: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(mins)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function isWeekendBr(now = new Date()): boolean {
  const wd = brazilWeekday(now);
  return wd === 0 || wd === 6;
}

export function sendWindowFor(now = new Date()): {
  startMin: number;
  endMin: number;
} {
  const weekend = isWeekendBr(now);
  const start = parseHHMM(
    getSetting(
      weekend ? "send_weekend_start" : "send_weekday_start",
      weekend ? "10:00" : "09:30",
    ),
    weekend ? 10 * 60 : 9 * 60 + 30,
  );
  const end = parseHHMM(
    getSetting(
      weekend ? "send_weekend_end" : "send_weekday_end",
      weekend ? "20:00" : "21:30",
    ),
    weekend ? 20 * 60 : 21 * 60 + 30,
  );
  const startMin = clampInt(
    start,
    7 * 60,
    21 * 60,
    weekend ? 10 * 60 : 9 * 60 + 30,
  );
  let endMin = clampInt(
    end,
    startMin + 180,
    23 * 60,
    weekend ? 20 * 60 : 21 * 60 + 30,
  );
  if (endMin <= startMin) endMin = Math.min(23 * 60, startMin + 8 * 60);
  return { startMin, endMin };
}

/**
 * Espaço mínimo entre envios a grupos diferentes.
 * Padrão 60s — 1 grupo por minuto (nunca vários no mesmo minuto; anti-ban WA com 13 grupos).
 */
export function globalInterGroupGapSec(): number {
  return clampInt(
    Number(getSetting("post_inter_group_delay_sec", "60")),
    45,
    180,
    60,
  );
}

function isPeakCadenceHour(now = new Date()): boolean {
  const m = brazilMinutesSinceMidnight(now);
  return (
    (m >= 12 * 60 && m < 14 * 60) || (m >= 18 * 60 && m < 21 * 60)
  );
}

/** Janela configurável (semana vs fim de semana). Fora disso: silêncio. */
export function inQuietHours(now = new Date()): boolean {
  const t = brazilMinutesSinceMidnight(now);
  const w = sendWindowFor(now);
  if (t < w.startMin || t >= w.endMin) return true;
  if (getSetting("lunch_silence", "0") === "1") {
    const lunchStart = parseHHMM(getSetting("lunch_start", "12:00"), 12 * 60);
    const lunchEnd = parseHHMM(getSetting("lunch_end", "13:30"), 13 * 60 + 30);
    if (t >= lunchStart && t < lunchEnd) return true;
  }
  return false;
}

export function msUntilQuietEnds(now = new Date()): number {
  const t = brazilMinutesSinceMidnight(now);
  const w = sendWindowFor(now);
  if (t < w.startMin) return Math.max(w.startMin - t, 1) * 60_000;
  let waitMin = 24 * 60 - t;
  const tomorrow = new Date(now.getTime() + (waitMin + 1) * 60_000);
  const next = sendWindowFor(tomorrow);
  waitMin += next.startMin;
  return Math.max(waitMin, 1) * 60_000;
}

function warmupDayIndex(): number {
  const started = getSetting("account_started_at", new Date().toISOString());
  const startMs = Date.parse(started);
  if (!Number.isFinite(startMs)) return 0;
  return Math.floor((Date.now() - startMs) / 86400_000);
}

/**
 * Cadência por grupo — limites e intervalo configuráveis no painel.
 * Aquecimento opcional na 1ª/2ª semana. 1 post por onda.
 */
export function getCadence() {
  const day = warmupDayIndex();
  const weekend = isWeekendBr();
  const warmupOn = getSetting("cadence_warmup", "1") === "1";
  const peak = isPeakCadenceHour();

  let warmupDayCap = 200;
  // Off-peak 7–10 min; pico 3–5 min (mesmo grupo)
  let minDelaySec = getSettingNum(
    "cadence_interval_min_sec",
    peak ? 3 * 60 : 7 * 60,
    3 * 60,
    30 * 60,
  );
  let maxDelaySec = getSettingNum(
    "cadence_interval_max_sec",
    peak ? 5 * 60 : 10 * 60,
    4 * 60,
    40 * 60,
  );
  if (peak) {
    minDelaySec = Math.min(minDelaySec, 5 * 60);
    maxDelaySec = Math.min(Math.max(maxDelaySec, minDelaySec + 60), 5 * 60);
  }
  if (maxDelaySec < minDelaySec) maxDelaySec = minDelaySec + 60;
  let warmupHourCap = 16;
  let weekLabel = peak ? "cadência pico" : "cadência configurada";

  if (warmupOn && day < 7) {
    warmupDayCap = getSettingNum("warmup_week1_cap", 40, 8, 200);
    const userForced = getSetting("cadence_interval_locked", "0") === "1";
    if (!userForced) {
      minDelaySec = Math.max(minDelaySec, 8 * 60);
      maxDelaySec = Math.max(maxDelaySec, 12 * 60);
    }
    warmupHourCap = getSettingNum("warmup_week1_hour_cap", 6, 2, 20);
    weekLabel = `semana 1 (aquecimento · máx. ${warmupDayCap}/dia)`;
  } else if (warmupOn && day < 14) {
    warmupDayCap = getSettingNum("warmup_week2_cap", 80, 16, 200);
    warmupHourCap = getSettingNum("warmup_week2_hour_cap", 10, 3, 20);
    weekLabel = "semana 2";
  }

  const userDay = clampInt(
    Number(
      getSetting(
        weekend ? "send_weekend_day_limit" : "send_weekday_day_limit",
        weekend ? "70" : "90",
      ),
    ),
    8,
    200,
    weekend ? 70 : 90,
  );
  const userHour = clampInt(
    Number(
      getSetting(
        weekend ? "send_weekend_hour_limit" : "send_weekday_hour_limit",
        weekend ? "12" : "16",
      ),
    ),
    2,
    24,
    weekend ? 12 : 16,
  );

  let dayLimit = warmupOn ? Math.min(userDay, warmupDayCap) : userDay;
  let hourLimit = warmupOn ? Math.min(userHour, warmupHourCap) : userHour;
  const sunday = brazilWeekday() === 0;
  if (sunday) {
    const sunCap = clampInt(
      Number(getSetting("send_sunday_day_limit", "45")),
      8,
      200,
      45,
    );
    dayLimit = Math.min(dayLimit, sunCap);
    weekLabel += " · domingo ~50%";
  } else if (weekend) {
    weekLabel += " · fim de semana";
  }

  const win = sendWindowFor();
  const interGap = globalInterGroupGapSec();

  return {
    day,
    dayLimit,
    hourLimit,
    minDelaySec,
    maxDelaySec,
    sunday: sunday,
    weekend,
    peak,
    weekLabel,
    sendStart: formatHHMM(win.startMin),
    sendEnd: formatHHMM(win.endMin),
    /** Sempre 1: nunca postar em vários grupos no mesmo minuto. */
    maxGroupsPerWave: 1,
    interGroupGapSec: interGap,
    /** Intervalo efetivo entre posts do MESMO grupo (minutos). */
    groupIntervalMin: Math.round(minDelaySec / 60),
    weekdayDayLimit: clampInt(
      Number(getSetting("send_weekday_day_limit", "90")),
      8,
      200,
      90,
    ),
    weekendDayLimit: clampInt(
      Number(getSetting("send_weekend_day_limit", "70")),
      8,
      200,
      70,
    ),
    sundayDayLimit: clampInt(
      Number(getSetting("send_sunday_day_limit", "45")),
      8,
      200,
      45,
    ),
    weekdayHourLimit: clampInt(
      Number(getSetting("send_weekday_hour_limit", "16")),
      2,
      24,
      12,
    ),
    weekendHourLimit: clampInt(
      Number(getSetting("send_weekend_hour_limit", "12")),
      2,
      24,
      12,
    ),
    weekdayStart: getSetting("send_weekday_start", "09:30"),
    weekdayEnd: getSetting("send_weekday_end", "21:30"),
    weekendStart: getSetting("send_weekend_start", "10:00"),
    weekendEnd: getSetting("send_weekend_end", "20:00"),
    warmupEnabled: warmupOn,
    intervalMinSec: minDelaySec,
    intervalMaxSec: maxDelaySec,
  };
}

/** Intervalo do grupo alinhado à cadência (ignora 45 min legado se maior). */
export function effectiveGroupIntervalMin(group?: {
  interval_minutes?: number | null;
}): number {
  const cadence = getCadence();
  const raw = Number(group?.interval_minutes);
  if (Number.isFinite(raw) && raw > 0 && raw <= cadence.groupIntervalMin + 2) {
    return Math.max(raw, cadence.groupIntervalMin);
  }
  // 45+ legado ou vazio → usa cadência (12–20 min na semana 1)
  return cadence.groupIntervalMin;
}

/** Próximo instante em que um envio pode sair (janela 9h30–21h30 + intervalo do grupo). */
export function estimateNextSendAt(opts?: {
  lastPostedAt?: string | null;
  intervalMinutes?: number;
  fromMs?: number;
}): Date {
  const cadence = getCadence();
  const from = opts?.fromMs ?? Date.now();
  const last = opts?.lastPostedAt ? Date.parse(opts.lastPostedAt) : NaN;
  const gap = Math.max(
    (opts?.intervalMinutes || cadence.groupIntervalMin) * 60_000,
    cadence.minDelaySec * 1000,
  );
  let t = Number.isFinite(last) ? Math.max(from, last + gap) : from;
  if (inQuietHours(new Date(t))) {
    t += msUntilQuietEnds(new Date(t));
  }
  return new Date(t);
}

/** Libera cooldown de onda (envio manual pelo painel). */
export function clearWaveCooldown(): void {
  setSetting("last_wave_at", "");
  logAntiBan("wave_cooldown_cleared", "envio manual");
}

export function hashMessage(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export type GroupCadenceStat = {
  id: number;
  name: string;
  categories: string;
  dayCount: number;
  dayLimit: number;
  hourCount: number;
  hourLimit: number;
  lastPostedAt: string | null;
  nextAt: string | null;
};

function activeGroupsForStats(): WaGroup[] {
  return getDb()
    .prepare("SELECT * FROM wa_groups WHERE active = 1 ORDER BY id ASC")
    .all() as WaGroup[];
}

/** Teto diário deste grupo (editável no painel; 0 = meta por família / cadência). */
export function groupDayLimit(group?: {
  categories?: string | null;
  day_limit?: number | null;
}): number {
  const cadence = getCadence();
  const custom = Number(group?.day_limit);
  if (Number.isFinite(custom) && custom >= 8) {
    return clampInt(custom, 8, 200, custom);
  }
  const cats = String(group?.categories || "").toLowerCase();
  if (/(^|,)\s*tcg\s*(,|$)/.test(cats)) {
    const tcgCap = getSettingNum("tcg_day_limit", 45, 8, 200);
    return cadence.sunday
      ? Math.min(tcgCap, getSettingNum("send_sunday_day_limit", 45, 8, 200))
      : tcgCap;
  }
  if (/eletronicos|celulares|informatica|eletrodomesticos/.test(cats)) {
    const elec = getSettingNum("electronics_day_limit", 55, 8, 200);
    return cadence.sunday
      ? Math.min(elec, getSettingNum("send_sunday_day_limit", 45, 8, 200))
      : elec;
  }
  if (/(^|,)\s*geral\s*(,|$)/.test(cats) || /achadinhos/.test(cats)) {
    const ach = getSettingNum("achadinhos_day_limit", 90, 8, 200);
    return cadence.sunday
      ? Math.min(ach, getSettingNum("send_sunday_day_limit", 45, 8, 200))
      : ach;
  }
  return cadence.dayLimit;
}

export function getGroupCadenceStats(): GroupCadenceStat[] {
  const cadence = getCadence();
  const dayFrom = isoSinceBrazilMidnight();
  const hourFrom = hoursAgoIso(1);
  return activeGroupsForStats().map((g) => {
    const dayCount = countSendsSince(dayFrom, { groupId: g.id });
    const hourCount = countSendsSince(hourFrom, { groupId: g.id });
    const interval = effectiveGroupIntervalMin(g);
    const next = estimateNextSendAt({
      lastPostedAt: g.last_posted_at,
      intervalMinutes: interval,
    });
    return {
      id: g.id,
      name: g.name,
      categories: g.categories,
      dayCount,
      dayLimit: groupDayLimit(g),
      hourCount,
      hourLimit: cadence.hourLimit,
      lastPostedAt: g.last_posted_at,
      nextAt: next.toISOString(),
    };
  });
}

export function getAntiBanStatus() {
  const cadence = getCadence();
  const dayFrom = isoSinceBrazilMidnight();
  const hourFrom = hoursAgoIso(1);
  const groups = getGroupCadenceStats();
  const dayCount = groups.reduce((a, g) => a + g.dayCount, 0);
  const hourCount = countSendsSince(hourFrom);
  const dayLimitTotal = cadence.dayLimit * Math.max(groups.length, 1);
  const pausedUntil = getSetting("paused_until", "");
  const paused = pausedUntil !== "" && Date.parse(pausedUntil) > Date.now();
  const blockUntil = getSetting("block_pause_until", "");
  const blockPaused = blockUntil !== "" && Date.parse(blockUntil) > Date.now();

  return {
    hourCount,
    dayCount,
    /** Limite por grupo (o que importa na cadência). */
    dayLimit: cadence.dayLimit,
    dayLimitPerGroup: cadence.dayLimit,
    dayLimitTotal,
    hourLimit: cadence.hourLimit,
    hourLimitPerGroup: cadence.hourLimit,
    warmupDay: cadence.day,
    inWarmup: cadence.day < 14,
    weekLabel: cadence.weekLabel,
    sunday: cadence.sunday,
    weekend: cadence.weekend,
    quietHours: inQuietHours(),
    sendWindow: `${cadence.sendStart}–${cadence.sendEnd}`,
    paused: paused || blockPaused,
    pausedUntil: paused ? pausedUntil : blockPaused ? blockUntil : null,
    minDelaySec: cadence.minDelaySec,
    maxDelaySec: cadence.maxDelaySec,
    globalGapSec: cadence.interGroupGapSec,
    maxGroupsPerWave: 1,
    cooldownAfterWaveMin: Math.round(cadence.minDelaySec / 60),
    perGroup: true,
    groups,
    remainingToday: groups.map((g) => ({
      id: g.id,
      name: g.name,
      remaining: Math.max(0, g.dayLimit - g.dayCount),
    })),
    settings: {
      weekdayStart: cadence.weekdayStart,
      weekdayEnd: cadence.weekdayEnd,
      weekendStart: cadence.weekendStart,
      weekendEnd: cadence.weekendEnd,
      weekdayDayLimit: cadence.weekdayDayLimit,
      weekendDayLimit: cadence.weekendDayLimit,
      sundayDayLimit: cadence.sundayDayLimit,
      weekdayHourLimit: cadence.weekdayHourLimit,
      weekendHourLimit: cadence.weekendHourLimit,
      warmupEnabled: cadence.warmupEnabled,
      intervalMinMinutes: Math.round(cadence.minDelaySec / 60),
      intervalMaxMinutes: Math.round(cadence.maxDelaySec / 60),
      interGroupDelaySec: cadence.interGroupGapSec,
      tcgDayLimit: getSettingNum("tcg_day_limit", 45, 8, 200),
      electronicsDayLimit: getSettingNum("electronics_day_limit", 55, 8, 200),
      achadinhosDayLimit: getSettingNum("achadinhos_day_limit", 90, 8, 200),
      warmupWeek1Cap: getSettingNum("warmup_week1_cap", 40, 8, 200),
    },
    /** Regras alinhadas a ML + WhatsApp (anti-spam / anti-ban). */
    rules: {
      waWindow: `${cadence.sendStart}–${cadence.sendEnd} Brasília`,
      waWeekdayWindow: `${cadence.weekdayStart}–${cadence.weekdayEnd}`,
      waWeekendWindow: `${cadence.weekendStart}–${cadence.weekendEnd}`,
      waPerGroupDay: cadence.dayLimit,
      waWeekdayDay: cadence.weekdayDayLimit,
      waWeekendDay: cadence.weekendDayLimit,
      waSundayDay: cadence.sundayDayLimit,
      waIntervalMin: `${Math.round(cadence.minDelaySec / 60)}–${Math.round(cadence.maxDelaySec / 60)} min`,
      waGlobalGapSec: cadence.interGroupGapSec,
      waPostsPerWave: 1,
      waInterleave: "1 grupo a cada ~60s — nunca no mesmo minuto",
      mlCreateLinkDelayMs: "6500–10000",
      mlSyncMaxPerCycle: 24,
      mlAutoSyncDefault: "off",
      mlListPushSeparateFromCreateLink: true,
    },
  };
}

export function pauseSending(minutes: number, reason: string): void {
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  setSetting("paused_until", until);
  logAntiBan("pause", `${reason} | até ${until}`);
}

export function clearPause(): void {
  setSetting("paused_until", "");
  setSetting("block_pause_until", "");
  logAntiBan("resume", "pausa removida manualmente");
}

export function isDuplicateTextRecent(messageHash: string): boolean {
  const since = minutesAgoIso(config.antiBan.sameTextCooldownMin);
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM post_logs
       WHERE ok = 1 AND message_hash = ? AND created_at >= ?`,
    )
    .get(messageHash, since) as { c: number };
  return row.c > 0;
}

export function canSendNow(opts?: {
  messageHash?: string;
  groupsInWave?: number;
  /** Envio manual pelo painel: ignora cooldown de onda e usa delay menor */
  manual?: boolean;
  /** Limites diário/hora aplicados a este grupo */
  groupId?: number;
  /**
   * Já passou pelo gate da onda — não rechecar last_wave_at
   * (evita o bug de markWaveStarted → bloqueio imediato).
   */
  withinWave?: boolean;
  /** Cupom novo da categoria: ignora gap global (posta na hora na janela). */
  priorityCoupon?: boolean;
  /** Jitter curto entre posts da mesma onda */
  shortDelay?: boolean;
  /** Rajada após anúncio de cupom: várias ofertas do mesmo código */
  couponBurst?: boolean;
}): AntiBanDecision {
  const status = getAntiBanStatus();
  const cadence = getCadence();
  const manual = Boolean(opts?.manual);
  const withinWave = Boolean(opts?.withinWave);
  const priorityCoupon = Boolean(opts?.priorityCoupon);
  const couponBurst = Boolean(opts?.couponBurst);
  const groupId = opts?.groupId;

  if (status.paused && status.pausedUntil) {
    return {
      allow: false,
      reason: "Envio pausado pelo anti-ban",
      retryAfterMs: Math.max(0, Date.parse(status.pausedUntil) - Date.now()),
    };
  }

  if (status.quietHours && !manual) {
    logAntiBan(
      "block_quiet",
      `fora da janela ${cadence.sendStart}–${cadence.sendEnd} BR`,
    );
    return {
      allow: false,
      reason: `Fora da janela de envio (${cadence.sendStart}–${cadence.sendEnd} Brasília)`,
      retryAfterMs: msUntilQuietEnds(),
    };
  }

  if (
    !manual &&
    getSetting("holiday_silence", "1") === "1" &&
    isBrazilHoliday()
  ) {
    const name = brazilHolidayName() || "feriado";
    return {
      allow: false,
      reason: `Feriado (${name}) — só Enviar agora`,
      retryAfterMs: 60 * 60_000,
    };
  }

  const dayFrom = isoSinceBrazilMidnight();
  const hourFrom = hoursAgoIso(1);

  if (groupId != null) {
    const gRow = getDb()
      .prepare(`SELECT categories, day_limit FROM wa_groups WHERE id = ?`)
      .get(groupId) as { categories?: string; day_limit?: number } | undefined;
    const cap = groupDayLimit(gRow) + (couponBurst ? 4 : 0);
    const gDay = countSendsSince(dayFrom, { groupId });
    const gHour = countSendsSince(hourFrom, { groupId });
    if (!couponBurst && gHour >= cadence.hourLimit) {
      logAntiBan("block_hour_group", `group=${groupId} ${gHour}/${cadence.hourLimit}`);
      return {
        allow: false,
        reason: `Limite por hora neste grupo (${gHour}/${cadence.hourLimit})`,
        retryAfterMs: 15 * 60_000,
      };
    }
    if (gDay >= cap) {
      logAntiBan("block_day_group", `group=${groupId} ${gDay}/${cap}`);
      return {
        allow: false,
        reason: `Limite diário neste grupo (${gDay}/${cap} — ${cadence.weekLabel})`,
        retryAfterMs: 60 * 60_000,
      };
    }
  }

  // Gap entre grupos: 1 min (configurável). Nunca 2 grupos no mesmo minuto civil.
  const gapSec = globalInterGroupGapSec();
  const lastWaveAt = getSetting("last_wave_at", "");
  const globalGapMs = gapSec * 1000;
  if (
    !manual &&
    !withinWave &&
    !priorityCoupon &&
    !couponBurst &&
    lastWaveAt
  ) {
    const lastMs = Date.parse(lastWaveAt);
    const elapsed = Date.now() - lastMs;
    const sameMinute =
      Number.isFinite(lastMs) &&
      Math.floor(Date.now() / 60_000) === Math.floor(lastMs / 60_000);
    if (sameMinute || elapsed < globalGapMs) {
      const remaining = sameMinute
        ? 60_000 - (Date.now() % 60_000) + 500
        : globalGapMs - elapsed;
      return {
        allow: false,
        reason: sameMinute
          ? "Aguardando próximo minuto (intercalação entre grupos)"
          : `Aguardando intervalo entre grupos (~${gapSec}s)`,
        retryAfterMs: Math.max(remaining, 2_000),
      };
    }
  }

  const groupsInWave = opts?.groupsInWave ?? 1;
  if (groupsInWave > 1) {
    return {
      allow: false,
      reason: "Só 1 grupo por vez — intercalação a cada ~1 min (anti-ban)",
    };
  }

  if (opts?.messageHash && isDuplicateTextRecent(opts.messageHash)) {
    logAntiBan("block_duplicate", opts.messageHash);
    return {
      allow: false,
      reason: "Texto idêntico enviado recentemente (cooldown de variação)",
      retryAfterMs: 30 * 60_000,
    };
  }

  // Pausa aleatória a cada ~5 envios OK (não conta ondas vazias)
  const sinceBlock = Number(getSetting("sends_in_block", "0")) || 0;
  if (!manual && !priorityCoupon && !couponBurst && !withinWave && sinceBlock > 0 && sinceBlock % 5 === 0) {
    const extraMin = randomBetween(12, 22);
    const until = new Date(Date.now() + extraMin * 60_000).toISOString();
    setSetting("block_pause_until", until);
    setSetting("sends_in_block", "0");
    logAntiBan("block_pause", `pausa de bloco ${extraMin} min`);
    return {
      allow: false,
      reason: `Pausa aleatória entre blocos (~${extraMin} min)`,
      retryAfterMs: extraMin * 60_000,
    };
  }

  // Delay: jitter humano curto. O intervalo 12–20 min é o gap do grupo (last_posted_at).
  let delayMs = manual || priorityCoupon
    ? randomBetween(3, 8) * 1000
    : randomBetween(6, 28) * 1000;
  if (couponBurst || opts?.shortDelay) {
    delayMs = randomBetween(7, 12) * 1000;
  }
  const last3 = getDb()
    .prepare(`SELECT ok FROM post_logs ORDER BY id DESC LIMIT 3`)
    .all() as Array<{ ok: number }>;
  if (!manual && last3.length === 3 && last3.every((r) => r.ok === 1)) {
    delayMs += randomBetween(8, 20) * 1000;
  }

  return { allow: true, delayMs };
}

export function noteHttpBlockError(status: number, detail: string): void {
  if (status !== 403 && status !== 429) return;
  logAntiBan(`http_${status}`, detail);
  const n = (Number(getSetting("http_block_streak", "0")) || 0) + 1;
  setSetting("http_block_streak", String(n));
  const after = getSettingNum("http_block_pause_after", 3, 2, 10);
  if (n >= after) {
    pauseSending(45, `${n} erros ${status} seguidos`);
    setSetting("http_block_streak", "0");
  }
}

export function clearHttpBlockStreak(): void {
  setSetting("http_block_streak", "0");
}

/** Registra envio OK — atualiza cooldown global e contador de bloco. */
export function markWaveStarted(groupCount: number): void {
  setSetting("last_wave_at", new Date().toISOString());
  setSetting("wave_count", String(groupCount));
  const n = (Number(getSetting("sends_in_block", "0")) || 0) + 1;
  setSetting("sends_in_block", String(n));
  logAntiBan("wave_start", `${groupCount} destino(s)`);
}

/** Marca só o horário da onda sem incrementar bloco (onda sem envio). */
export function touchWaveClock(): void {
  setSetting("last_wave_at", new Date().toISOString());
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Alinha interval_minutes legado (45) à cadência atual. */
export function alignGroupIntervalsToCadence(): number {
  const cadence = getCadence();
  const target = cadence.groupIntervalMin;
  const info = getDb()
    .prepare(
      `UPDATE wa_groups
       SET interval_minutes = ?
       WHERE active = 1 AND interval_minutes > ?`,
    )
    .run(target, target + 2);
  if (info.changes > 0) {
    logAntiBan(
      "align_intervals",
      `${info.changes} grupo(s) → ${target} min (cadência ${cadence.weekLabel})`,
    );
  }
  return info.changes;
}

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function saveCadenceSettings(input: {
  weekdayStart?: string;
  weekdayEnd?: string;
  weekendStart?: string;
  weekendEnd?: string;
  weekdayDayLimit?: number;
  weekendDayLimit?: number;
  sundayDayLimit?: number;
  weekdayHourLimit?: number;
  weekendHourLimit?: number;
  warmupEnabled?: boolean;
  intervalMinMinutes?: number;
  intervalMaxMinutes?: number;
  warmupWeek1Cap?: number;
}): ReturnType<typeof getCadence> {
  const setTime = (key: string, raw: unknown, fallback: string) => {
    const v = String(raw || "").trim();
    setSetting(key, HHMM_RE.test(v) ? v : fallback);
  };
  if (input.weekdayStart != null) {
    setTime("send_weekday_start", input.weekdayStart, "09:30");
  }
  if (input.weekdayEnd != null) {
    setTime("send_weekday_end", input.weekdayEnd, "21:30");
  }
  if (input.weekendStart != null) {
    setTime("send_weekend_start", input.weekendStart, "10:00");
  }
  if (input.weekendEnd != null) {
    setTime("send_weekend_end", input.weekendEnd, "20:00");
  }
  if (input.weekdayDayLimit != null) {
    setSetting(
      "send_weekday_day_limit",
      String(clampInt(Number(input.weekdayDayLimit), 8, 200, 90)),
    );
  }
  if (input.weekendDayLimit != null) {
    setSetting(
      "send_weekend_day_limit",
      String(clampInt(Number(input.weekendDayLimit), 8, 200, 70)),
    );
  }
  if (input.sundayDayLimit != null) {
    setSetting(
      "send_sunday_day_limit",
      String(clampInt(Number(input.sundayDayLimit), 8, 200, 45)),
    );
  }
  if (input.weekdayHourLimit != null) {
    setSetting(
      "send_weekday_hour_limit",
      String(clampInt(Number(input.weekdayHourLimit), 2, 24, 16)),
    );
  }
  if (input.weekendHourLimit != null) {
    setSetting(
      "send_weekend_hour_limit",
      String(clampInt(Number(input.weekendHourLimit), 2, 24, 12)),
    );
  }
  if (input.warmupEnabled != null) {
    setSetting("cadence_warmup", input.warmupEnabled ? "1" : "0");
  }
  if (input.warmupWeek1Cap != null) {
    setSetting(
      "warmup_week1_cap",
      String(clampInt(Number(input.warmupWeek1Cap), 8, 200, 40)),
    );
  }
  if (input.intervalMinMinutes != null || input.intervalMaxMinutes != null) {
    const minMinutes =
      input.intervalMinMinutes != null
        ? clampInt(Number(input.intervalMinMinutes), 3, 30, 5)
        : clampInt(
            Math.round(Number(getSetting("cadence_interval_min_sec", "300")) / 60),
            3,
            30,
            5,
          );
    const maxMinutes =
      input.intervalMaxMinutes != null
        ? clampInt(Number(input.intervalMaxMinutes), 4, 40, 7)
        : clampInt(
            Math.round(Number(getSetting("cadence_interval_max_sec", "420")) / 60),
            4,
            40,
            7,
          );
    const lo = Math.min(minMinutes, maxMinutes);
    const hi = Math.max(minMinutes, maxMinutes);
    setSetting("cadence_interval_min_sec", String(lo * 60));
    setSetting("cadence_interval_max_sec", String(hi * 60));
    setSetting("cadence_interval_locked", "1");
  }
  logAntiBan("cadence_saved", JSON.stringify(getCadence()));
  return getCadence();
}
