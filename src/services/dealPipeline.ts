import { getDb, getSetting, type Deal, type WaGroup } from "../db/index.js";
import { formatBrDateTime } from "./timeBr.js";
import {
  estimateNextSendAt,
  getCadence,
  effectiveGroupIntervalMin,
} from "./antiBan.js";
import { listQueuedDealsForGroup } from "./affiliates.js";
import { getPriceHistoryVerdict, sparklineForDeal } from "./priceHistory.js";
import { tcgProductKind, cardLanguage } from "./tcgFilter.js";
import { getGroupFocusCoupon } from "./couponCategories.js";

export function getCouponRevalidateSchedule(): {
  intervalMinutes: number;
  lastAt: string | null;
  lastAtBr: string;
  nextAt: string;
  nextAtBr: string;
  holdCount: number;
} {
  const intervalMinutes = Math.max(
    5,
    Number(getSetting("coupon_revalidate_minutes", "25")) || 25,
  );
  const lastAt = getSetting("coupon_watch_last_at", "") || null;
  const lastMs = lastAt ? Date.parse(lastAt) : 0;
  const nextMs =
    lastMs > 0 ? lastMs + intervalMinutes * 60_000 : Date.now() + 60_000;
  const nextAt = new Date(Math.max(nextMs, Date.now())).toISOString();
  const holdCount = (
    getDb()
      .prepare(`SELECT COUNT(*) AS c FROM deals WHERE status = 'hold_coupon'`)
      .get() as { c: number }
  ).c;
  return {
    intervalMinutes,
    lastAt,
    lastAtBr: lastAt ? formatBrDateTime(lastAt) : "ainda não rodou",
    nextAt,
    nextAtBr: formatBrDateTime(nextAt),
    holdCount,
  };
}

export type PipelineDeal = {
  id: number;
  title: string;
  category: string;
  coupon: string | null;
  couponStatus: string;
  price: number;
  oldPrice: number | null;
  status: string;
  imageUrl: string | null;
  hasMeliLa: boolean;
  ready: boolean;
  focusMatch: boolean;
  scheduledAt: string | null;
  scheduledAtBr: string;
  sentAt: string | null;
  sentAtBr: string;
  reason: string | null;
  lowest30d: boolean;
  notLowest: boolean;
  sparkline: number[];
  tcgKind: string;
  language: string;
};

export type GroupPipePages = {
  queued: number;
  hold: number;
  posted: number;
};

export type GroupPipeline = {
  id: number;
  name: string;
  categories: string;
  active: boolean;
  focusCoupon: string | null;
  lastPostedAt: string | null;
  lastPostedAtBr: string;
  nextSendAt: string | null;
  nextSendAtBr: string;
  queued: PipelineDeal[];
  hold: PipelineDeal[];
  posted: PipelineDeal[];
  queuedTotal: number;
  holdTotal: number;
  postedTotal: number;
  readyTotal: number;
  pages: {
    queued: number;
    hold: number;
    posted: number;
  };
  page: GroupPipePages;
  pageSize: number;
};

function dealHasMeliLa(d: Deal): boolean {
  return /meli\.la\//i.test(String(d.affiliate_url || ""));
}

function dealReady(d: Deal): boolean {
  if (String(d.source || "").toLowerCase() === "mercadolivre" && !dealHasMeliLa(d)) {
    return false;
  }
  if (d.coupon_status !== "valid") return false;
  if (!String(d.coupon || "").trim()) return false;
  if (!(Number(d.price_with_coupon || d.price) > 0)) return false;
  return true;
}

function summarizeDeal(
  d: Deal,
  extra?: {
    scheduledAt?: Date | null;
    sentAt?: string | null;
    reason?: string | null;
    focusCode?: string | null;
  },
): PipelineDeal {
  const scheduled = extra?.scheduledAt || null;
  const sent = extra?.sentAt || d.posted_at || null;
  const focus = String(extra?.focusCode || "")
    .trim()
    .toUpperCase();
  const code = String(d.coupon || "")
    .trim()
    .toUpperCase();
  return {
    id: d.id,
    title: d.title,
    category: d.category,
    coupon: d.coupon,
    couponStatus: d.coupon_status,
    price: d.price_with_coupon || d.price,
    oldPrice: d.old_price,
    status: d.status,
    imageUrl: d.image_url || null,
    hasMeliLa: dealHasMeliLa(d),
    ready: dealReady(d),
    focusMatch: Boolean(focus && code && focus === code),
    scheduledAt: scheduled ? scheduled.toISOString() : null,
    scheduledAtBr: scheduled ? formatBrDateTime(scheduled) : "—",
    sentAt: sent,
    sentAtBr: sent ? formatBrDateTime(sent) : "—",
    reason: extra?.reason || null,
    lowest30d: getPriceHistoryVerdict(d).isLowest === true,
    notLowest: getPriceHistoryVerdict(d).isWorseThanHistory,
    sparkline: sparklineForDeal(d),
    tcgKind: tcgProductKind(d.title),
    language: cardLanguage(d.title),
  };
}

/** Parseia `5:q2,h1,p1;7:q3` ou JSON `{"5":{"queued":2}}`. */
export function parseGroupPages(
  raw: string | undefined | null,
): Record<number, Partial<GroupPipePages>> {
  const out: Record<number, Partial<GroupPipePages>> = {};
  const s = String(raw || "").trim();
  if (!s) return out;
  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s) as Record<
        string,
        { queued?: number; hold?: number; posted?: number; q?: number; h?: number; p?: number }
      >;
      for (const [k, v] of Object.entries(obj || {})) {
        const id = Number(k);
        if (!Number.isFinite(id) || !v) continue;
        out[id] = {
          queued: Math.max(1, Number(v.queued ?? v.q) || 1),
          hold: Math.max(1, Number(v.hold ?? v.h) || 1),
          posted: Math.max(1, Number(v.posted ?? v.p) || 1),
        };
      }
      return out;
    } catch {
      /* fall through */
    }
  }
  // 5:q2,h1;7:q3  ou  5=2 (só fila)
  for (const chunk of s.split(";")) {
    const part = chunk.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)[=:](.+)$/);
    if (!m) continue;
    const id = Number(m[1]);
    if (!Number.isFinite(id)) continue;
    const rest = m[2].trim();
    if (/^\d+$/.test(rest)) {
      out[id] = { ...(out[id] || {}), queued: Math.max(1, Number(rest) || 1) };
      continue;
    }
    const entry: Partial<GroupPipePages> = { ...(out[id] || {}) };
    for (const token of rest.split(",")) {
      const t = token.trim().toLowerCase();
      const tm = t.match(/^(q|h|p|queued|hold|posted)(\d+)$/);
      if (!tm) continue;
      const n = Math.max(1, Number(tm[2]) || 1);
      if (tm[1] === "q" || tm[1] === "queued") entry.queued = n;
      else if (tm[1] === "h" || tm[1] === "hold") entry.hold = n;
      else entry.posted = n;
    }
    out[id] = entry;
  }
  return out;
}

function pageSlice<T>(rows: T[], page: number, pageSize: number): T[] {
  const p = Math.max(1, page);
  const start = (p - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

function pagesFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(total, 1) / pageSize));
}

export function getDealsPipeline(opts?: {
  groupId?: number;
  category?: string;
  /** @deprecated paginação global — preferir groupPages */
  page?: number;
  pageSize?: number;
  q?: string;
  groupPages?: Record<number, Partial<GroupPipePages>>;
  /** Só ofertas prontas (meli.la + cupom válido) na fila */
  readyOnly?: boolean;
}): {
  cadence: ReturnType<typeof getCadence>;
  groups: GroupPipeline[];
  next2h: Array<PipelineDeal & { groupName: string }>;
  page: number;
  pageSize: number;
  pages: number;
  total: number;
  readyTotal: number;
  couponWatch: {
    intervalMinutes: number;
    lastAt: string | null;
    lastAtBr: string;
    nextAt: string;
    nextAtBr: string;
    holdCount: number;
  };
} {
  const cadence = getCadence();
  const couponWatch = getCouponRevalidateSchedule();
  const legacyPage = Math.max(1, opts?.page || 1);
  const pageSize = Math.min(24, Math.max(4, opts?.pageSize || 6));
  const q = String(opts?.q || "").trim().toLowerCase();
  const groupPages = opts?.groupPages || {};
  const readyOnly = Boolean(opts?.readyOnly);

  let groups = getDb()
    .prepare(`SELECT * FROM wa_groups ORDER BY active DESC, id ASC`)
    .all() as WaGroup[];

  if (opts?.groupId) {
    groups = groups.filter((g) => g.id === opts.groupId);
  }
  if (opts?.category) {
    const cat = opts.category.toLowerCase();
    groups = groups.filter((g) =>
      (g.categories || "")
        .toLowerCase()
        .split(",")
        .map((s) => s.trim())
        .includes(cat),
    );
  }

  const result: GroupPipeline[] = groups.map((g) => {
    const focusCode = getGroupFocusCoupon(g.id);
    const gp = groupPages[g.id] || {};
    const qPage = Math.max(1, Number(gp.queued) || legacyPage);
    const hPage = Math.max(1, Number(gp.hold) || legacyPage);
    const pPage = Math.max(1, Number(gp.posted) || legacyPage);

    // Visão operacional: fila completa do grupo (não só o cupom em foco).
    const queuedAllRaw = g.active ? listQueuedDealsForGroup(g, 240) : [];
    let queuedAll = q
      ? queuedAllRaw.filter((d) =>
          `${d.title} ${d.coupon || ""} ${d.external_id || ""} ${d.affiliate_url || ""} ${d.product_url || ""}`
            .toLowerCase()
            .includes(q),
        )
      : queuedAllRaw;
    if (readyOnly) queuedAll = queuedAll.filter((d) => dealReady(d));
    // Prontos primeiro; depois foco do cupom; depois score natural da lista.
    queuedAll = [...queuedAll].sort((a, b) => {
      const ra = dealReady(a) ? 1 : 0;
      const rb = dealReady(b) ? 1 : 0;
      if (rb !== ra) return rb - ra;
      const fa =
        focusCode &&
        String(a.coupon || "").toUpperCase() === focusCode.toUpperCase()
          ? 1
          : 0;
      const fb =
        focusCode &&
        String(b.coupon || "").toUpperCase() === focusCode.toUpperCase()
          ? 1
          : 0;
      return fb - fa;
    });
    const queuedTotal = queuedAll.length;
    const readyTotal = queuedAllRaw.filter((d) => dealReady(d)).length;
    const queuedRows = pageSlice(queuedAll, qPage, pageSize);

    const holdCats = (g.categories || "geral")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const holdIncludeAll = holdCats.includes("geral");
    const holdAllRaw = (
      holdIncludeAll
        ? (getDb()
            .prepare(
              `SELECT * FROM deals WHERE status = 'hold_coupon' AND category NOT IN ('tcg') ORDER BY id DESC LIMIT 120`,
            )
            .all() as Deal[])
        : holdCats.length
          ? (getDb()
              .prepare(
                `SELECT * FROM deals WHERE status = 'hold_coupon' AND category IN (${holdCats.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 120`,
              )
              .all(...holdCats) as Deal[])
          : []
    );
    const holdAll = q
      ? holdAllRaw.filter((d) =>
          `${d.title} ${d.coupon || ""}`.toLowerCase().includes(q),
        )
      : holdAllRaw;
    const holdTotal = holdAll.length;
    const hold = pageSlice(holdAll, hPage, pageSize).map((d) =>
      summarizeDeal(d, { focusCode }),
    );

    const intervalMin = effectiveGroupIntervalMin(g);
    let cursor = estimateNextSendAt({
      lastPostedAt: g.last_posted_at,
      intervalMinutes: intervalMin,
    });
    const gapMs = Math.max(intervalMin * 60_000, cadence.minDelaySec * 1000);
    const queued = queuedRows.map((d, i) => {
      const scheduled =
        i === 0 && qPage === 1
          ? cursor
          : estimateNextSendAt({
              lastPostedAt: cursor.toISOString(),
              intervalMinutes: Math.round(gapMs / 60_000),
              fromMs: cursor.getTime() + gapMs,
            });
      cursor = scheduled;
      return summarizeDeal(d, { scheduledAt: scheduled, focusCode });
    });

    const postedCount = (
      getDb()
        .prepare(
          `SELECT COUNT(*) AS c FROM post_logs p
           LEFT JOIN deals d ON d.id = p.deal_id
           WHERE p.group_id = ? AND p.ok = 1
             AND (? = '' OR lower(COALESCE(d.title,'')) LIKE ? OR lower(COALESCE(p.reason,'')) LIKE ?)`,
        )
        .get(g.id, q, `%${q}%`, `%${q}%`) as { c: number }
    ).c;

    const postedRows = getDb()
      .prepare(
        `SELECT d.id AS deal_id, d.title, d.category, d.coupon, d.coupon_status,
                d.price, d.price_with_coupon, d.status, d.posted_at, d.image_url,
                d.affiliate_url,
                p.created_at AS sent_at, p.reason AS send_reason
         FROM post_logs p
         LEFT JOIN deals d ON d.id = p.deal_id
         WHERE p.group_id = ? AND p.ok = 1
           AND (? = '' OR lower(COALESCE(d.title,'')) LIKE ? OR lower(COALESCE(p.reason,'')) LIKE ?)
         ORDER BY p.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(
        g.id,
        q,
        `%${q}%`,
        `%${q}%`,
        pageSize,
        (pPage - 1) * pageSize,
      ) as Array<{
      deal_id: number | null;
      title: string | null;
      category: string | null;
      coupon: string | null;
      coupon_status: string | null;
      price: number | null;
      price_with_coupon: number | null;
      status: string | null;
      posted_at: string | null;
      image_url: string | null;
      affiliate_url: string | null;
      sent_at: string;
      send_reason: string | null;
    }>;

    const posted = postedRows.map((r) => {
      const title =
        r.title ||
        (r.send_reason && /aviso_cupom/i.test(r.send_reason)
          ? r.send_reason.replace(/^aviso_cupom_/, "Cupom ")
          : r.send_reason || "Envio");
      const fake = {
        id: r.deal_id || 0,
        external_id: "",
        source: "mercadolivre",
        title,
        description: "",
        category: r.category || "",
        price: r.price_with_coupon || r.price || 0,
        old_price: null,
        currency: "BRL",
        coupon: r.coupon,
        coupon_status: (r.coupon_status as Deal["coupon_status"]) || "none",
        price_with_coupon: r.price_with_coupon,
        coupon_tested_at: null,
        coupon_alert_sent: 0,
        image_url: r.image_url,
        product_url: "",
        affiliate_url: r.affiliate_url || "",
        commission_pct: null,
        free_shipping: 0,
        status: (r.status as Deal["status"]) || "posted",
        created_at: r.sent_at,
        posted_at: r.posted_at,
      } satisfies Deal;
      return summarizeDeal(fake, {
        sentAt: r.sent_at,
        reason: r.send_reason || null,
        focusCode,
      });
    });

    const next = queued[0]?.scheduledAt
      ? new Date(queued[0].scheduledAt)
      : g.active
        ? estimateNextSendAt({
            lastPostedAt: g.last_posted_at,
            intervalMinutes: effectiveGroupIntervalMin(g),
          })
        : null;

    return {
      id: g.id,
      name: g.name,
      categories: g.categories,
      active: Boolean(g.active),
      focusCoupon: focusCode,
      lastPostedAt: g.last_posted_at,
      lastPostedAtBr: formatBrDateTime(g.last_posted_at),
      nextSendAt: next ? next.toISOString() : null,
      nextSendAtBr: next ? formatBrDateTime(next) : "—",
      queued,
      hold,
      posted,
      queuedTotal,
      holdTotal,
      postedTotal: postedCount,
      readyTotal,
      pages: {
        queued: pagesFor(queuedTotal, pageSize),
        hold: pagesFor(holdTotal, pageSize),
        posted: pagesFor(postedCount, pageSize),
      },
      page: { queued: qPage, hold: hPage, posted: pPage },
      pageSize,
    };
  });

  const readyTotal = result.reduce((m, g) => m + g.readyTotal, 0);
  const maxQueued = result.reduce((m, g) => Math.max(m, g.queuedTotal), 0);
  const maxPosted = result.reduce((m, g) => Math.max(m, g.postedTotal), 0);
  const maxHold = result.reduce((m, g) => Math.max(m, g.holdTotal), 0);
  const pages = Math.max(
    1,
    Math.ceil(Math.max(maxQueued, maxPosted, maxHold, 1) / pageSize),
  );

  const horizon = Date.now() + 2 * 3600_000;
  const next2h = result
    .flatMap((g) =>
      g.queued
        .filter(
          (d) =>
            d.ready &&
            d.scheduledAt &&
            Date.parse(d.scheduledAt) <= horizon,
        )
        .map((d) => ({ ...d, groupName: g.name })),
    )
    .slice(0, 12);

  return {
    cadence,
    groups: result,
    next2h,
    page: legacyPage,
    pageSize,
    pages,
    total: maxQueued + maxPosted,
    readyTotal,
    couponWatch,
  };
}
