/**
 * Confirma no ML (widget input-code / catálogo) se o cupom ainda está vivo.
 * Nunca anuncia “esgotado” só porque um produto falhou (mínimo, preço lixo, token).
 */
import { getSetting, logAntiBan, setSetting } from "../db/index.js";
import { hubSessionReady } from "./mlHub.js";
import { resolveCouponByInputCode } from "./couponTipDiscovery.js";
import { listStoredCoupons } from "./mlCoupons.js";
import { mlHumanPause, noteMlRateLimit } from "./mlHumanPace.js";

export type CouponLiveVerdict =
  | { live: true; source: string; detail: string }
  | { live: false; source: string; detail: string }
  | { live: null; source: string; detail: string }; // inconclusivo — NÃO avisar esgotado

const cache = new Map<string, { at: number; verdict: CouponLiveVerdict }>();

function cacheTtlMs(): number {
  return Math.max(5, Number(getSetting("coupon_live_cache_min", "20")) || 20) * 60_000;
}

/** Motivos que NÃO significam cupom morto globalmente. */
export function isTransientCouponFail(detail: string): boolean {
  const d = String(detail || "").toLowerCase();
  return (
    /sem token|token ml|no_session|rate.?limit|circuit|heat|orçamento|tivemos um problema|tente novamente|http 401|http 403|http 429|http 5\d\d|preço listado inválido|r\$\s*0[,.]0|exige m[ií]n|m[ií]nimo|leve \d+ un|pending|pulse|timeout|econn|network|fetch failed|session/i.test(
      d,
    )
  );
}

/** Só textos que indicam morte real do código no ML. */
export function isConfirmedDeadCouponText(detail: string): boolean {
  const d = String(detail || "").toLowerCase();
  if (isTransientCouponFail(d)) return false;
  return (
    /sold[_ ]?out|esgotad|expirad|n[aã]o existe|nao existe|inv[aá]lido|invalid.?coupon|cupom.*n[aã]o.*encontr|campaign.*(inactive|expired)|status=closed/i.test(
      d,
    )
  );
}

export async function confirmCouponLiveOnMl(
  code: string,
): Promise<CouponLiveVerdict> {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) {
    return { live: null, source: "empty", detail: "sem código" };
  }

  const hit = cache.get(clean);
  if (hit && Date.now() - hit.at < cacheTtlMs()) return hit.verdict;

  // 1) Catálogo local ACTIVE (rápido, sem hit no ML)
  const stored = listStoredCoupons(200).find(
    (c) => String(c.code || "").toUpperCase() === clean,
  );
  if (stored && String(stored.status).toUpperCase() === "ACTIVE") {
    const exp = stored.expiresAt ? Date.parse(stored.expiresAt) : NaN;
    if (!Number.isFinite(exp) || exp > Date.now() + 60_000) {
      const verdict: CouponLiveVerdict = {
        live: true,
        source: "catalog",
        detail: `catálogo ACTIVE${stored.expiresAt ? ` até ${stored.expiresAt}` : ""}`,
      };
      cache.set(clean, { at: Date.now(), verdict });
      return verdict;
    }
  }

  if (!hubSessionReady()) {
    const verdict: CouponLiveVerdict = {
      live: null,
      source: "no_session",
      detail: "Hub offline — não dá para confirmar esgotamento",
    };
    cache.set(clean, { at: Date.now(), verdict });
    return verdict;
  }

  // 2) input-code no ML (ritmo humano — caro)
  const last = Number(getSetting("last_input_code_at_ms", "0")) || 0;
  const minGap = Math.max(
    12_000,
    Number(getSetting("ml_input_code_gap_ms", "18000")) || 18_000,
  );
  const wait = last + minGap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  await mlHumanPause("coupon");
  setSetting("last_input_code_at_ms", String(Date.now()));

  const resolved = await resolveCouponByInputCode(clean);
  if (resolved.responseCode === "RATE_LIMIT") {
    noteMlRateLimit("input-code");
    const verdict: CouponLiveVerdict = {
      live: null,
      source: "rate_limit",
      detail: resolved.message || "rate limit ML",
    };
    cache.set(clean, { at: Date.now(), verdict });
    return verdict;
  }

  const codeUp = String(resolved.responseCode || "").toUpperCase();
  if (
    ["VALID", "PENDING", "ALREADY_ACTIVATED", "ALREADY_ADDED"].includes(codeUp) ||
    resolved.usable
  ) {
    const verdict: CouponLiveVerdict = {
      live: true,
      source: "input-code",
      detail: `${codeUp || "usable"} ${resolved.message || ""}`.trim(),
    };
    cache.set(clean, { at: Date.now(), verdict });
    logAntiBan("coupon_live_ok", `${clean} ${verdict.detail}`);
    return verdict;
  }

  if (
    ["SOLD_OUT", "EXPIRED", "INACTIVE", "NOT_FOUND", "INVALID"].includes(codeUp) ||
    isConfirmedDeadCouponText(`${codeUp} ${resolved.message || ""}`)
  ) {
    const verdict: CouponLiveVerdict = {
      live: false,
      source: "input-code",
      detail: `${codeUp} ${resolved.message || ""}`.trim(),
    };
    cache.set(clean, { at: Date.now(), verdict });
    logAntiBan("coupon_live_dead", `${clean} ${verdict.detail}`);
    return verdict;
  }

  const verdict: CouponLiveVerdict = {
    live: null,
    source: "input-code",
    detail: `inconclusivo ${codeUp} ${resolved.message || ""}`.trim(),
  };
  cache.set(clean, { at: Date.now(), verdict });
  return verdict;
}
