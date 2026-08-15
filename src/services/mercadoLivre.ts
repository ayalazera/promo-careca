import {
  canCallProvider,
  cacheGet,
  cacheSet,
  jitterDelayMs,
  mintMercadoLivreAffiliateUrl,
  recordProviderResult,
} from "./pulseGuard.js";
import {
  getMercadoLivreCreds,
  saveMercadoLivreCreds,
} from "./credentialVault.js";
import type { IncomingDeal } from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mapMlCategory(categoryId: string | undefined): string {
  if (!categoryId) return "geral";
  // Heurística por prefixos comuns MLBR
  if (categoryId.startsWith("MLB1051") || categoryId.startsWith("MLB1000")) {
    return "eletronicos";
  }
  if (categoryId.startsWith("MLB1144")) return "games";
  if (categoryId.startsWith("MLB1132") || categoryId.startsWith("MLB1839")) {
    return "tcg";
  }
  return "geral";
}

/** Renova access_token com refresh_token quando a app OAuth está configurada. */
export async function refreshMlTokenIfNeeded(): Promise<boolean> {
  const creds = getMercadoLivreCreds();
  if (!creds.refreshToken || !creds.clientId || !creds.clientSecret) {
    return Boolean(creds.accessToken);
  }

  const gate = canCallProvider("mercadolivre");
  if (!gate.ok) return Boolean(creds.accessToken);

  await sleep(jitterDelayMs("mercadolivre"));
  const started = Date.now();
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
    });
    const res = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      recordProviderResult("mercadolivre", {
        ok: false,
        status: res.status,
        latencyMs,
        detail: "refresh_token",
      });
      return Boolean(creds.accessToken);
    }
    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (json.access_token) {
      saveMercadoLivreCreds({
        accessToken: json.access_token,
        refreshToken: json.refresh_token || creds.refreshToken,
      });
      recordProviderResult("mercadolivre", {
        ok: true,
        status: 200,
        latencyMs,
        detail: "token renovado",
      });
      return true;
    }
    return Boolean(creds.accessToken);
  } catch (err) {
    recordProviderResult("mercadolivre", {
      ok: false,
      latencyMs: Date.now() - started,
      detail: err instanceof Error ? err.message : String(err),
    });
    return Boolean(creds.accessToken);
  }
}

export async function searchMercadoLivreDeals(
  query: string,
): Promise<IncomingDeal[]> {
  await refreshMlTokenIfNeeded();
  const creds = getMercadoLivreCreds();
  if (!creds.accessToken) return [];

  const cacheKey = `ml:search:${query.toLowerCase()}`;
  const cached = cacheGet(cacheKey) as IncomingDeal[] | null;
  if (cached?.length) return cached;

  const gate = canCallProvider("mercadolivre");
  if (!gate.ok) return [];

  await sleep(jitterDelayMs("mercadolivre"));
  const started = Date.now();
  try {
    const url = new URL("https://api.mercadolibre.com/sites/MLB/search");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "5");
    // Relevância / procura — não o mais barato (docs: sort em sites/MLB/search)
    url.searchParams.set("sort", "relevance");

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      recordProviderResult("mercadolivre", {
        ok: false,
        status: res.status,
        latencyMs,
        detail: query,
      });
      return [];
    }

    const json = (await res.json()) as {
      results?: Array<{
        id: string;
        title: string;
        price: number;
        original_price?: number | null;
        permalink: string;
        thumbnail?: string;
        category_id?: string;
      }>;
    };

    recordProviderResult("mercadolivre", {
      ok: true,
      status: 200,
      latencyMs,
      detail: query,
    });

    const deals: IncomingDeal[] = (json.results ?? []).map((r) => ({
      external_id: r.id,
      source: "mercadolivre",
      title: r.title,
      description: "",
      category: mapMlCategory(r.category_id),
      price: r.price,
      old_price: r.original_price ?? null,
      currency: "BRL",
      coupon: null,
      image_url: r.thumbnail || null,
      product_url: r.permalink,
      affiliate_url: mintMercadoLivreAffiliateUrl(
        r.permalink,
        creds.affiliateTag,
      ),
    }));

    cacheSet(cacheKey, deals, 120);
    return deals;
  } catch (err) {
    recordProviderResult("mercadolivre", {
      ok: false,
      latencyMs: Date.now() - started,
      detail: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
