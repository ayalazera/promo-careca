import { getDb } from "../db/index.js";

export function couponConversionRanking(days = 30): Array<{
  coupon: string;
  posts: number;
  fails: number;
  testsOk: number;
  testsFail: number;
}> {
  return getDb()
    .prepare(
      `SELECT
         UPPER(TRIM(d.coupon)) AS coupon,
         SUM(CASE WHEN pl.ok = 1 THEN 1 ELSE 0 END) AS posts,
         SUM(CASE WHEN pl.ok = 0 THEN 1 ELSE 0 END) AS fails,
         (SELECT COUNT(*) FROM coupon_tests ct
           WHERE UPPER(TRIM(ct.coupon)) = UPPER(TRIM(d.coupon)) AND ct.ok = 1
             AND ct.created_at >= datetime('now', ?)) AS testsOk,
         (SELECT COUNT(*) FROM coupon_tests ct
           WHERE UPPER(TRIM(ct.coupon)) = UPPER(TRIM(d.coupon)) AND ct.ok = 0
             AND ct.created_at >= datetime('now', ?)) AS testsFail
       FROM post_logs pl
       JOIN deals d ON d.id = pl.deal_id
       WHERE d.coupon IS NOT NULL AND TRIM(d.coupon) != ''
         AND pl.created_at >= datetime('now', ?)
       GROUP BY UPPER(TRIM(d.coupon))
       ORDER BY posts DESC, testsOk DESC, fails ASC
       LIMIT 15`,
    )
    .all(
      `-${Math.max(7, days)} days`,
      `-${Math.max(7, days)} days`,
      `-${Math.max(7, days)} days`,
    ) as Array<{
    coupon: string;
    posts: number;
    fails: number;
    testsOk: number;
    testsFail: number;
  }>;
}

export function weeklyTopPosts(limit = 10): Array<{
  id: number;
  title: string;
  coupon: string | null;
  category: string;
  sent: number;
  lastAt: string;
  headlineVariant?: string | null;
}> {
  return getDb()
    .prepare(
      `SELECT d.id, d.title, d.coupon, d.category,
              COUNT(*) AS sent, MAX(pl.created_at) AS lastAt,
              MAX(pl.headline_variant) AS headlineVariant
       FROM post_logs pl
       JOIN deals d ON d.id = pl.deal_id
       WHERE pl.ok = 1 AND pl.created_at >= datetime('now', '-7 days')
       GROUP BY d.id
       ORDER BY sent DESC, lastAt DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: number;
    title: string;
    coupon: string | null;
    category: string;
    sent: number;
    lastAt: string;
    headlineVariant?: string | null;
  }>;
}

export function monthlyAudit(): {
  sent: number;
  blocked: number;
  dayAvg: number;
  blockRate: number;
  vsCompetitorNote: string;
} {
  const sent = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM post_logs
         WHERE ok = 1 AND created_at >= datetime('now', '-30 days')`,
      )
      .get() as { c: number }
  ).c;
  const blocked = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM post_logs
         WHERE ok = 0 AND created_at >= datetime('now', '-30 days')`,
      )
      .get() as { c: number }
  ).c;
  const pauses = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM antiban_events
         WHERE event_type IN ('pause','block_pause','http_403','http_429')
           AND created_at >= datetime('now', '-30 days')`,
      )
      .get() as { c: number }
  ).c;
  const total = sent + blocked;
  const dayAvg = Math.round((sent / 30) * 10) / 10;
  const blockRate = total ? Math.round((blocked / total) * 100) : 0;
  let vsCompetitorNote =
    "Metas Careca: Achadinhos ~90 · TCG ~45 · Eletrônicos ~55 · intercalação 1 grupo/min.";
  if (dayAvg > 100) {
    vsCompetitorNote =
      "Volume muito alto vs concorrentes — monitore ban. Intercalação 1 min é obrigatória.";
  } else if (pauses >= 8) {
    vsCompetitorNote =
      "Muitas pausas no mês. Prefira menos posts a insistir no horário ruim.";
  }
  return { sent, blocked, dayAvg, blockRate, vsCompetitorNote };
}
