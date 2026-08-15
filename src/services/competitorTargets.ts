/**
 * Metas diárias alinhadas aos concorrentes BR + pedido do operador:
 * Achadinhos ~70–90; TCG e Eletrônicos bem acima dos 12–20 / 25–40 iniciais.
 */
import { getDb, getSetting, getSettingNum, setSetting } from "../db/index.js";
import { brazilWeekday, isoSinceBrazilMidnight } from "./timeBr.js";

export const TARGETS = {
  achadinhos: 90,
  tcg: 45,
  eletronicos: 55,
  weekdayGlobal: 90,
  weekendGlobal: 70,
  sundayGlobal: 45,
  interGroupDelaySec: 60,
  maxGroupsPerWave: 1,
  weekdayHour: 16,
  weekendHour: 12,
} as const;

export function categoryFamily(
  categories?: string | null,
): "tcg" | "eletronicos" | "achadinhos" | "other" {
  const c = String(categories || "").toLowerCase();
  if (/(^|,)\s*tcg\s*(,|$)/.test(c)) return "tcg";
  if (/eletronicos|celulares|informatica|eletrodomesticos/.test(c)) {
    return "eletronicos";
  }
  if (/(^|,)\s*geral\s*(,|$)/.test(c) || /achadinhos/.test(c)) {
    return "achadinhos";
  }
  return "other";
}

/** Teto diário sugerido por família (antes do override do grupo). */
export function familyDayLimit(family: ReturnType<typeof categoryFamily>): number {
  const sunday = brazilWeekday() === 0;
  const half = (n: number) => Math.max(8, Math.round(n * 0.5));
  if (family === "tcg") {
    const base = getSettingNum("tcg_day_limit", TARGETS.tcg, 8, 200);
    return sunday ? Math.min(base, half(base)) : base;
  }
  if (family === "eletronicos") {
    const base = getSettingNum(
      "electronics_day_limit",
      TARGETS.eletronicos,
      8,
      200,
    );
    return sunday ? Math.min(base, half(base)) : base;
  }
  if (family === "achadinhos") {
    const base = getSettingNum(
      "achadinhos_day_limit",
      TARGETS.achadinhos,
      8,
      200,
    );
    return sunday ? Math.min(base, half(base)) : base;
  }
  return getSettingNum("send_weekday_day_limit", TARGETS.weekdayGlobal, 8, 200);
}

/** Buffer mínimo da fila = 3× meta diária da família. */
export function queueBufferTarget(family: ReturnType<typeof categoryFamily>): number {
  return familyDayLimit(family) * 3;
}

export function postsRemainingToday(groupId: number): {
  sent: number;
  limit: number;
  remaining: number;
} {
  const g = getDb()
    .prepare(`SELECT categories, day_limit FROM wa_groups WHERE id = ?`)
    .get(groupId) as { categories?: string; day_limit?: number } | undefined;
  const custom = Number(g?.day_limit);
  const limit =
    Number.isFinite(custom) && custom >= 8
      ? custom
      : familyDayLimit(categoryFamily(g?.categories));
  const dayFrom = isoSinceBrazilMidnight();
  const sent = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM post_logs
         WHERE ok = 1 AND group_id = ? AND created_at >= ?`,
      )
      .get(groupId, dayFrom) as { c: number }
  ).c;
  return { sent, limit, remaining: Math.max(0, limit - sent) };
}

export function competitorVolumePanel() {
  const groups = getDb()
    .prepare(
      `SELECT id, name, categories, day_limit, last_posted_at FROM wa_groups WHERE active = 1 ORDER BY id`,
    )
    .all() as Array<{
    id: number;
    name: string;
    categories: string;
    day_limit: number;
    last_posted_at: string | null;
  }>;

  return {
    competitorBench: {
      willGarimpou: "60–90/dia",
      clubeDoRei: "60–90/dia",
      reiTcg: "5–15/dia histórico — nossa meta TCG é bem maior",
    },
    ourTargets: {
      achadinhos: getSettingNum("achadinhos_day_limit", TARGETS.achadinhos, 8, 200),
      tcg: getSettingNum("tcg_day_limit", TARGETS.tcg, 8, 200),
      eletronicos: getSettingNum(
        "electronics_day_limit",
        TARGETS.eletronicos,
        8,
        200,
      ),
      interGroupDelaySec: getSettingNum(
        "post_inter_group_delay_sec",
        TARGETS.interGroupDelaySec,
        45,
        180,
      ),
      maxGroupsPerWave: getSettingNum("post_max_groups_per_wave", 1, 1, 1),
    },
    groups: groups.map((g) => {
      const fam = categoryFamily(g.categories);
      const rem = postsRemainingToday(g.id);
      return {
        id: g.id,
        name: g.name,
        family: fam,
        dayLimit: rem.limit,
        sentToday: rem.sent,
        remainingToday: rem.remaining,
        bufferTarget: queueBufferTarget(fam),
        lastPostedAt: g.last_posted_at,
      };
    }),
  };
}

/** Migração única: sobe metas + força intercalação 1 min. */
export function applyCadenceInterleaveBump(): void {
  if (getSetting("cadence_interleave_v2", "") === "1") return;
  const up = (k: string, v: string) => setSetting(k, v);
  up("post_max_groups_per_wave", "1");
  up("post_inter_group_delay_sec", "60");
  up("send_weekday_day_limit", String(TARGETS.weekdayGlobal));
  up("send_weekend_day_limit", String(TARGETS.weekendGlobal));
  up("send_sunday_day_limit", String(TARGETS.sundayGlobal));
  up("send_weekday_hour_limit", String(TARGETS.weekdayHour));
  up("send_weekend_hour_limit", String(TARGETS.weekendHour));
  up("tcg_day_limit", String(TARGETS.tcg));
  up("electronics_day_limit", String(TARGETS.eletronicos));
  up("achadinhos_day_limit", String(TARGETS.achadinhos));
  up("ml_list_target_tcg", "40");
  up("ml_list_target_eletronicos", "36");
  up("ml_list_target_geral", "48");
  up("sync_quota_tcg", "12");
  up("sync_quota_electronics", "12");
  // Intervalo mesmo grupo: 3–5 pico / 7–10 off → base 4–8 min
  up("cadence_interval_min_sec", "240");
  up("cadence_interval_max_sec", "480");
  up("cadence_interval_locked", "1");
  up("cadence_warmup", "0");

  const db = getDb();
  db.prepare(
    `UPDATE wa_groups SET day_limit = ? WHERE active = 1 AND categories LIKE '%tcg%'`,
  ).run(TARGETS.tcg);
  db.prepare(
    `UPDATE wa_groups SET day_limit = ?
     WHERE active = 1
       AND (categories LIKE '%eletronicos%' OR categories LIKE '%celulares%')
       AND categories NOT LIKE '%tcg%'`,
  ).run(TARGETS.eletronicos);
  db.prepare(
    `UPDATE wa_groups SET day_limit = ?
     WHERE active = 1
       AND (categories LIKE '%geral%' OR categories LIKE '%achadinhos%')
       AND categories NOT LIKE '%tcg%'
       AND categories NOT LIKE '%eletronicos%'`,
  ).run(TARGETS.achadinhos);

  up("cadence_interleave_v2", "1");
}
