import { getSetting, logAntiBan, setSetting } from "../db/index.js";
import { fetchDeals, upsertDeals } from "../services/affiliates.js";
import {
  revalidateCouponsContinuously,
  runPublishWave,
} from "../services/publisher.js";
import { hubSessionReady, syncTopCommissionDeals } from "../services/mlHub.js";

let fetchTimer: NodeJS.Timeout | null = null;
let publishTimer: NodeJS.Timeout | null = null;
let couponTimer: NodeJS.Timeout | null = null;
let hubTimer: NodeJS.Timeout | null = null;
let runningFetch = false;
let runningPublish = false;
let runningCoupon = false;
let runningHub = false;
let pruneTimer: NodeJS.Timeout | null = null;
let runningPrune = false;
let listPushTimer: NodeJS.Timeout | null = null;
let runningListPush = false;

async function tickListPrune(): Promise<void> {
  if (runningPrune) return;
  if (getSetting("scheduler_enabled", "1") !== "1") return;
  runningPrune = true;
  try {
    const { runScheduledListPrune } = await import("../services/mlLists.js");
    const out = await runScheduledListPrune();
    if (out.ran && out.result) {
      logAntiBan(
        "ml_list_prune_tick",
        `lists=${out.result.lists} checked=${out.result.checked} removed=${out.result.removed}`,
      );
    }
  } catch (err) {
    logAntiBan(
      "ml_list_prune_err",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    runningPrune = false;
  }
}

/**
 * Empurra fila → listas ML em tick SEPARADO do Sync/createLink (anti-ban).
 * Distribui por categoria mapeada (sem priorizar TCG).
 */
async function tickListPush(): Promise<void> {
  if (runningListPush || runningHub) return;
  if (getSetting("scheduler_enabled", "1") !== "1") return;
  if (getSetting("ml_list_auto_push", "1") !== "1") return;
  if (getSetting("ml_list_push_products", "0") !== "1") return;
  if (!hubSessionReady()) return;
  runningListPush = true;
  try {
    const { pushQueuedDealsToMappedLists } = await import(
      "../services/mlLists.js"
    );
    const maxPerList = Math.min(
      10,
      Number(getSetting("ml_list_push_max_per_sync", "8")) || 8,
    );
    // Empurra todas as categorias mapeadas com o mesmo orçamento (sem priorizar TCG)
    const all = await pushQueuedDealsToMappedLists({
      maxPerList,
    });
    const { getListMap, getListItems, fillMappedListsFromOfficialStores } =
      await import("../services/mlLists.js");
    const map = getListMap();
    for (const cat of Object.keys(map)) {
      const listId = map[cat]?.id;
      if (!listId) continue;
      const items = await getListItems(listId);
      const target =
        Number(getSetting(`ml_list_target_${cat}`, cat === "tcg" ? "28" : "18")) ||
        18;
      if (items.length < Math.min(12, target)) {
        await fillMappedListsFromOfficialStores({
          category: cat,
          maxPerList: Math.min(8, Math.max(2, target - items.length)),
        });
      }
    }
    if (all.added) {
      logAntiBan(
        "ml_list_push_tick",
        `all=+${all.added} max=${maxPerList} lists=${all.byList?.length || 0}`,
      );
    }
  } catch (err) {
    logAntiBan(
      "ml_list_push_tick_err",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    runningListPush = false;
  }
}

async function tickFetch(): Promise<void> {
  if (runningFetch) return;
  if (getSetting("scheduler_enabled", "1") !== "1") return;
  const sources = (getSetting("enabled_sources", "mercadolivre") || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // Com só ML ativo, o Sync Hub é a fonte — evita buscar Amazon/Shopee/demo
  if (sources.length === 1 && sources[0] === "mercadolivre") {
    return;
  }
  runningFetch = true;
  try {
    const deals = await fetchDeals();
    const n = upsertDeals(deals);
    if (n > 0) logAntiBan("fetch_ok", `${n} novas ofertas (${sources.join(",")})`);
  } catch (err) {
    logAntiBan(
      "fetch_err",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    runningFetch = false;
  }
}

async function tickHub(): Promise<void> {
  if (runningHub || runningListPush) return;
  if (getSetting("scheduler_enabled", "1") !== "1") return;
  if (getSetting("ml_hub_auto_sync", "0") !== "1") return;
  if (!hubSessionReady()) {
    const { noteHubSessionDead } = await import("../services/mlHub.js");
    noteHubSessionDead("Sync automático: Cookie/CSRF ausente");
    return;
  }
  runningHub = true;
  try {
    // Sync SEM push de listas no mesmo ciclo (anti-ban createLink)
    const result = await syncTopCommissionDeals({ pushToList: false });
    if (!result.ok && /401|403|csrf|expir/i.test(result.error || "")) {
      const { noteHubSessionDead } = await import("../services/mlHub.js");
      noteHubSessionDead(result.error || "Hub recusou a sessão");
    }
    logAntiBan(
      "ml_hub_tick",
      result.ok
        ? `linked=${result.linked} inserted=${result.inserted}`
        : result.error || "falhou",
    );
    if (result.ok) {
      try {
        const { ingestDealsFromCouponLists } = await import(
          "../services/couponHarvest.js"
        );
        const harvest = await ingestDealsFromCouponLists({});
        logAntiBan(
          "ml_hub_tick_harvest",
          `coupons=${harvest.coupons} products=${harvest.products} linked=${harvest.linked}`,
        );
      } catch (err) {
        logAntiBan(
          "ml_hub_tick_harvest_err",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    try {
      const { sanitizeSyncedQueue } = await import(
        "../services/queueSanitize.js"
      );
      const cleaned = sanitizeSyncedQueue();
      if (cleaned.deleted) {
        logAntiBan(
          "ml_hub_tick_sanitize",
          `deleted=${cleaned.deleted} kept=${cleaned.kept} ${JSON.stringify(cleaned.reasons)}`,
        );
      }
    } catch {
      /* sanitize não pode derrubar o tick */
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/401|403|csrf|expir/i.test(msg)) {
      const { noteHubSessionDead } = await import("../services/mlHub.js");
      noteHubSessionDead(msg);
    }
    logAntiBan("ml_hub_tick_err", msg);
  } finally {
    runningHub = false;
  }
}

async function tickPublish(): Promise<void> {
  if (runningPublish) return;
  if (getSetting("scheduler_enabled", "1") !== "1") return;
  if (getSetting("maintenance_mode", "0") === "1") return;
  runningPublish = true;
  try {
    try {
      const { backupSqliteIfDue } = await import("../services/dbBackup.js");
      backupSqliteIfDue();
    } catch {
      /* backup não pode derrubar o post */
    }
    // Refill no máx. a cada 25 min (evita martelar o Hub/ML)
    try {
      const last = Number(getSetting("last_queue_refill_at_ms", "0")) || 0;
      if (Date.now() - last > 25 * 60_000) {
        const { refillQueuesIfLow } = await import("../services/queueRefill.js");
        const out = await refillQueuesIfLow();
        if (out.ran) setSetting("last_queue_refill_at_ms", String(Date.now()));
      }
    } catch {
      /* refill não bloqueia o post */
    }
    const result = await runPublishWave();
    if (result.sent > 0 || result.blockedReason) {
      logAntiBan(
        "publish_tick",
        `sent=${result.sent} attempted=${result.attempted} block=${result.blockedReason || "-"}`,
      );
    }
  } catch (err) {
    logAntiBan(
      "publish_err",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    runningPublish = false;
  }
}

async function tickCoupons(): Promise<void> {
  if (runningCoupon) return;
  if (getSetting("scheduler_enabled", "1") !== "1") return;
  runningCoupon = true;
  try {
    const lastSync = getSetting("ml_coupons_synced_at", "");
    const today = new Date().toISOString().slice(0, 10);
    const lastFullDay = getSetting("ml_coupons_full_sync_day", "");
    const syncAgeMs = lastSync ? Date.now() - Date.parse(lastSync) : Number.POSITIVE_INFINITY;
    // Novos/tips a cada ~90min — ritmo humano (evita forçar re-login)
    const catalogStale =
      !Number.isFinite(syncAgeMs) || syncAgeMs > 90 * 60_000;
    const tipsAge = getSetting("ml_coupon_tips_synced_at", "");
    const tipsStale =
      !tipsAge || Date.now() - Date.parse(tipsAge) > 60 * 60_000;

    try {
      const { syncMlCouponsCatalog, testDigitibleCatalogCoupons } =
        await import("../services/mlCoupons.js");
      if (lastFullDay !== today) {
        const sync = await syncMlCouponsCatalog({ maxPagesPerKey: 3, mode: "all" });
        setSetting("ml_coupons_full_sync_day", today);
        logAntiBan(
          "ml_coupons_daily_sync",
          `stored=${sync.stored} active=${sync.active} tips=${sync.tips?.newCodes?.join(",") || "-"}`,
        );
        try {
          const tested = await testDigitibleCatalogCoupons(4);
          setSetting("ml_coupons_tested_day", today);
          logAntiBan(
            "ml_coupons_daily_test",
            `tested=${tested.tested} ok=${tested.ok} dead=${tested.dead}`,
          );
        } catch (err) {
          logAntiBan(
            "ml_coupons_daily_test_err",
            err instanceof Error ? err.message : String(err),
          );
        }
      } else if (catalogStale) {
        const sync = await syncMlCouponsCatalog({
          maxPagesPerKey: 2,
          mode: "new",
        });
        logAntiBan(
          "ml_coupons_new_sync",
          `stored=${sync.stored} active=${sync.active} tipsNew=${sync.tips?.newCodes?.join(",") || "-"} usable=${sync.tips?.usable?.join(",") || "-"}`,
        );
        try {
          const { enrichQueuedDealsWithCoupons } = await import(
            "../services/mlCoupons.js"
          );
          const cross = await enrichQueuedDealsWithCoupons({
            category: "tcg",
            limit: 10,
            syncFirst: false,
          });
          logAntiBan(
            "ml_coupons_new_tcg",
            `matched=${cross.matched} failed=${cross.failed}`,
          );
        } catch (err) {
          logAntiBan(
            "ml_coupons_new_tcg_err",
            err instanceof Error ? err.message : String(err),
          );
        }
      } else if (tipsStale) {
        // Entre syncs: só tips/input-code (leve) — pega LIBROS* assim que sai
        const { discoverAndIngestTipCoupons } = await import(
          "../services/couponTipDiscovery.js"
        );
        const tips = await discoverAndIngestTipCoupons({ maxResolve: 3 });
        logAntiBan(
          "ml_coupons_tip_tick",
          `stored=${tips.stored} new=${tips.newCodes.join(",") || "-"} usable=${tips.usable.join(",") || "-"} soldOut=${tips.soldOut.join(",") || "-"}`,
        );
      }
    } catch (err) {
      logAntiBan(
        "ml_coupons_daily_sync_err",
        err instanceof Error ? err.message : String(err),
      );
    }
    const result = await revalidateCouponsContinuously();
    try {
      const { ingestDealsFromCouponLists } = await import(
        "../services/couponHarvest.js"
      );
      const harvest = await ingestDealsFromCouponLists({});
      if (harvest.products) {
        logAntiBan(
          "coupon_harvest_tick",
          `coupons=${harvest.coupons} products=${harvest.products} tested=${harvest.tested} linked=${harvest.linked}`,
        );
      }
      const { sanitizeSyncedQueue } = await import(
        "../services/queueSanitize.js"
      );
      sanitizeSyncedQueue();
    } catch (err) {
      logAntiBan(
        "coupon_harvest_tick_err",
        err instanceof Error ? err.message : String(err),
      );
    }
    try {
      const { enrichQueuedDealsWithCoupons } = await import(
        "../services/mlCoupons.js"
      );
      const cross = await enrichQueuedDealsWithCoupons({
        limit: 12,
        syncFirst: false,
      });
      if (cross.matched || cross.failed) {
        logAntiBan(
          "ml_coupons_enrich_tick",
          `matched=${cross.matched} failed=${cross.failed}`,
        );
      }
    } catch (err) {
      logAntiBan(
        "ml_coupons_enrich_tick_err",
        err instanceof Error ? err.message : String(err),
      );
    }
    let announced = { announcedValid: 0, announcedExhausted: 0, pending: 0, details: [] as string[] };
    try {
      const { processCouponAnnouncements } = await import("../services/couponBroadcast.js");
      announced = await processCouponAnnouncements({ priority: true });
    } catch {
      /* WhatsApp pode estar offline */
    }
    if (result.checked > 0 || announced.announcedValid || announced.announcedExhausted || result.removed) {
      logAntiBan(
        "coupon_watch",
        `checked=${result.checked} valid=${result.stillValid} dead=${result.invalidated} removed=${result.removed || 0} alerts=${result.alertsSent} couponPosts=${announced.announcedValid}/${announced.announcedExhausted}`,
      );
    }
  } catch (err) {
    logAntiBan(
      "coupon_watch_err",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    runningCoupon = false;
  }
}

export function startScheduler(): void {
  const fetchMin = Number(getSetting("fetch_interval_minutes", "25")) || 25;
  const couponMin = Math.max(
    20,
    Number(getSetting("coupon_revalidate_minutes", "25")) || 25,
  );
  const hubMin = Number(getSetting("ml_hub_sync_interval_minutes", "90")) || 90;
  const listPushMin = Math.max(
    30,
    Number(getSetting("ml_list_auto_push_interval_minutes", "50")) || 50,
  );

  if (!fetchTimer) {
    void tickFetch();
    fetchTimer = setInterval(() => void tickFetch(), fetchMin * 60_000);
  }
  if (!publishTimer) {
    // 30s: permite intercalação ~1 min entre grupos (13 grupos)
    publishTimer = setInterval(() => void tickPublish(), 30_000);
    setTimeout(() => void tickPublish(), 15_000);
  }
  if (!couponTimer) {
    void tickCoupons();
    couponTimer = setInterval(() => void tickCoupons(), couponMin * 60_000);
  }
  if (!hubTimer) {
    void tickHub();
    hubTimer = setInterval(() => void tickHub(), hubMin * 60_000);
  }
  if (!pruneTimer) {
    // checa a cada hora se já passou o intervalo (N vezes/dia)
    void tickListPrune();
    pruneTimer = setInterval(() => void tickListPrune(), 60 * 60_000);
  }
  if (!listPushTimer) {
    // atrasar o 1º push para não coincidir com Sync no boot
    setTimeout(() => void tickListPush(), 90_000);
    listPushTimer = setInterval(() => void tickListPush(), listPushMin * 60_000);
  }
}

export function stopScheduler(): void {
  if (fetchTimer) clearInterval(fetchTimer);
  if (publishTimer) clearInterval(publishTimer);
  if (couponTimer) clearInterval(couponTimer);
  if (hubTimer) clearInterval(hubTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  if (listPushTimer) clearInterval(listPushTimer);
  fetchTimer = null;
  publishTimer = null;
  couponTimer = null;
  hubTimer = null;
  pruneTimer = null;
  listPushTimer = null;
}

export async function runOnce(): Promise<void> {
  await tickHub();
  await tickFetch();
  await tickListPush();
  await tickCoupons();
  await tickPublish();
}

export function updateCouponInterval(minutes: number): void {
  setSetting("coupon_revalidate_minutes", String(minutes));
  if (couponTimer) {
    clearInterval(couponTimer);
    couponTimer = setInterval(() => void tickCoupons(), minutes * 60_000);
  }
}
