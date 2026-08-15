import { getDb, logAntiBan } from "../db/index.js";

export type ProviderId = "amazon" | "mercadolivre";

type PulseState = {
  heat: number; // 0..100
  budgetPerHour: number;
  usedThisHour: number;
  hourStartedAt: number;
  openCircuitUntil: number;
  lastLatencyMs: number;
  successStreak: number;
  failStreak: number;
};

const state: Record<ProviderId, PulseState> = {
  amazon: {
    heat: 8,
    budgetPerHour: 30,
    usedThisHour: 0,
    hourStartedAt: Date.now(),
    openCircuitUntil: 0,
    lastLatencyMs: 0,
    successStreak: 0,
    failStreak: 0,
  },
  mercadolivre: {
    heat: 8,
    budgetPerHour: 22,
    usedThisHour: 0,
    hourStartedAt: Date.now(),
    openCircuitUntil: 0,
    lastLatencyMs: 0,
    successStreak: 0,
    failStreak: 0,
  },
};

function rollHour(p: ProviderId): void {
  const s = state[p];
  if (Date.now() - s.hourStartedAt < 3600_000) return;
  s.hourStartedAt = Date.now();
  s.usedThisHour = 0;
  s.heat = Math.max(0, s.heat - 12);
}

/**
 * Pulse Reputation Guard
 * Mede "calor" da API (erros, 429, latência) e corta sozinho antes do ban/throttle duro.
 * Também usa cache local para quase não repetir a mesma consulta.
 */
export function getPulseStatus(provider?: ProviderId) {
  if (provider) {
    rollHour(provider);
    return { [provider]: { ...state[provider] } };
  }
  rollHour("amazon");
  rollHour("mercadolivre");
  return {
    amazon: { ...state.amazon },
    mercadolivre: { ...state.mercadolivre },
  };
}

export function canCallProvider(provider: ProviderId): {
  ok: boolean;
  reason?: string;
  waitMs?: number;
} {
  rollHour(provider);
  const s = state[provider];
  if (Date.now() < s.openCircuitUntil) {
    return {
      ok: false,
      reason: "circuit breaker aberto",
      waitMs: s.openCircuitUntil - Date.now(),
    };
  }
  if (s.heat >= 85) {
    return { ok: false, reason: "heat alto — resfriando", waitMs: 15 * 60_000 };
  }
  // Orçamento dinâmico: quanto mais calor, menos chamadas
  const softBudget = Math.max(
    3,
    Math.floor(s.budgetPerHour * (1 - s.heat / 130)),
  );
  if (s.usedThisHour >= softBudget) {
    return {
      ok: false,
      reason: `orçamento horário (${softBudget}) esgotado`,
      waitMs: 10 * 60_000,
    };
  }
  return { ok: true };
}

export function jitterDelayMs(provider: ProviderId): number {
  const s = state[provider];
  // ML: 1.5–6s+ conforme heat (humano); Amazon um pouco mais rápido
  const base =
    provider === "mercadolivre" ? 1600 + s.heat * 55 : 800 + s.heat * 40;
  const spread =
    provider === "mercadolivre" ? 1400 + s.heat * 40 : 600 + s.heat * 25;
  return Math.floor(base + Math.random() * spread);
}

export function recordProviderResult(
  provider: ProviderId,
  opts: {
    ok: boolean;
    status?: number;
    latencyMs?: number;
    detail?: string;
  },
): void {
  rollHour(provider);
  const s = state[provider];
  s.usedThisHour += 1;
  if (opts.latencyMs) s.lastLatencyMs = opts.latencyMs;

  if (opts.ok) {
    s.successStreak += 1;
    s.failStreak = 0;
    s.heat = Math.max(0, s.heat - 2 - Math.min(3, Math.floor(s.successStreak / 5)));
    logAntiBan("pulse_ok", `${provider} heat=${s.heat} ${opts.detail || ""}`);
    return;
  }

  s.failStreak += 1;
  s.successStreak = 0;
  let bump = 8;
  if (opts.status === 429) bump = 28;
  if (opts.status === 403 || opts.status === 401) bump = 35;
  if (opts.status && opts.status >= 500) bump = 18;
  s.heat = Math.min(100, s.heat + bump + s.failStreak * 2);

  if (opts.status === 429 || s.heat >= 90 || s.failStreak >= 3) {
    const coolMin = opts.status === 429 ? 45 : 25;
    s.openCircuitUntil = Date.now() + coolMin * 60_000;
    logAntiBan(
      "pulse_circuit",
      `${provider} aberto ${coolMin}min heat=${s.heat} status=${opts.status ?? "-"}`,
    );
  } else {
    logAntiBan(
      "pulse_fail",
      `${provider} heat=${s.heat} status=${opts.status ?? "-"} ${opts.detail || ""}`,
    );
  }
}

export function cacheGet(key: string): unknown | null {
  const row = getDb()
    .prepare(
      `SELECT payload, expires_at FROM api_cache WHERE cache_key = ?`,
    )
    .get(key) as { payload: string; expires_at: string } | undefined;
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    getDb().prepare("DELETE FROM api_cache WHERE cache_key = ?").run(key);
    return null;
  }
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

export function cacheSet(key: string, payload: unknown, ttlMinutes: number): void {
  const expires = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO api_cache (cache_key, payload, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         payload = excluded.payload,
         expires_at = excluded.expires_at`,
    )
    .run(key, JSON.stringify(payload), expires);
}

/** Mint local do link afiliado — zero chamada à API. */
export function mintAmazonAffiliateUrl(asinOrUrl: string, partnerTag: string): string {
  const asinMatch = asinOrUrl.match(/([A-Z0-9]{10})/i);
  if (asinMatch) {
    return `https://www.amazon.com.br/dp/${asinMatch[1]}?tag=${encodeURIComponent(partnerTag)}`;
  }
  try {
    const u = new URL(asinOrUrl);
    u.searchParams.set("tag", partnerTag);
    return u.toString();
  } catch {
    return asinOrUrl;
  }
}

/**
 * Programa novo de Afiliados/Criadores do ML:
 * - cada produto gera um link curto https://meli.la/...
 * - ID tipo RLHYPL-3RZ4 é ID do PRODUCT share, não do afiliado
 * - identidade do criador: /social/username (ex.: ocarafmz)
 */
export function mintMercadoLivreAffiliateUrl(
  url: string,
  affiliateTag: string,
): string {
  const tag = (affiliateTag || "").trim();

  // Já é um link de afiliado curto do produto
  if (/^https?:\/\/(meli\.la|www\.meli\.la)\//i.test(url)) {
    return url;
  }
  if (/^https?:\/\/(meli\.la|www\.meli\.la)\//i.test(tag)) {
    // tag não deve ser usada como URL genérica de todos os produtos
    return url;
  }

  // ID de produto no formato SHARE (XXXX-XXXX) — NÃO é tag global
  if (/^[A-Z0-9]{4,10}-[A-Z0-9]{3,8}$/i.test(tag)) {
    return url;
  }

  // Formato antigo matt_tool / tag (programa legado)
  try {
    const u = new URL(url);
    if (tag && !/^[a-z0-9._]+$/i.test(tag)) {
      u.searchParams.set("matt_tool", tag);
    } else if (tag && tag.length > 2 && tag.includes("-") === false) {
      // username criador — não altera a URL do produto
      return url;
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** Extrai ID de produto + meli.la do texto de "Compartilhar" do ML. */
export function parseMercadoLivreShareText(raw: string): {
  productShareId: string | null;
  shortLink: string | null;
  hint: string;
} {
  const text = raw.trim();
  const short =
    text.match(/https?:\/\/(?:www\.)?meli\.la\/[A-Za-z0-9]+/i)?.[0] || null;
  const idFromLabel =
    text.match(/ID:\s*([A-Z0-9]+-[A-Z0-9]+)/i)?.[1] || null;
  const idLoose =
    text.match(/\b([A-Z0-9]{4,10}-[A-Z0-9]{3,8})\b/i)?.[1] || null;
  const productShareId = idFromLabel || idLoose || null;

  if (short && productShareId) {
    return {
      productShareId,
      shortLink: short,
      hint: "ID do produto + link meli.la (afiliado deste item). O afiliado/criador é o seu /social/usuario.",
    };
  }
  if (short) {
    return {
      productShareId: null,
      shortLink: short,
      hint: "Link meli.la deste produto detectado.",
    };
  }
  if (productShareId) {
    return {
      productShareId,
      shortLink: null,
      hint: "ID do produto no Compartilhar (não é ID da sua conta afiliada).",
    };
  }
  return {
    productShareId: null,
    shortLink: null,
    hint: "Não achei ID/meli.la. Cole o texto completo do Compartilhar.",
  };
}

export function parseMercadoLivreProfile(
  raw: string,
): { username: string | null; profileUrl: string | null; hint: string } {
  const s = raw.trim();
  const fromUrl = s.match(
    /mercadolivre\.com\.br\/social\/([a-zA-Z0-9._-]+)/i,
  );
  if (fromUrl?.[1]) {
    const username = fromUrl[1];
    return {
      username,
      profileUrl: `https://www.mercadolivre.com.br/social/${username}`,
      hint: `Perfil criador detectado: @${username}`,
    };
  }
  if (/^@?[a-zA-Z0-9._]{3,40}$/.test(s) && !s.includes("-")) {
    const username = s.replace(/^@/, "");
    return {
      username,
      profileUrl: `https://www.mercadolivre.com.br/social/${username}`,
      hint: `Usuário criador: @${username}`,
    };
  }
  return {
    username: null,
    profileUrl: null,
    hint: "Cole a URL do perfil social, ex.: https://www.mercadolivre.com.br/social/ocarafmz",
  };
}
