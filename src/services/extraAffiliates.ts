import type { IncomingDeal } from "../types.js";
import {
  getAwinCreds,
  getMagaluCreds,
  getShopeeCreds,
  magaluConfigured,
  shopeeConfigured,
  awinConfigured,
} from "./credentialVault.js";

function mintShopeeUrl(productUrl: string, affiliateId: string): string {
  try {
    const u = new URL(productUrl);
    if (affiliateId) u.searchParams.set("utm_source", `an_${affiliateId}`);
    return u.toString();
  } catch {
    return productUrl;
  }
}

function mintMagaluUrl(productUrl: string, partnerId: string): string {
  try {
    const u = new URL(productUrl);
    if (partnerId) u.searchParams.set("partner_id", partnerId);
    return u.toString();
  } catch {
    return productUrl;
  }
}

function mintAwinUrl(productUrl: string, publisherId: string): string {
  // Deep link genérico Awin — campanhas específicas usam awin1.com/cread.php
  if (!publisherId) return productUrl;
  return `https://www.awin1.com/cread.php?awinmid=0&awinaffid=${encodeURIComponent(publisherId)}&ued=${encodeURIComponent(productUrl)}`;
}

export function demoExtraDeals(stamp = Date.now()): IncomingDeal[] {
  const shopee = getShopeeCreds();
  const magalu = getMagaluCreds();
  const awin = getAwinCreds();

  return [
    {
      external_id: `demo-shopee-${stamp}`,
      source: "shopee",
      title: "Kit Skincare Facial Completo",
      description:
        "Limpeza + hidratação em um kit.\nIdeal para rotina diária.\nEmbalagem para presente.\nCupom de plataforma pode expirar rápido.",
      category: "geral",
      price: 79.9,
      old_price: 129.9,
      currency: "BRL",
      coupon: "BELEZA15",
      image_url:
        "https://images.unsplash.com/photo-1556228578-0d85b1a4d571?auto=format&fit=crop&w=1080&q=80",
      product_url: "https://shopee.com.br/product/demo-skincare",
      affiliate_url: mintShopeeUrl(
        "https://shopee.com.br/product/demo-skincare",
        shopee.affiliateId || "demo",
      ),
    },
    {
      external_id: `demo-magalu-${stamp}`,
      source: "magalu",
      title: "Air Fryer 4L Digital",
      description:
        "Cesta antiaderente.\nPainel digital touch.\nReceitas rápidas no dia a dia.\nFrete conforme CEP.",
      category: "casa",
      price: 299.0,
      old_price: 449.0,
      currency: "BRL",
      coupon: "CASA10",
      image_url:
        "https://images.unsplash.com/photo-1585515320310-47224c0b6d3b?auto=format&fit=crop&w=1080&q=80",
      product_url: "https://www.magazineluiza.com.br/demo-airfryer",
      affiliate_url: mintMagaluUrl(
        "https://www.magazineluiza.com.br/demo-airfryer",
        magalu.partnerId || "demo",
      ),
    },
    {
      external_id: `demo-americanas-${stamp}`,
      source: "americanas",
      title: "Smartwatch Esportivo GPS",
      description:
        "Monitor cardíaco e GPS.\nBateria de longa duração.\nÀ prova d'água.\nOferta via rede Awin.",
      category: "eletronicos",
      price: 219.9,
      old_price: 349.9,
      currency: "BRL",
      coupon: null,
      image_url:
        "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=1080&q=80",
      product_url: "https://www.americanas.com.br/demo-smartwatch",
      affiliate_url: mintAwinUrl(
        "https://www.americanas.com.br/demo-smartwatch",
        awin.publisherId || "demo",
      ),
    },
  ];
}

/**
 * Hooks reais: com credenciais, aqui entram as APIs oficiais.
 * Sem keys, retorna [] e o fetchDeals usa demoExtraDeals no fallback.
 */
export async function fetchExtraAffiliateDeals(): Promise<IncomingDeal[]> {
  const out: IncomingDeal[] = [];

  // Shopee Affiliate GraphQL / Offer API — plugar quando appId/secret estiverem ativos
  if (shopeeConfigured()) {
    // Mantém silencioso até keys reais; mint local já cobre links
  }

  if (magaluConfigured()) {
    // Magazine Você API
  }

  if (awinConfigured()) {
    // Awin Product / Deep Link API
  }

  return out;
}

export function mintLinkForSource(source: string, url: string): string {
  if (source === "shopee") {
    return mintShopeeUrl(url, getShopeeCreds().affiliateId);
  }
  if (source === "magalu") {
    return mintMagaluUrl(url, getMagaluCreds().partnerId);
  }
  if (source === "americanas" || source === "awin") {
    return mintAwinUrl(url, getAwinCreds().publisherId);
  }
  return url;
}
