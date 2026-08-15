/**
 * Anuncia cupom VÁLIDO e cupom ESGOTADO nos grupos da categoria certa.
 * QUEROCUPONS (lista selecionada) vai ao Achadinhos, não a TCG/Eletrônicos.
 * BRINQUEDOS / TCG vai só aos grupos tcg.
 */
import {
  getDb,
  getSetting,
  setSetting,
  logAntiBan,
  type WaGroup,
} from "../db/index.js";
import { canSendNow, hashMessage, sleep } from "./antiBan.js";
import { parseList } from "./composer.js";
import { generateCouponBanner, groupLogoPath } from "./imageWatermark.js";
import {
  isDigitableCouponCode,
  type MlCoupon,
} from "./mlCoupons.js";
import {
  couponTargetCategories,
  couponAllowedForDealCategory,
  pushGroupFocusCoupon,
  clearGroupFocusCoupon,
  getGroupFocusCoupon,
  enqueueWaitingCoupon,
  shiftWaitingCoupon,
  isGroupFocusCouponLive,
  couponCodesMatch,
} from "./couponCategories.js";
import { isLowDemandNicheTitle } from "./demandFilter.js";
import { resolveGroupBrand } from "./groupBrand.js";
import { getWaStatus, sendGroupImage, sendGroupText } from "./whatsapp.js";

export type CouponKind = "valid" | "exhausted";
export { couponTargetCategories, couponAllowedForDealCategory };

function brl(value: number): string {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function ensureAnnounceTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS coupon_announcements (
      campaign_id TEXT NOT NULL,
      group_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (campaign_id, group_id, kind)
    );
  `);
}

function addCouponCols(): void {
  const cols = getDb()
    .prepare(`PRAGMA table_info(ml_coupons)`)
    .all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  const add = (name: string, ddl: string) => {
    if (have.has(name)) return;
    getDb().exec(`ALTER TABLE ml_coupons ADD COLUMN ${ddl}`);
  };
  add("tested_ok", "tested_ok INTEGER");
  add("tested_at", "tested_at TEXT");
  add("tested_detail", "tested_detail TEXT");
  add("last_announced_status", "last_announced_status TEXT");
  add("last_announced_at", "last_announced_at TEXT");
}

export function groupsForCouponCategories(categories: string[]): WaGroup[] {
  const active = getDb()
    .prepare(`SELECT * FROM wa_groups WHERE active = 1`)
    .all() as WaGroup[];
  if (!categories.length) {
    // Cupom de lista selecionada (QUEROCUPONS): só Achadinhos, não TCG/Eletrônicos.
    return active.filter((g) => parseList(g.categories || "").includes("geral"));
  }
  const matched = active.filter((g) => {
    const cats = parseList(g.categories || "geral");
    return cats.some((c) => categories.includes(c));
  });
  if (matched.length) return matched;
  // Sem grupo da categoria (ex.: não há grupo "casa"): só Achadinhos/geral.
  // Nunca espalhar cupom de casa/moda no grupo de Eletrônicos.
  return active.filter((g) => {
    const cats = parseList(g.categories || "");
    return cats.includes("geral");
  });
}

/** Categorias reais dos produtos em que o cupom já foi testado. */
export function harvestedCategoriesForCoupon(code: string): string[] {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return [];
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT lower(category) AS cat FROM deals
       WHERE upper(trim(coupon)) = ? AND coupon_status = 'valid'
         AND category IS NOT NULL AND trim(category) != ''`,
    )
    .all(c) as Array<{ cat: string }>;
  return rows.map((r) => r.cat).filter(Boolean);
}

export function groupsForCoupon(coupon: MlCoupon): WaGroup[] {
  const mapped = couponTargetCategories(coupon);
  if (mapped.length) return groupsForCouponCategories(mapped);
  // Sem nicho (QUEROCUPONS etc.): só Achadinhos. Nunca TCG/Eletrônicos.
  return groupsForCouponCategories(["geral"]);
}

export type CouponProductHint = {
  title: string;
  url: string;
  pix: number;
};

/** Só links que pagam afiliação (meli.la / click afiliado) — nunca lista.mercadolivre. */
function isAffiliateProductUrl(url: string): boolean {
  const u = String(url || "").trim();
  if (!u) return false;
  if (/lista\.mercadolivre\.com\.br/i.test(u)) return false;
  if (/meli\.la\//i.test(u)) return true;
  if (/click\d*\.mercadolivre\.com\.br/i.test(u)) return true;
  if (/\/afiliados\//i.test(u) || /[?&]matt_tool=/i.test(u)) return true;
  return false;
}

/** Produtos testados com link de afiliado (não a lista oficial sem tag). */
export function eligibleDealsForCoupon(
  code: string,
  limit = 4,
): CouponProductHint[] {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return [];
  const rows = getDb()
    .prepare(
      `SELECT title, affiliate_url, product_url, price, price_with_coupon
       FROM deals
       WHERE upper(trim(coupon)) = ?
         AND coupon_status = 'valid'
       ORDER BY CASE WHEN affiliate_url LIKE '%meli.la%' THEN 0 ELSE 1 END, id DESC
       LIMIT ?`,
    )
    .all(c, Math.max(1, Math.min(12, limit * 3))) as Array<{
    title: string;
    affiliate_url: string;
    product_url: string;
    price: number;
    price_with_coupon: number | null;
  }>;
  const out: CouponProductHint[] = [];
  for (const r of rows) {
    if (isLowDemandNicheTitle(r.title)) continue;
    const url = isAffiliateProductUrl(r.affiliate_url)
      ? r.affiliate_url
      : isAffiliateProductUrl(r.product_url)
        ? r.product_url
        : "";
    if (!url) continue;
    out.push({
      title: String(r.title || "").slice(0, 56),
      url,
      pix: Number(r.price_with_coupon || r.price || 0),
    });
    if (out.length >= Math.max(1, Math.min(8, limit))) break;
  }
  return out;
}

function alreadyAnnounced(
  campaignId: string,
  groupId: number,
  kind: CouponKind,
): boolean {
  ensureAnnounceTable();
  const row = getDb()
    .prepare(
      `SELECT 1 AS x FROM coupon_announcements
       WHERE campaign_id = ? AND group_id = ? AND kind = ?`,
    )
    .get(campaignId, groupId, kind) as { x?: number } | undefined;
  return Boolean(row);
}

function markAnnounced(
  campaignId: string,
  groupId: number,
  kind: CouponKind,
): void {
  ensureAnnounceTable();
  addCouponCols();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO coupon_announcements (campaign_id, group_id, kind)
       VALUES (?, ?, ?)`,
    )
    .run(campaignId, groupId, kind);
  getDb()
    .prepare(
      `UPDATE ml_coupons SET last_announced_status = ?, last_announced_at = datetime('now')
       WHERE campaign_id = ?`,
    )
    .run(kind, campaignId);
}

function discountLine(c: MlCoupon): string {
  const bits: string[] = [];
  if (c.discountType === "percent" && c.discountValue) {
    bits.push(`${c.discountValue}% OFF`);
  } else if (c.discountType === "fixed" && c.discountValue) {
    bits.push(`${brl(c.discountValue)} OFF`);
  }
  if (c.minAmount) bits.push(`em ${brl(c.minAmount)}`);
  if (c.capAmount) bits.push(`Limite de ${brl(c.capAmount)} OFF`);
  return bits.join(", ") || c.title;
}

export function composeCouponValidMessage(
  coupon: MlCoupon,
  opts?: { inviteUrl?: string | null; groupName?: string | null },
): string {
  const code = String(coupon.code || "").toUpperCase();
  const brand = getSetting("brand_group_name", "Careca VIP");
  const invite = String(
    opts?.inviteUrl ||
      getSetting("community_linktree", "") ||
      (
        getDb()
          .prepare(
            `SELECT invite_link FROM wa_groups
             WHERE active = 1 AND invite_link IS NOT NULL AND trim(invite_link) != ''
             LIMIT 1`,
          )
          .get() as { invite_link?: string } | undefined
      )?.invite_link ||
      "",
  );
  // Nunca postar lista.mercadolivre — compra por lá não paga afiliação.
  // Só links meli.la / afiliado de produtos já testados com o cupom.
  const products = eligibleDealsForCoupon(code, 5);
  const lines = [
    `🎟️ Cupom *${code}*`,
    discountLine(coupon),
    "",
    "Válido *somente* em produtos elegíveis deste cupom.",
    "Checkout recusa se o item não estiver na lista oficial.",
    "",
    "Em seguida mando várias ofertas com o cupom e *link de afiliado* 👇",
  ];
  if (products.length) {
    lines.push("", "✅ *Já testamos nestes (compre por estes links):*");
    for (const p of products) {
      const pix = p.pix > 0 ? ` · ${brl(p.pix)}` : "";
      lines.push(`• ${p.title}${pix}`);
      if (p.url) lines.push(p.url);
    }
  } else {
    lines.push(
      "",
      "Já já saem produtos com desconto + link de afiliado — use o cupom neles.",
    );
  }
  if (getSetting("post_hashtag", "0") === "1") lines.push("", "#anuncio");
  const community = String(opts?.groupName || brand).trim();
  if (invite) {
    lines.push("", `📽️ *${community}*`, invite);
  }
  return lines.join("\n");
}

export function composeCouponExhaustedMessage(coupon: MlCoupon): string {
  const code = String(coupon.code || "").toUpperCase();
  const brand = getSetting("brand_group_name", "Careca VIP");
  const invite =
    getSetting("community_linktree", "") ||
    (
      getDb()
        .prepare(
          `SELECT invite_link FROM wa_groups
           WHERE active = 1 AND invite_link IS NOT NULL AND trim(invite_link) != ''
           LIMIT 1`,
        )
        .get() as { invite_link?: string } | undefined
    )?.invite_link ||
    "";
  const lines = [
    `❌❌ Cupom: *${code}* — ESGOTADO ❌❌`,
    "",
    "Fique atento nas comunidades pois existem cupons que voltam em determinados momentos. Não basta você economizar, convide um amigo para economizar junto.",
  ];
  if (invite) {
    lines.push("", "Mande para ele isso 👇", invite);
  } else {
    lines.push("", `Comunidade ${brand}`);
  }
  return lines.join("\n");
}

function logPost(opts: {
  groupId: number;
  messageHash: string;
  ok: boolean;
  reason: string;
  waKey?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO post_logs (deal_id, group_id, message_hash, ok, reason, wa_key)
       VALUES (NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.groupId,
      opts.messageHash,
      opts.ok ? 1 : 0,
      opts.reason,
      opts.waKey || null,
    );
}

export async function announceCouponToGroups(
  coupon: MlCoupon,
  kind: CouponKind,
  opts?: { manual?: boolean },
): Promise<{ sent: number; skipped: string[]; groups: string[]; followups: number }> {
  if (!isDigitableCouponCode(coupon.code)) {
    return { sent: 0, skipped: ["código não digitável"], groups: [], followups: 0 };
  }
  const wa = getWaStatus();
  if (!wa.connected) {
    return { sent: 0, skipped: ["WhatsApp offline"], groups: [], followups: 0 };
  }

  const cats = couponTargetCategories(coupon);
  const groups = groupsForCoupon(coupon);
  if (!groups.length) {
    return { sent: 0, skipped: ["nenhum grupo da categoria"], groups: [], followups: 0 };
  }

  let sent = 0;
  let followups = 0;
  const skipped: string[] = [];
  const names: string[] = [];
  const manual = Boolean(opts?.manual);

  for (const group of groups) {
    if (alreadyAnnounced(coupon.campaignId, group.id, kind)) {
      skipped.push(`${group.name}: já anunciado`);
      continue;
    }

    // Válido: se outro cupom ainda está em foco (não esgotou), enfileira e espera.
    if (kind === "valid") {
      const current = getGroupFocusCoupon(group.id);
      if (
        current &&
        !couponCodesMatch(current, coupon.code) &&
        isGroupFocusCouponLive(group.id)
      ) {
        enqueueWaitingCoupon(
          group.id,
          String(coupon.code || ""),
          String(coupon.campaignId || ""),
          coupon.expiresAt,
        );
        skipped.push(
          `${group.name}: ${coupon.code} na espera (foco atual ${current} até esgotar)`,
        );
        continue;
      }
    }

    const decision = canSendNow({
      messageHash: hashMessage(`${group.jid}:coupon:${kind}:${coupon.campaignId}`),
      groupsInWave: 1,
      groupId: group.id,
      manual,
      priorityCoupon: true,
      couponBurst: kind === "valid",
    });
    if (!decision.allow) {
      skipped.push(`${group.name}: ${decision.reason}`);
      if (!manual && /fora da janela/i.test(decision.reason)) break;
      continue;
    }
    if (!manual) await sleep(Math.min(decision.delayMs, 90_000));

    // Válido: só anuncia se der para chover produtos com ESTE cupom.
    let preStock = 0;
    if (kind === "valid") {
      preStock = eligibleDealsForCoupon(String(coupon.code || ""), 8).length;
      if (preStock < 3) {
        try {
          const { ingestDealsFromCouponLists } = await import(
            "./couponHarvest.js"
          );
          await ingestDealsFromCouponLists({
            maxCoupons: 1,
            maxItemsPerCoupon: 16,
            mintLinks: 12,
            preferCodes: [String(coupon.code || "")],
          });
          preStock = eligibleDealsForCoupon(String(coupon.code || ""), 8).length;
        } catch (err) {
          skipped.push(
            `${group.name}: harvest ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (preStock < 1) {
        skipped.push(
          `${group.name}: ${coupon.code} sem produtos na lista/PDP — não anuncio cupom vazio`,
        );
        continue;
      }
    }

    const brand = resolveGroupBrand(group);
    const invite =
      String((group as WaGroup & { promo_url?: string | null }).promo_url || "").trim() ||
      group.invite_link ||
      null;
    const text =
      kind === "valid"
        ? composeCouponValidMessage(coupon, {
            inviteUrl: invite,
            groupName: group.name,
          })
        : composeCouponExhaustedMessage(coupon);
    let banner: Buffer | null = null;
    try {
      banner = await generateCouponBanner({
        kind,
        code: String(coupon.code),
        headline:
          kind === "valid"
            ? "OFERTAS COM CUPOM · LINK AFILIADO"
            : "CUPOM ESGOTADO",
        detail: discountLine(coupon),
        groupName: group.name,
        inviteUrl: invite,
        logoPath: groupLogoPath(group.id) || group.watermark_logo_path || null,
        handle: brand.handle,
        tagline: brand.tagline,
        layout: String((group as WaGroup & { image_layout?: string }).image_layout || "auto"),
        category: group.categories,
      });
    } catch {
      banner = null;
    }

    try {
      let sendMeta: { waKey?: string | null };
      if (banner) {
        sendMeta = await sendGroupImage(group.jid, banner, text);
      } else {
        sendMeta = await sendGroupText(group.jid, text);
      }
      markAnnounced(coupon.campaignId, group.id, kind);
      logPost({
        groupId: group.id,
        messageHash: hashMessage(text),
        ok: true,
        reason: `aviso_cupom_${kind}:${coupon.code}`,
        waKey: sendMeta.waKey,
      });
      sent += 1;
      names.push(group.name);
      if (kind === "exhausted") {
        clearGroupFocusCoupon(group.id, String(coupon.code || ""));
        // Próximo da espera: será anunciado na próxima rodada de processCouponAnnouncements
        const next = shiftWaitingCoupon(group.id);
        if (next?.code) {
          skipped.push(
            `${group.name}: próximo da espera ${next.code} (anúncio na próxima onda)`,
          );
        }
      }
      if (kind === "valid") {
        pushGroupFocusCoupon(
          group.id,
          String(coupon.code || ""),
          coupon.expiresAt,
        );
        try {
          const { publishCouponFollowups } = await import("./publisher.js");
          const follow = await publishCouponFollowups({
            group,
            couponCode: String(coupon.code || ""),
            count: Math.min(8, Math.max(4, preStock)),
            manual: true,
          });
          followups += follow.sent;
          if (follow.sent) {
            skipped.push(
              `${group.name}: +${follow.sent} oferta(s) afiliadas do cupom`,
            );
          } else if (follow.details[0]) {
            skipped.push(`${group.name}: ofertas ${follow.details[0]}`);
          }
        } catch (err) {
          skipped.push(
            `${group.name}: ofertas ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logPost({
        groupId: group.id,
        messageHash: hashMessage(text),
        ok: false,
        reason: msg,
      });
      skipped.push(`${group.name}: ${msg}`);
    }
  }

  logAntiBan(
    kind === "valid" ? "coupon_valid_alert" : "coupon_dead_alert",
    `${coupon.code} sent=${sent} followups=${followups} cats=${cats.join(",") || "geral"} ${skipped[0] || ""}`,
  );
  return { sent, skipped, groups: names, followups };
}

function couponIsActive(c: {
  status: string;
  expiresAt?: string | null;
}): boolean {
  if (String(c.status).toUpperCase() !== "ACTIVE") return false;
  if (!c.expiresAt) return true;
  const t = Date.parse(c.expiresAt);
  return !Number.isFinite(t) || t > Date.now();
}

/**
 * Detecta transição válido ↔ esgotado e posta nos grupos certos.
 * Só anuncia códigos digitáveis (OFFMELI, BRINQUEDOS…).
 */
export async function processCouponAnnouncements(opts?: {
  manual?: boolean;
  /** Cupons novos da categoria: tenta todos nesta rodada */
  priority?: boolean;
}): Promise<{
  announcedValid: number;
  announcedExhausted: number;
  pending: number;
  details: string[];
}> {
  addCouponCols();
  ensureAnnounceTable();
  const { listAllStoredCoupons } = await import("./mlCoupons.js");
    const coupons = listAllStoredCoupons(250)
    .filter((c) => isDigitableCouponCode(c.code))
    .sort((a, b) => {
      // 1) Esgotados do cupom em foco primeiro (libera a fila)
      const focusCodes = new Set<string>();
      try {
        const groups = getDb()
          .prepare(`SELECT id FROM wa_groups WHERE active = 1`)
          .all() as Array<{ id: number }>;
        for (const g of groups) {
          const f = getGroupFocusCoupon(g.id);
          if (f) focusCodes.add(f);
        }
      } catch {
        /* ignore */
      }
      const aFocus = focusCodes.has(String(a.code || "").toUpperCase()) ? 0 : 1;
      const bFocus = focusCodes.has(String(b.code || "").toUpperCase()) ? 0 : 1;
      const aDead =
        String(a.status || "").toUpperCase() !== "ACTIVE" || a.testedOk === 0;
      const bDead =
        String(b.status || "").toUpperCase() !== "ACTIVE" || b.testedOk === 0;
      const aEx = aDead && a.lastAnnouncedStatus === "valid" ? 0 : 1;
      const bEx = bDead && b.lastAnnouncedStatus === "valid" ? 0 : 1;
      if (aFocus !== bFocus) return aFocus - bFocus;
      if (aEx !== bEx) return aEx - bEx;
      // 2) Cupom novo (nunca anunciado)
      const newA = a.lastAnnouncedStatus ? 1 : 0;
      const newB = b.lastAnnouncedStatus ? 1 : 0;
      if (newA !== newB) return newA - newB;
      const ta = couponTargetCategories(a).length ? 0 : 1;
      const tb = couponTargetCategories(b).length ? 0 : 1;
      return ta - tb;
    });

  let announcedValid = 0;
  let announcedExhausted = 0;
  let pending = 0;
  const details: string[] = [];
  /** Grupos que já receberam cupom válido nesta rodada (1 por vez). */
  const groupsGotValid = new Set<number>();

  for (const c of coupons) {
    const active = couponIsActive(c);
    const testedDead = c.testedOk === 0;
    const shouldValid = active && !testedDead;
    const shouldExhaust =
      (!active || testedDead) &&
      (c.lastAnnouncedStatus === "valid" || c.testedOk === 1);

    const kind: CouponKind | null = shouldValid
      ? "valid"
      : shouldExhaust
        ? "exhausted"
        : null;
    if (!kind) continue;

    // Antes de anunciar esgotado: confirma no ML (input-code). Se ainda vivo, pula.
    if (kind === "exhausted") {
      try {
        const { confirmCouponLiveOnMl } = await import("./couponLiveCheck.js");
        const live = await confirmCouponLiveOnMl(String(c.code || ""));
        if (live.live === true || live.live === null) {
          details.push(
            `${c.code}: NÃO anunciar esgotado (${live.detail})`,
          );
          continue;
        }
      } catch (err) {
        details.push(
          `${c.code}: skip esgotado — ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }

    const groups = groupsForCoupon(c).filter((g) => {
      if (kind === "valid" && groupsGotValid.has(g.id)) return false;
      if (kind === "valid") {
        const focus = getGroupFocusCoupon(g.id);
        if (
          focus &&
          !couponCodesMatch(focus, c.code) &&
          isGroupFocusCouponLive(g.id)
        ) {
          enqueueWaitingCoupon(
            g.id,
            String(c.code || ""),
            String(c.campaignId || ""),
            c.expiresAt,
          );
          return false;
        }
      }
      return !alreadyAnnounced(c.campaignId, g.id, kind);
    });
    if (!groups.length) continue;

    const res = await announceCouponToGroups(c, kind, opts);
    if (kind === "valid") {
      announcedValid += res.sent;
      for (const name of res.groups) {
        const g = groups.find((x) => x.name === name);
        if (g) groupsGotValid.add(g.id);
      }
    } else announcedExhausted += res.sent;
    if (res.sent === 0 && res.skipped.length) pending += 1;
    details.push(
      `${c.code} ${kind}: ${res.sent} envio(s)` +
        (res.skipped[0] ? ` (${res.skipped[0]})` : ""),
    );
    if (res.sent > 0 && !opts?.manual && !opts?.priority) break;
    if (opts?.priority && announcedValid + announcedExhausted >= 4) break;
  }

  return { announcedValid, announcedExhausted, pending, details };
}
