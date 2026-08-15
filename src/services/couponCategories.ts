/**
 * Mapa cupom digitável → categorias de produto/grupo.
 * Array vazio = cupom geral (qualquer categoria / todos os grupos).
 *
 * Ciclo de foco por grupo:
 * 1) Anunciou cupom válido → fila só com esse código
 * 2) Continua até esgotar
 * 3) Avisa esgotado → libera → promove próximo da espera (se houver)
 */
import { getDb, getSetting, setSetting } from "../db/index.js";

/** SEMPRENAMODA é o mesmo cupom de moda que SEMPREMODA. */
export function canonicalCouponCode(code: string | null | undefined): string {
  const c = String(code || "").trim().toUpperCase();
  if (c === "SEMPRENAMODA") return "SEMPREMODA";
  return c;
}

export function couponCodesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const x = canonicalCouponCode(a);
  const y = canonicalCouponCode(b);
  return Boolean(x && y && x === y);
}

export function couponTargetCategories(coupon: {
  code?: string | null;
  title?: string;
  subtitle?: string | null;
  verticalHint?: string | null;
  sampleTitles?: string[];
}): string[] {
  const code = String(coupon.code || "").toUpperCase();
  const hay = [
    coupon.title,
    coupon.subtitle,
    coupon.verticalHint,
    ...(coupon.sampleTitles || []),
  ]
    .join(" ")
    .toLowerCase();

  if (
    code === "BRINQUEDOS" ||
    /pokemon|pokémon|tcg|carta colecion|yu-gi|magic the|booster/.test(hay)
  ) {
    return ["tcg", "brinquedos", "games"];
  }
  if (/^LIBROS|^LIVROS|^LEITOR|^JOGOS|^GAMES/i.test(code)) {
    return ["games", "brinquedos", "tcg", "geral"];
  }
  if (
    /dia do leitor|livros selecionados|jogos selecionados|com libros/i.test(hay)
  ) {
    return ["games", "brinquedos", "geral"];
  }
  if (
    code === "SEMPREMODA" ||
    code === "SEMPRENAMODA" ||
    /moda|fashion|calçado|calcado|roupa/.test(hay)
  ) {
    return ["moda"];
  }
  if (
    code === "COMPRINHASPRACASA" ||
    code === "PREFERIDO" ||
    code === "TECHEMCASA" ||
    /\bcasa\b|decor|móve|moveis|cozinha|enxoval/.test(hay)
  ) {
    return ["casa"];
  }
  if (
    code === "CASAINTELIGENTE" ||
    /casa inteligente|smart home|eletr[oô]nic.*casa/i.test(hay)
  ) {
    return ["eletronicos", "eletrodomesticos", "casa"];
  }
  if (
    code === "APROVEITA" ||
    code === "CORREPROMELI" ||
    code === "CORREPRAPROMO" ||
    /suplemento|alimento|diversos|selecionados/i.test(hay)
  ) {
    return ["geral", "alimentos"];
  }
  if (code === "ECONOMIAML") {
    return [
      "eletronicos",
      "celulares",
      "informatica",
      "games",
      "eletrodomesticos",
    ];
  }
  if (
    code === "OFFMELI" ||
    /eletr[oô]nic|áudio|audio|informática|celular|fone/.test(hay)
  ) {
    return ["eletronicos", "celulares", "informatica"];
  }
  if (/tb_vertical|brinquedo|beb[eê]/.test(hay) && code !== "OFFMELI") {
    return ["tcg", "games", "bebes", "brinquedos"];
  }
  return [];
}

/** Cupom pode ir neste deal/categoria? Geral (targets vazio) → sim. */
export function couponAllowedForDealCategory(
  coupon: {
    code?: string | null;
    title?: string;
    subtitle?: string | null;
    verticalHint?: string | null;
    sampleTitles?: string[];
  },
  dealCategory: string,
): boolean {
  const targets = couponTargetCategories(coupon);
  if (!targets.length) return true;
  const cat = String(dealCategory || "geral").toLowerCase();
  return targets.includes(cat);
}

type WaitingRow = { code: string; campaignId: string; until: string };

function readWaitingQueue(groupId: number): WaitingRow[] {
  try {
    const parsed = JSON.parse(
      getSetting(`group_focus_wait_${groupId}`, "[]") || "[]",
    ) as WaitingRow[];
    const now = Date.now();
    return (Array.isArray(parsed) ? parsed : [])
      .map((r) => ({
        code: String(r.code || "").toUpperCase(),
        campaignId: String(r.campaignId || ""),
        until: String(r.until || ""),
      }))
      .filter((r) => {
        if (!r.code) return false;
        const t = r.until ? Date.parse(r.until) : NaN;
        return !Number.isFinite(t) || t > now;
      });
  } catch {
    return [];
  }
}

function writeWaitingQueue(groupId: number, rows: WaitingRow[]): void {
  setSetting(`group_focus_wait_${groupId}`, JSON.stringify(rows.slice(0, 8)));
}

/** Cupom exclusivo em foco neste grupo (um por vez). */
export function getGroupFocusCoupon(groupId: number): string | null {
  try {
    const focus = getSetting(`group_focus_coupon_${groupId}`, "").trim();
    if (!focus) return null;
    const untilRaw = getSetting(`group_focus_coupon_until_${groupId}`, "");
    const until = untilRaw ? Date.parse(untilRaw) : NaN;
    if (Number.isFinite(until) && until < Date.now()) {
      clearGroupFocusCoupon(groupId);
      return null;
    }
    return focus.toUpperCase();
  } catch {
    return null;
  }
}

/** Compat: sempre 0 ou 1 código (foco exclusivo). */
export function getGroupFocusCouponStack(groupId: number): string[] {
  const focus = getGroupFocusCoupon(groupId);
  return focus ? [focus] : [];
}

export function enqueueWaitingCoupon(
  groupId: number,
  code: string,
  campaignId: string,
  expiresAt?: string | null,
): void {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return;
  const until =
    expiresAt || new Date(Date.now() + 72 * 3600_000).toISOString();
  const rows = readWaitingQueue(groupId).filter((r) => r.code !== c);
  rows.push({ code: c, campaignId: String(campaignId || ""), until });
  writeWaitingQueue(groupId, rows);
}

export function peekWaitingCoupon(groupId: number): WaitingRow | null {
  return readWaitingQueue(groupId)[0] || null;
}

export function shiftWaitingCoupon(groupId: number): WaitingRow | null {
  const rows = readWaitingQueue(groupId);
  const next = rows.shift() || null;
  writeWaitingQueue(groupId, rows);
  return next;
}

/** Define o único cupom da fila até esgotar. */
export function pushGroupFocusCoupon(
  groupId: number,
  code: string,
  expiresAt?: string | null,
): void {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return;
  const until =
    expiresAt || new Date(Date.now() + 72 * 3600_000).toISOString();
  setSetting(`group_focus_coupon_${groupId}`, c);
  setSetting(`group_focus_coupon_until_${groupId}`, until);
  setSetting(
    `group_focus_stack_${groupId}`,
    JSON.stringify([{ code: c, until }]),
  );
}

export function clearGroupFocusCoupon(groupId: number, code?: string): void {
  const c = String(code || "").trim().toUpperCase();
  const focus = getSetting(`group_focus_coupon_${groupId}`, "")
    .trim()
    .toUpperCase();
  if (c && focus && focus !== c) {
    writeWaitingQueue(
      groupId,
      readWaitingQueue(groupId).filter((r) => r.code !== c),
    );
    return;
  }
  setSetting(`group_focus_coupon_${groupId}`, "");
  setSetting(`group_focus_coupon_until_${groupId}`, "");
  setSetting(`group_focus_stack_${groupId}`, "[]");
}

/** Foco ainda está ACTIVE / testado ok no catálogo? */
export function isGroupFocusCouponLive(groupId: number): boolean {
  const focus = getGroupFocusCoupon(groupId);
  if (!focus) return false;
  try {
    const row = getDb()
      .prepare(
        `SELECT status, tested_ok, expires_at FROM ml_coupons
         WHERE upper(trim(code)) = ? OR upper(trim(code)) = ?
         ORDER BY CASE WHEN upper(status)='ACTIVE' THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(focus, canonicalCouponCode(focus)) as
      | {
          status?: string;
          tested_ok?: number | null;
          expires_at?: string | null;
        }
      | undefined;
    if (!row) return true;
    if (row.tested_ok === 0) return false;
    if (String(row.status || "").toUpperCase() !== "ACTIVE") return false;
    if (row.expires_at) {
      const t = Date.parse(row.expires_at);
      if (Number.isFinite(t) && t < Date.now()) return false;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Cupons anunciados neste grupo — prioriza até expirar (ou 72h).
 * Inclui o foco explícito `group_focus_coupon_<id>` gravado no anúncio válido.
 */
export function recentAnnouncedCouponCodes(
  groupId: number,
  hours = 72,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const code = String(raw || "").trim().toUpperCase();
    if (!code || seen.has(code)) return;
    seen.add(code);
    out.push(code);
    const canon = canonicalCouponCode(code);
    if (canon !== code && !seen.has(canon)) {
      seen.add(canon);
      out.push(canon);
    }
  };
  try {
    const focus = getGroupFocusCoupon(groupId);
    if (focus) push(focus);
  } catch {
    /* ignore */
  }
  try {
    const rows = getDb()
      .prepare(
        `SELECT UPPER(TRIM(c.code)) AS code, c.expires_at AS expires_at
         FROM coupon_announcements a
         JOIN ml_coupons c ON c.campaign_id = a.campaign_id
         WHERE a.group_id = ?
           AND a.kind = 'valid'
           AND a.created_at >= datetime('now', ?)
           AND c.code IS NOT NULL AND TRIM(c.code) != ''
         ORDER BY a.created_at DESC
         LIMIT 8`,
      )
      .all(groupId, `-${Math.max(6, hours)} hours`) as Array<{
      code: string;
      expires_at?: string | null;
    }>;
    for (const r of rows) {
      if (r.expires_at) {
        const t = Date.parse(r.expires_at);
        if (Number.isFinite(t) && t < Date.now()) continue;
      }
      push(r.code);
    }
  } catch {
    /* ignore */
  }
  return out;
}
