import { config } from "../config.js";
import { getDb, getSetting, logAntiBan, type Deal } from "../db/index.js";
import type { IncomingDeal } from "../types.js";
import {
  amazonConfigured,
  getAmazonCreds,
  getMercadoLivreCreds,
  mlConfigured,
} from "./credentialVault.js";
import { searchAmazonDeals } from "./amazonPaapi.js";
import { searchMercadoLivreDeals } from "./mercadoLivre.js";
import {
  getPulseStatus,
  mintAmazonAffiliateUrl,
  mintMercadoLivreAffiliateUrl,
} from "./pulseGuard.js";
import {
  demoExtraDeals,
  fetchExtraAffiliateDeals,
} from "./extraAffiliates.js";
import { parseList } from "./composer.js";
import type { WaGroup } from "../db/index.js";
import { isTcgCollectible } from "./tcgFilter.js";
import { isVideoGameDeal } from "./gamesFilter.js";
import { dealPostScore, isBuyableDeal } from "./dealQuality.js";
import { resolveDealPrices } from "./dealDisplay.js";
import { canonicalCouponCode } from "./couponCategories.js";
import { wasProductPostedRecently, repostCooldownDays } from "./productDedupe.js";
import { evaluateCouponSavings } from "./couponSavings.js";

export type { IncomingDeal };

const AMAZON_QUERIES: Array<{ q: string; index: string }> = [
  { q: "fone bluetooth", index: "Electronics" },
  { q: "controle sem fio", index: "VideoGames" },
  { q: "carta pokemon booster", index: "ToysAndGames" },
];

const ML_QUERIES = [
  "smartphone oferta",
  "controle xbox",
  "booster pokemon",
];

function demoDeals(): IncomingDeal[] {
  const stamp = Date.now();
  const amazonTag = getAmazonCreds().partnerTag || "demo-20";
  const mlTag = getMercadoLivreCreds().affiliateTag || "demo";
  return [
    {
      external_id: `demo-jeans-${stamp}`,
      source: "demo",
      title: "Kit 3 Calça Jeans Skinny Masculina Com Lycra Estica",
      description:
        "Kit com 3 calças skinny com elastano.\nCintura confortável e modelagem moderna.\nIdeal para o dia a dia.\nOferta relâmpago — cupom pode esgotar.",
      category: "geral",
      price: 101.59,
      old_price: 169.99,
      currency: "BRL",
      coupon: "SEMPREMODA",
      image_url:
        "https://images.unsplash.com/photo-1542272604-787c3835535d?auto=format&fit=crop&w=1080&q=80",
      product_url: "https://www.mercadolivre.com.br/demo-jeans",
      affiliate_url: mintMercadoLivreAffiliateUrl(
        "https://www.mercadolivre.com.br/demo-jeans",
        mlTag,
      ),
    },
    {
      external_id: `demo-fone-${stamp}`,
      source: "demo",
      title: "Fone Bluetooth TWS ANC",
      description:
        "Cancelamento de ruído ativo.\nCase com USB-C.\nBateria para o dia inteiro.\nFrete conforme região.",
      category: "eletronicos",
      price: 149.9,
      old_price: 249.9,
      currency: "BRL",
      coupon: "AUDIO10",
      image_url:
        "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=1080&q=80",
      product_url: "https://www.amazon.com.br/dp/DEMO1",
      affiliate_url: mintAmazonAffiliateUrl(
        "https://www.amazon.com.br/dp/DEMO1",
        amazonTag,
      ),
    },
    {
      external_id: `demo-game-${stamp}`,
      source: "demo",
      title: "Controle sem fio compatível",
      description:
        "Vibração e resposta rápida.\nBateria longa duração.\nCompatível com PC e console.\nEstoque limitado.",
      category: "games",
      price: 189.0,
      old_price: 279.0,
      currency: "BRL",
      coupon: null,
      image_url:
        "https://images.unsplash.com/photo-1592840496694-26d035b52b48?auto=format&fit=crop&w=1080&q=80",
      product_url: "https://www.amazon.com.br/dp/DEMO2",
      affiliate_url: mintAmazonAffiliateUrl(
        "https://www.amazon.com.br/dp/DEMO2",
        amazonTag,
      ),
    },
  ];
}

/**
 * Estratégia "Harvest → Mint":
 * 1) Busca produtos via API oficial (com Pulse Guard + cache)
 * 2) Gera link afiliado LOCALMENTE (tag), sem gastar cota extra
 */
export function getEnabledSources(): string[] {
  const list = parseList(
    getSetting("enabled_sources", "mercadolivre"),
  ).map((s) => s.toLowerCase());
  return list.length ? list : ["mercadolivre"];
}

export async function fetchDeals(): Promise<IncomingDeal[]> {
  const demo = getSetting("demo_mode", config.demoMode ? "1" : "0") === "1";
  const hasAmazon = amazonConfigured();
  const hasMl = mlConfigured();
  const enabled = getEnabledSources();

  if (demo) {
    const all = [...demoDeals(), ...demoExtraDeals()];
    return all.filter((d) => {
      const src = d.source === "demo" ? "mercadolivre" : d.source;
      return enabled.includes(src) || enabled.includes(d.source);
    });
  }

  const deals: IncomingDeal[] = [];

  if (hasAmazon && enabled.includes("amazon")) {
    const pick =
      AMAZON_QUERIES[Math.floor(Math.random() * AMAZON_QUERIES.length)]!;
    const amazonDeals = await searchAmazonDeals(pick.q, pick.index);
    deals.push(...amazonDeals);
  }

  // ML “busca genérica” só se habilitado — o Sync Hub é a fonte principal
  if (hasMl && enabled.includes("mercadolivre")) {
    const pick = ML_QUERIES[Math.floor(Math.random() * ML_QUERIES.length)]!;
    const mlDeals = await searchMercadoLivreDeals(pick);
    deals.push(...mlDeals);
  }

  if (enabled.some((s) => ["shopee", "magalu", "americanas", "awin"].includes(s))) {
    const extras = await fetchExtraAffiliateDeals();
    deals.push(
      ...extras.filter((d) => enabled.includes(String(d.source).toLowerCase())),
    );
  }

  logAntiBan(
    "affiliate_fetch",
    `sources=${enabled.join(",")} amazon=${hasAmazon} ml=${hasMl} got=${deals.length} pulse=${JSON.stringify(getPulseStatus())}`,
  );

  // Sem fallback multi-loja: se só ML está ativo e não veio nada, retorna vazio
  // (o Sync Hub cuida do Mercado Livre)
  if (deals.length === 0) {
    logAntiBan(
      "affiliate_fetch_empty",
      `nenhuma oferta nas lojas ativas: ${enabled.join(",")}`,
    );
  }
  return deals;
}

export function upsertDeals(deals: IncomingDeal[]): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO deals (
      external_id, source, title, description, category, price, old_price,
      currency, coupon, coupon_status, image_url, product_url, affiliate_url,
      commission_pct, status
    ) VALUES (
      @external_id, @source, @title, @description, @category, @price, @old_price,
      @currency, @coupon, @coupon_status, @image_url, @product_url, @affiliate_url,
      @commission_pct, @status
    )
    ON CONFLICT(source, external_id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      price = excluded.price,
      old_price = excluded.old_price,
      image_url = COALESCE(excluded.image_url, deals.image_url),
      affiliate_url = CASE
        WHEN deals.affiliate_url LIKE '%meli.la%' THEN deals.affiliate_url
        ELSE excluded.affiliate_url
      END,
      product_url = excluded.product_url,
      commission_pct = COALESCE(excluded.commission_pct, deals.commission_pct),
      coupon = COALESCE(excluded.coupon, deals.coupon),
      coupon_status = CASE
        WHEN excluded.coupon IS NOT NULL AND excluded.coupon != '' THEN excluded.coupon_status
        ELSE deals.coupon_status
      END,
      status = CASE
        WHEN deals.status = 'posted' THEN deals.status
        WHEN excluded.coupon IS NOT NULL AND excluded.coupon != '' THEN excluded.status
        ELSE excluded.status
      END
  `);

  let inserted = 0;
  const tx = db.transaction((rows: IncomingDeal[]) => {
    for (const row of rows) {
      const hasCoupon = Boolean(row.coupon);
      const info = stmt.run({
        ...row,
        commission_pct: row.commission_pct ?? null,
        coupon_status: hasCoupon ? "pending" : "none",
        status: hasCoupon ? "hold_coupon" : "queued",
      });
      inserted += info.changes;
    }
  });
  tx(deals);
  void import("./priceHistory.js")
    .then(({ recordPriceSnapshot, itemIdFromDeal }) => {
      for (const row of deals) {
        const itemId = itemIdFromDeal(row);
        if (!itemId) continue;
        recordPriceSnapshot({
          itemId,
          price: row.price,
          priceWithCoupon: null,
          coupon: row.coupon,
          source: "upsert",
        });
      }
    })
    .catch(() => {
      /* ignore */
    });
  return inserted;
}

export function listPendingCouponDeals(limit = 10): Deal[] {
  return getDb()
    .prepare(
      `SELECT * FROM deals
       WHERE status = 'hold_coupon' OR coupon_status = 'pending'
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(limit) as Deal[];
}

export function nextQueuedDealForCategories(categories: string[]): Deal | null {
  if (categories.length === 0) return null;
  const placeholders = categories.map(() => "?").join(",");
  return (
    (getDb()
      .prepare(
        `SELECT * FROM deals
         WHERE status = 'queued'
           AND category IN (${placeholders})
           AND coupon_status = 'valid'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(...categories) as Deal | undefined) ?? null
  );
}

function sourceSetForGroup(group: WaGroup): Set<string> {
  const groupSources = parseList(group.sources || "mercadolivre").map((s) =>
    s.toLowerCase(),
  );
  const globalEnabled = new Set(getEnabledSources());
  const demoOn = getSetting("demo_mode", "0") === "1";
  const sourceSet = new Set(groupSources.filter((s) => globalEnabled.has(s)));
  if (demoOn && sourceSet.has("mercadolivre")) sourceSet.add("demo");
  if (!sourceSet.size) {
    for (const s of globalEnabled) sourceSet.add(s);
    if (demoOn && sourceSet.has("mercadolivre")) sourceSet.add("demo");
  }
  return sourceSet;
}

/** Ofertas que este grupo ainda vai receber (categoria + fonte + ainda não postadas nele). */
export function listQueuedDealsForGroup(
  group: WaGroup,
  limit = 20,
  opts?: { coupon?: string | null; coupons?: string[] | null },
): Deal[] {
  const cats = parseList(group.categories || "geral");
  const sourceSet = sourceSetForGroup(group);
  const keywords = parseList(group.keywords || "");
  const srcPh = [...sourceSet].map(() => "?").join(",");
  if (!srcPh) return [];

  const includeAllCats = cats.includes("geral");
  const catPh = cats.map(() => "?").join(",");
  // Achadinhos (geral): tudo EXCETO TCG — já existe grupo específico
  const catClause = includeAllCats
    ? `d.category NOT IN ('tcg')`
    : `d.category IN (${catPh})`;
  const cooldown = `-${repostCooldownDays()} days`;
  const params: Array<string | number> = includeAllCats
    ? [...sourceSet, group.id, cooldown, group.id, cooldown]
    : [...cats, ...sourceSet, group.id, cooldown, group.id, cooldown];
  const wantCoupons = new Set(
    [
      ...(opts?.coupons || []),
      ...(opts?.coupon ? [opts.coupon] : []),
    ]
      .map((c) => canonicalCouponCode(c))
      .filter(Boolean),
  );

  const rows = getDb()
    .prepare(
      `SELECT d.* FROM deals d
       WHERE d.status = 'queued'
         AND ${catClause}
         AND lower(d.source) IN (${srcPh})
         AND d.coupon_status = 'valid'
         AND NOT EXISTS (
           SELECT 1 FROM post_logs pl
           WHERE pl.deal_id = d.id
             AND pl.group_id = ?
             AND pl.ok = 1
             AND pl.reason = 'enviado'
             AND pl.created_at >= datetime('now', ?)
         )
         AND NOT EXISTS (
           SELECT 1 FROM post_logs pl2
           JOIN deals dx ON dx.id = pl2.deal_id
           WHERE pl2.group_id = ?
             AND pl2.ok = 1
             AND pl2.reason = 'enviado'
             AND pl2.created_at > datetime('now', ?)
             AND dx.external_id = d.external_id
             AND dx.external_id IS NOT NULL
             AND trim(dx.external_id) != ''
         )
       ORDER BY d.created_at ASC
       LIMIT ?`,
    )
    .all(...params, Math.max(limit * 4, 40)) as Deal[];

  const filtered = rows.filter((d) => {
    if (!isBuyableDeal(d)) return false;
    // Política ML: só postar com link afiliado curto (createLink humano).
    if (
      getSetting("require_meli_la", "1") === "1" &&
      getSetting("demo_mode", "1") !== "1" &&
      String(d.source || "").toLowerCase() === "mercadolivre" &&
      !/meli\.la\//i.test(d.affiliate_url || "")
    ) {
      return false;
    }
    const view = resolveDealPrices(d);
    if (!view.hasTypedCoupon && !view.clickCoupon) return false;
    if (view.hasTypedCoupon && !evaluateCouponSavings(d).ok) return false;
    const rep = wasProductPostedRecently(group.id, {
      dealId: d.id,
      externalId: d.external_id,
      title: d.title,
    });
    if (rep.blocked) return false;
    if (includeAllCats && (d.category === "tcg" || isTcgCollectible(d.title))) {
      return false;
    }
    if (
      cats.includes("tcg") &&
      !cats.includes("geral") &&
      !isTcgCollectible(d.title, d.product_url)
    ) {
      return false;
    }
    if (
      cats.includes("games") &&
      !cats.includes("geral") &&
      !isVideoGameDeal(d.title, d.product_url)
    ) {
      return false;
    }
    if (wantCoupons.size) {
      const code = canonicalCouponCode(d.coupon);
      if (!code || !wantCoupons.has(code)) return false;
    }
    if (keywords.length === 0) return true;
    const hay = `${d.title} ${d.description}`.toLowerCase();
    return keywords.some((k) => hay.includes(k));
  });
  filtered.sort((a, b) => dealPostScore(b, group) - dealPostScore(a, group));
  return filtered.slice(0, limit);
}

/** Seleção personalizada por grupo: categorias + fontes + palavras-chave.
 *  Não reenvia o mesmo deal a um grupo que já recebeu (post_logs ok). */
export function nextQueuedDealForGroup(group: WaGroup): Deal | null {
  return listQueuedDealsForGroup(group, 20)[0] || null;
}

/** Marca deal como posted só quando todos os grupos ativos da mesma categoria já receberam. */
export function markDealPostedForGroup(deal: Deal, groupId: number): void {
  const pendingGroups = getDb()
    .prepare(
      `SELECT g.id FROM wa_groups g
       WHERE g.active = 1
         AND (
           ',' || lower(replace(g.categories, ' ', '')) || ','
           LIKE '%,' || lower(?) || ',%'
         )
         AND NOT EXISTS (
           SELECT 1 FROM post_logs pl
           WHERE pl.deal_id = ?
             AND pl.group_id = g.id
             AND pl.ok = 1
         )
         AND g.id != ?`,
    )
    .all(deal.category, deal.id, groupId) as Array<{ id: number }>;

  if (pendingGroups.length === 0) {
    markDeal(deal.id, "posted");
  }
}

/** Cupons mais usados no ML BR — prioridade na revalidação / alerta de expiração */
const PRIORITY_COUPONS = [
  "OFFMELI",
  "COMPRINHASPRACASA",
  "SEMPRENAMODA",
  "SEMPREMODA",
  "BRINQUEDOS",
  "QUEROCUPONS",
  "ECONOMIAML",
  "APROVEITAESSA",
  "MELIFESTA",
];

export function listDealsNeedingRevalidation(limit = 20): Deal[] {
  const enabled = getEnabledSources();
  const srcPh = enabled.map(() => "?").join(",");
  // Inclui já postados: precisa avisar o grupo quando o cupom morrer
  return getDb()
    .prepare(
      `SELECT * FROM deals
       WHERE coupon IS NOT NULL AND coupon != ''
         AND status IN ('queued', 'hold_coupon', 'posted')
         AND coupon_status IN ('pending', 'valid')
         AND lower(source) IN (${srcPh}, 'demo')
       ORDER BY
         CASE
           WHEN upper(coupon) IN (${PRIORITY_COUPONS.map(() => "?").join(",")}) THEN 0
           ELSE 1
         END,
         CASE WHEN status = 'posted' THEN 0 ELSE 1 END,
         COALESCE(coupon_tested_at, created_at) ASC
       LIMIT ?`,
    )
    .all(
      ...enabled.map((s) => s.toLowerCase()),
      ...PRIORITY_COUPONS,
      limit,
    ) as Deal[];
}

/** Remove da fila ofertas de lojas que não estão ativas no painel. */
export function pruneDisabledSourceDeals(): { deleted: number; sources: string[] } {
  const enabled = new Set(getEnabledSources().map((s) => s.toLowerCase()));
  const demoOn = getSetting("demo_mode", "0") === "1";
  if (demoOn && enabled.has("mercadolivre")) enabled.add("demo");
  const rows = getDb()
    .prepare(
      `SELECT id, source FROM deals
       WHERE status IN ('queued', 'hold_coupon')`,
    )
    .all() as Array<{ id: number; source: string }>;
  const toDelete = rows
    .filter((r) => !enabled.has(String(r.source).toLowerCase()))
    .map((r) => r.id);
  if (!toDelete.length) return { deleted: 0, sources: [...enabled] };
  const ph = toDelete.map(() => "?").join(",");
  getDb()
    .prepare(`DELETE FROM deals WHERE id IN (${ph})`)
    .run(...toDelete);
  logAntiBan(
    "prune_disabled_sources",
    `deleted=${toDelete.length} keep=${[...enabled].join(",")}`,
  );
  return { deleted: toDelete.length, sources: [...enabled] };
}

export function markDeal(id: number, status: Deal["status"]): void {
  const postedAt = status === "posted" ? new Date().toISOString() : null;
  getDb()
    .prepare(
      `UPDATE deals SET status = ?, posted_at = COALESCE(?, posted_at) WHERE id = ?`,
    )
    .run(status, postedAt, id);
}

export function buildAffiliateUrl(
  source: "amazon" | "mercadolivre",
  url: string,
): string {
  if (source === "amazon") {
    return mintAmazonAffiliateUrl(url, getAmazonCreds().partnerTag);
  }
  return mintMercadoLivreAffiliateUrl(url, getMercadoLivreCreds().affiliateTag);
}
