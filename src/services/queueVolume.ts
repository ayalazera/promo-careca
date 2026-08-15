/**
 * Volume da fila / Sync / harvest — knobs centralizados.
 * Concorrentes (Will / Clube do Rei) postam ~60–90 ofertas/dia.
 * Metas Careca: Achadinhos ~90 · TCG ~45 · Eletrônicos ~55.
 * Intercalação: 1 grupo a cada ~60s (nunca vários no mesmo minuto).
 */
import { getSetting, getSettingNum } from "../db/index.js";
import { demandScore } from "./demandFilter.js";

export function syncCreateLinkLimit(override?: number): number {
  const raw =
    override != null && Number.isFinite(override)
      ? override
      : getSettingNum("ml_hub_sync_limit", 24, 1, 24);
  return Math.max(1, Math.min(24, Math.floor(raw)));
}

export function harvestMaxCoupons(override?: number): number {
  const raw =
    override != null && Number.isFinite(override)
      ? override
      : getSettingNum("harvest_max_coupons", 10, 1, 20);
  return Math.max(1, Math.min(20, Math.floor(raw)));
}

export function harvestMaxItems(override?: number): number {
  const raw =
    override != null && Number.isFinite(override)
      ? override
      : getSettingNum("harvest_max_items", 14, 1, 30);
  return Math.max(1, Math.min(30, Math.floor(raw)));
}

export function harvestMintLinks(override?: number): number {
  const raw =
    override != null && Number.isFinite(override)
      ? override
      : getSettingNum("harvest_mint_links", 20, 0, 48);
  return Math.max(0, Math.min(48, Math.floor(raw)));
}

/** Quotas mínimas do pool de createLink do Sync (por família). */
export function syncCategoryQuotas(limit: number): {
  tcg: number;
  electronics: number;
  rest: number;
} {
  const tcg = Math.max(
    2,
    Math.min(
      Math.ceil(limit * 0.3),
      getSettingNum("sync_quota_tcg", Math.ceil(limit * 0.3), 1, 24),
    ),
  );
  const electronics = Math.max(
    2,
    Math.min(
      Math.ceil(limit * 0.3),
      getSettingNum("sync_quota_electronics", Math.ceil(limit * 0.3), 1, 24),
    ),
  );
  const used = Math.min(limit, tcg + electronics);
  return { tcg, electronics, rest: Math.max(0, limit - used) };
}

export function isElectronicsFamily(cat: string): boolean {
  return /eletronicos|celulares|informatica|eletrodomesticos/.test(
    String(cat || "").toLowerCase(),
  );
}

/** Score oferta: comissão % + desconto listado + procura. */
export function offerAttractScore(opts: {
  commissionPct?: number | null;
  price?: number | null;
  oldPrice?: number | null;
  soldQuantity?: number | null;
  title?: string;
}): number {
  let score = 0;
  const comm = Number(opts.commissionPct);
  if (Number.isFinite(comm) && comm > 0) score += Math.min(50, comm * 1.2);
  const price = Number(opts.price);
  const old = Number(opts.oldPrice);
  if (Number.isFinite(price) && price > 0 && Number.isFinite(old) && old > price) {
    const pct = (1 - price / old) * 100;
    score += Math.min(40, pct * 0.9);
  }
  score += demandScore({
    title: opts.title || "",
    soldQuantity: opts.soldQuantity,
  });
  return score;
}

export function volumeSettingsSnapshot(): Record<string, number | string> {
  return {
    ml_hub_sync_limit: syncCreateLinkLimit(),
    harvest_max_coupons: harvestMaxCoupons(),
    harvest_max_items: harvestMaxItems(),
    harvest_mint_links: harvestMintLinks(),
    ml_hub_min_commission: getSetting("ml_hub_min_commission", "10"),
  };
}
