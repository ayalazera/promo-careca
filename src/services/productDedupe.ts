/**
 * Evita republicar o mesmo produto (mesmo MLB ou título quase igual)
 * no mesmo grupo dentro de N dias.
 */
import { getDb, getSettingNum } from "../db/index.js";

/** Janela padrão de republicação (dias). */
export function repostCooldownDays(): number {
  return getSettingNum("repost_cooldown_days", 5, 2, 30);
}

/** Normaliza título para fingerprint (ignora cor/voltagem leve). */
export function productFingerprint(title: string): string {
  return String(title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(cor|color)\s+[a-z0-9\-]+/g, " ")
    .replace(/\b(preto|branco|azul|vermelho|cinza|verde|rosa|dourado|prata)\b/g, " ")
    .replace(/\b\d+([.,]\d+)?\s*(kg|g|ml|l|w|ah|v|cm|mm|un|unid)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function normalizeMlbId(raw: string | null | undefined): string {
  const s = String(raw || "").replace(/^hubauto-/i, "").toUpperCase();
  const m = s.match(/MLB-?\d+/);
  return m ? m[0].replace("-", "") : s.replace(/[^A-Z0-9]/g, "");
}

export type RepostBlock = {
  blocked: boolean;
  reason: string;
};

/** Já postou este deal / MLB / fingerprint no grupo recentemente? */
export function wasProductPostedRecently(
  groupId: number,
  opts: {
    dealId?: number | null;
    externalId?: string | null;
    title?: string | null;
    days?: number;
  },
): RepostBlock {
  const days = opts.days ?? repostCooldownDays();
  const since = `-${Math.max(2, days)} days`;

  if (opts.dealId) {
    const row = getDb()
      .prepare(
        `SELECT id FROM post_logs
         WHERE ok = 1 AND group_id = ? AND deal_id = ?
           AND reason = 'enviado'
           AND created_at >= datetime('now', ?)
         LIMIT 1`,
      )
      .get(groupId, opts.dealId, since) as { id: number } | undefined;
    if (row) {
      return {
        blocked: true,
        reason: `mesmo deal já postado neste grupo nos últimos ${days} dias`,
      };
    }
  }

  const mlb = normalizeMlbId(opts.externalId);
  if (mlb) {
    const row = getDb()
      .prepare(
        `SELECT pl.id FROM post_logs pl
         JOIN deals d ON d.id = pl.deal_id
         WHERE pl.ok = 1 AND pl.group_id = ? AND pl.reason = 'enviado'
           AND pl.created_at >= datetime('now', ?)
           AND (
             replace(upper(COALESCE(d.external_id,'')), 'HUBAUTO-', '') = ?
             OR replace(upper(COALESCE(d.external_id,'')), 'HUBAUTO-', '') LIKE ?
           )
         LIMIT 1`,
      )
      .get(groupId, since, mlb, `%${mlb}%`) as { id: number } | undefined;
    if (row) {
      return {
        blocked: true,
        reason: `mesmo MLB (${mlb}) já postado neste grupo nos últimos ${days} dias`,
      };
    }
  }

  const fp = productFingerprint(opts.title || "");
  if (fp.length >= 24) {
    // Compara fingerprints recentes do grupo (últimos posts enviados)
    const recent = getDb()
      .prepare(
        `SELECT d.title AS title FROM post_logs pl
         JOIN deals d ON d.id = pl.deal_id
         WHERE pl.ok = 1 AND pl.group_id = ? AND pl.reason = 'enviado'
           AND pl.created_at >= datetime('now', ?)
         ORDER BY pl.id DESC LIMIT 80`,
      )
      .all(groupId, since) as Array<{ title: string }>;
    for (const r of recent) {
      const other = productFingerprint(r.title);
      if (!other) continue;
      if (other === fp || other.includes(fp) || fp.includes(other)) {
        return {
          blocked: true,
          reason: `produto parecido já postado neste grupo nos últimos ${days} dias`,
        };
      }
      // overlap de tokens principais
      const a = new Set(fp.split(" ").filter((w) => w.length > 3));
      const b = new Set(other.split(" ").filter((w) => w.length > 3));
      if (a.size >= 4 && b.size >= 4) {
        let hit = 0;
        for (const w of a) if (b.has(w)) hit += 1;
        const ratio = hit / Math.min(a.size, b.size);
        if (ratio >= 0.85) {
          return {
            blocked: true,
            reason: `produto semelhante já postado neste grupo nos últimos ${days} dias`,
          };
        }
      }
    }
  }

  return { blocked: false, reason: "" };
}
