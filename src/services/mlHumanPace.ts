/**
 * Ritmo humano para Hub/API do Mercado Livre.
 * Evita rajadas que forçam re-login no PC/celular.
 *
 * Estratégia:
 * - Fila serial global (1 request “pesado” por vez)
 * - Gaps longos com jitter (parecer pessoa)
 * - Circuit breaker após rate-limit / sessão morta
 * - Preferir API pública Bearer (itens/prices) com budget baixo;
 *   Hub cookie só para createLink / cupons / input-code
 */
import { getSetting, getSettingNum, logAntiBan, setSetting } from "../db/index.js";

type PaceKind = "api" | "hub" | "link" | "coupon" | "list" | "search";

const lastAt: Record<PaceKind, number> = {
  api: 0,
  hub: 0,
  link: 0,
  coupon: 0,
  list: 0,
  search: 0,
};

let chain: Promise<void> = Promise.resolve();
let coolUntil = 0;

function kindGapMs(kind: PaceKind): { min: number; max: number } {
  switch (kind) {
    case "link":
      return {
        min: getSettingNum("ml_hub_link_delay_ms", 9000, 6500, 25000),
        max: getSettingNum("ml_hub_link_delay_ms", 9000, 6500, 25000) + 5000,
      };
    case "coupon":
      return { min: 14_000, max: 28_000 };
    case "list":
      return { min: 2500, max: 5500 };
    case "search":
      return { min: 3500, max: 7000 };
    case "hub":
      return { min: 1800, max: 4200 };
    case "api":
    default:
      return {
        min: getSettingNum("ml_api_gap_ms", 1200, 600, 8000),
        max: getSettingNum("ml_api_gap_ms", 1200, 600, 8000) + 1800,
      };
  }
}

function randBetween(a: number, b: number): number {
  return Math.floor(a + Math.random() * Math.max(1, b - a + 1));
}

export function mlCoolingMs(): number {
  return Math.max(0, coolUntil - Date.now());
}

export function noteMlRateLimit(detail = ""): void {
  const mins = getSettingNum("ml_rate_limit_cool_min", 35, 10, 120);
  coolUntil = Date.now() + mins * 60_000;
  setSetting("ml_cool_until", new Date(coolUntil).toISOString());
  logAntiBan("ml_human_cool", `${mins}min ${detail}`.trim());
}

export function noteMlSessionDead(detail = ""): void {
  coolUntil = Date.now() + 20 * 60_000;
  setSetting("ml_cool_until", new Date(coolUntil).toISOString());
  logAntiBan("ml_human_session", detail.slice(0, 160));
}

/** Pausa humana antes de um hit no ML (respeita fila + cooldown). */
export async function mlHumanPause(kind: PaceKind = "api"): Promise<void> {
  const run = async () => {
    const cool = mlCoolingMs();
    if (cool > 0) {
      logAntiBan("ml_human_wait_cool", `${kind} ${Math.round(cool / 1000)}s`);
      await new Promise((r) => setTimeout(r, Math.min(cool, 120_000)));
    }
    const { min, max } = kindGapMs(kind);
    const elapsed = Date.now() - (lastAt[kind] || 0);
    const need = randBetween(min, max);
    if (elapsed < need) {
      await new Promise((r) => setTimeout(r, need - elapsed));
    }
    // micro-pausa extra (humano)
    await new Promise((r) => setTimeout(r, randBetween(120, 900)));
    lastAt[kind] = Date.now();
  };

  const next = chain.then(run, run);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  await next;
}

export function mlPaceSnapshot() {
  return {
    coolingMs: mlCoolingMs(),
    coolUntil: getSetting("ml_cool_until", ""),
    gaps: {
      link: kindGapMs("link"),
      coupon: kindGapMs("coupon"),
      api: kindGapMs("api"),
      hub: kindGapMs("hub"),
    },
    lastAt: { ...lastAt },
  };
}
