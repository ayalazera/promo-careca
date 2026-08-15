/**
 * Reposição automática da fila quando abaixo do limiar (padrão <15)
 * e buffer alvo 3× a meta diária da família.
 */
import { getDb, getSettingNum, logAntiBan } from "../db/index.js";
import {
  categoryFamily,
  queueBufferTarget,
} from "./competitorTargets.js";

export function countQueuedForFamily(
  family: "tcg" | "eletronicos" | "achadinhos" | "other",
): number {
  const db = getDb();
  if (family === "tcg") {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM deals
           WHERE status = 'queued' AND coupon_status = 'valid' AND category = 'tcg'`,
        )
        .get() as { c: number }
    ).c;
  }
  if (family === "eletronicos") {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM deals
           WHERE status = 'queued' AND coupon_status = 'valid'
             AND category IN ('eletronicos','celulares','informatica','eletrodomesticos')`,
        )
        .get() as { c: number }
    ).c;
  }
  if (family === "achadinhos") {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM deals
           WHERE status = 'queued' AND coupon_status = 'valid'
             AND category NOT IN ('tcg')
             AND category NOT IN ('eletronicos','celulares','informatica','eletrodomesticos')`,
        )
        .get() as { c: number }
    ).c;
  }
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM deals WHERE status = 'queued' AND coupon_status = 'valid'`,
      )
      .get() as { c: number }
  ).c;
}

export type QueueDeficit = {
  family: "tcg" | "eletronicos" | "achadinhos";
  queued: number;
  bufferTarget: number;
  refillBelow: number;
  needsRefill: boolean;
};

export function queueDeficits(): QueueDeficit[] {
  const refillBelow = getSettingNum("queue_refill_below", 15, 5, 80);
  const families = ["tcg", "eletronicos", "achadinhos"] as const;
  return families.map((family) => {
    const queued = countQueuedForFamily(family);
    const bufferTarget = queueBufferTarget(family);
    return {
      family,
      queued,
      bufferTarget,
      refillBelow,
      needsRefill: queued < refillBelow || queued < Math.ceil(bufferTarget * 0.25),
    };
  });
}

export async function refillQueuesIfLow(): Promise<{
  ran: boolean;
  deficits: QueueDeficit[];
  harvested?: unknown;
}> {
  const deficits = queueDeficits();
  const needy = deficits.filter((d) => d.needsRefill);
  if (!needy.length) return { ran: false, deficits };

  logAntiBan(
    "queue_refill",
    needy.map((d) => `${d.family}:${d.queued}/${d.bufferTarget}`).join(", "),
  );

  const preferCodes: string[] = [];
  for (const d of needy) {
    if (d.family === "tcg") preferCodes.push("BRINQUEDOS", "LIVROS");
    if (d.family === "eletronicos") preferCodes.push("ECONOMIAML", "TECHEMCASA");
    if (d.family === "achadinhos") {
      preferCodes.push("SEMPREMODA", "MODANOMELI", "OFFMELI", "MELIACHA");
    }
  }

  const { ingestDealsFromCouponLists } = await import("./couponHarvest.js");
  const harvested = await ingestDealsFromCouponLists({
    maxCoupons: Math.min(3, 1 + needy.length),
    maxItemsPerCoupon: 8,
    mintLinks: 8,
    preferCodes: [...new Set(preferCodes)],
  });

  // Sync Hub leve se ainda muito baixo
  const after = queueDeficits();
  if (after.some((d) => d.queued < 8)) {
    try {
      const { syncTopCommissionDeals } = await import("./mlHub.js");
      await syncTopCommissionDeals({ limit: 16 });
    } catch (err) {
      logAntiBan(
        "queue_refill_hub_err",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { ran: true, deficits: after, harvested };
}

export function activeGroupFamilies(): Array<{
  groupId: number;
  name: string;
  family: ReturnType<typeof categoryFamily>;
  queuedHint: number;
}> {
  const groups = getDb()
    .prepare(`SELECT id, name, categories FROM wa_groups WHERE active = 1`)
    .all() as Array<{ id: number; name: string; categories: string }>;
  return groups.map((g) => {
    const family = categoryFamily(g.categories);
    return {
      groupId: g.id,
      name: g.name,
      family,
      queuedHint: countQueuedForFamily(family),
    };
  });
}
