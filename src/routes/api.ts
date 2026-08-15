import { Router, raw as expressRaw } from "express";
import { config } from "../config.js";
import {
  categoriesForMeta,
  deleteCategory,
  listCategories,
  seedSuggestedCategories,
  upsertCategory,
} from "../services/categories.js";
import { formatBrDateTime } from "../services/timeBr.js";
import {
  brandLogoExists,
  brandLogoPath,
  saveBrandLogoFromBase64,
  saveGroupLogoFromBase64,
  saveGroupLogoFromBuffer,
  groupLogoPath,
  watermarkProductImage,
  generateInviteQrPng,
  normalizeInviteUrl,
} from "../services/imageWatermark.js";
import { resolveGroupBrand } from "../services/groupBrand.js";
import { resolveDealPrices } from "../services/dealDisplay.js";
import {
  ensureAllLayoutPreviews,
  ensureLayoutPreview,
} from "../services/layoutPreviews.js";
import { IMAGE_LAYOUTS, resolveImageLayout } from "../services/imageLayouts.js";
import fs from "node:fs";
import { roadmapSummary } from "../roadmap/ideas100.js";
import { roadmap120Summary } from "../roadmap/ideas120.js";
import { dailySendReport } from "../services/dailyReport.js";
import { buildRunbook } from "../services/runbook.js";
import {
  couponConversionRanking,
  weeklyTopPosts,
  monthlyAudit,
} from "../services/couponRanking.js";
import { competitorVolumePanel } from "../services/competitorTargets.js";
import { queueDeficits } from "../services/queueRefill.js";
import {
  buildInternalPriceRef,
  listSellerHistoryApi,
} from "../services/internalPriceRef.js";
import { dualWaStatus } from "../services/waDualSession.js";
import {
  AFFILIATE_SOURCES,
  DEFAULT_POST_TEMPLATE,
  GROUP_NAME_SUGGESTIONS,
} from "../affiliateCatalog.js";
import {
  getDb,
  getSetting,
  getSettingNum,
  setSetting,
  logAntiBan,
  type Deal,
  type WaGroup,
} from "../db/index.js";
import {
  clearPause,
  getAntiBanStatus,
  pauseSending,
} from "../services/antiBan.js";
import { previewSendReset, resetSends, undoLastSendReset } from "../services/sendReset.js";
import { getSyncProgress } from "../services/syncProgress.js";
import { fetchDeals, upsertDeals } from "../services/affiliates.js";
import { composePromoMessage } from "../services/composer.js";
import type { IncomingDeal } from "../types.js";
import { runOnce, updateCouponInterval } from "../jobs/scheduler.js";
import {
  createWhatsAppGroup,
  getInviteLink,
  getWaStatus,
  joinGroupFromInviteLink,
  listWhatsAppGroups,
  listWhatsAppTargets,
  repairCommunityAnnounceJids,
  resolvePostableJid,
  revokeOwnMessagesMatching,
  revokeByWaKey,
  sendGroupText,
  startWhatsApp,
} from "../services/whatsapp.js";
import {
  revalidateCouponsContinuously,
  runPublishWave,
} from "../services/publisher.js";
import {
  clearProviderCreds,
  getCredentialsPublicStatus,
  saveAmazonCreds,
  saveAwinCreds,
  saveMagaluCreds,
  saveMercadoLivreCreds,
  saveShopeeCreds,
} from "../services/credentialVault.js";
import { getPulseStatus } from "../services/pulseGuard.js";
import { parseMercadoLivreShareText } from "../services/pulseGuard.js";
import { applyCouponTestToDeal, forceExpireCoupon } from "../services/couponTester.js";
import {
  composeCouponExpiredMessage,
  notifyCouponExpired,
} from "../services/couponExpiryAlert.js";
import {
  createFleet,
  createNextFleetGroup,
  groupsOfFleet,
  listFleets,
  publicJoinUrl,
  refreshGroupCapacity,
} from "../services/groupFleet.js";
import { getCouponRevalidateSchedule, getDealsPipeline, parseGroupPages } from "../services/dealPipeline.js";

export const api = Router();

api.get("/health", (_req, res) => {
  let dbOk = true;
  try {
    getDb().prepare("SELECT 1").get();
  } catch {
    dbOk = false;
  }
  res.json({
    ok: dbOk,
    service: "promo-autonomo",
    db: dbOk,
    ts: new Date().toISOString(),
  });
});

api.get("/roadmap", (_req, res) => {
  res.json({
    ideas100: roadmapSummary(),
    ideas120: roadmap120Summary(),
    ...roadmap120Summary(),
  });
});

api.get("/volume/targets", (_req, res) => {
  res.json({
    ...competitorVolumePanel(),
    queue: queueDeficits(),
    dualWa: dualWaStatus(),
  });
});

api.get("/deals/:id/price-ref", (req, res) => {
  const id = Number(req.params.id);
  const deal = getDb()
    .prepare(`SELECT * FROM deals WHERE id = ?`)
    .get(id) as Deal | undefined;
  if (!deal) {
    res.status(404).json({ error: "deal não encontrado" });
    return;
  }
  res.json(buildInternalPriceRef(deal));
});

api.get("/sellers/:sellerId/price-history", (req, res) => {
  res.json({
    sellerId: req.params.sellerId,
    samples: listSellerHistoryApi(String(req.params.sellerId), 40),
  });
});

api.get("/meta", (_req, res) => {
  const templates = getDb()
    .prepare("SELECT * FROM post_templates ORDER BY id ASC")
    .all();
  const catMeta = categoriesForMeta();
  res.json({
    categories: catMeta.categories.map((c) => ({
      id: c.id,
      label: c.label,
      emoji: c.emoji,
      active: c.active,
    })),
    categorySuggestions: catMeta.suggestions,
    sources: AFFILIATE_SOURCES,
    nameSuggestions: GROUP_NAME_SUGGESTIONS,
    defaultTemplate: DEFAULT_POST_TEMPLATE,
    imageLayouts: [
      {
        id: "auto",
        name: "Automático (por categoria)",
        blurb: "Escolhe o layout conforme a categoria do grupo",
        previewUrl: null,
      },
      ...IMAGE_LAYOUTS.map((l) => ({
        ...l,
        previewUrl: `/api/layouts/${l.id}/preview`,
      })),
    ],
    templates,
    antiBanDefaults: config.antiBan,
    demoMode: getSetting("demo_mode", "1") === "1",
    schedulerEnabled: getSetting("scheduler_enabled", "1") === "1",
    maintenanceMode: getSetting("maintenance_mode", "0") === "1",
    lunchSilence: getSetting("lunch_silence", "0") === "1",
    postHashtag: getSetting("post_hashtag", "0") === "1",
    postFlashPeak: getSetting("post_flash_peak", "1") === "1",
    holidaySilence: getSetting("holiday_silence", "1") === "1",
    tcgOfficialOnly: getSetting("tcg_official_only", "0") === "1",
    requireMeliLa: getSetting("require_meli_la", "1") === "1",
    knobs: {
      tcgDayLimit: getSettingNum("tcg_day_limit", 45, 8, 200),
      electronicsDayLimit: getSettingNum("electronics_day_limit", 55, 8, 200),
      achadinhosDayLimit: getSettingNum("achadinhos_day_limit", 90, 8, 200),
      interGroupDelaySec: getSettingNum("post_inter_group_delay_sec", 60, 45, 180),
      maxGroupsPerWave: 1,
      warmupWeek1Cap: getSettingNum("warmup_week1_cap", 40, 8, 200),
      stockWarnMax: getSettingNum("stock_warn_max", 8, 1, 80),
      priceRiseSkipPct: getSettingNum("price_rise_skip_pct", 15, 5, 80),
      reprintMinPrice: getSettingNum("reprint_min_price", 180, 50, 5000),
      reprintMinDiscountPct: getSettingNum("reprint_min_discount_pct", 8, 0, 90),
      lunchStart: getSetting("lunch_start", "12:00"),
      lunchEnd: getSetting("lunch_end", "13:30"),
      httpBlockPauseAfter: getSettingNum("http_block_pause_after", 3, 2, 10),
      hubSyncLimit: getSettingNum("ml_hub_sync_limit", 24, 1, 24),
      harvestMaxCoupons: getSettingNum("harvest_max_coupons", 10, 1, 20),
      harvestMaxItems: getSettingNum("harvest_max_items", 14, 1, 30),
      harvestMintLinks: getSettingNum("harvest_mint_links", 20, 0, 48),
    },
    enabledSources: getSetting("enabled_sources", "mercadolivre"),
    couponRevalidateMinutes: Number(
      getSetting("coupon_revalidate_minutes", "25"),
    ),
    couponWatch: getCouponRevalidateSchedule(),
    timezone: "America/Sao_Paulo",
    brand: {
      handle: getSetting("brand_handle", "@carecavip"),
      tagline: getSetting(
        "brand_tagline",
        "O melhor grupo de promoções da internet",
      ),
      groupName: getSetting("brand_group_name", "Careca VIP"),
      public_base_url: getSetting("public_base_url"),
      hasLogo: brandLogoExists(),
    },
  });
});

api.get("/categories", (_req, res) => {
  res.json(categoriesForMeta());
});

api.post("/categories", (req, res) => {
  try {
    const b = req.body ?? {};
    const cat = upsertCategory({
      id: String(b.id || b.label || ""),
      label: String(b.label || b.id || ""),
      emoji: b.emoji != null ? String(b.emoji) : undefined,
      mlCategoryIds: Array.isArray(b.mlCategoryIds)
        ? b.mlCategoryIds.map(String)
        : String(b.mlCategoryIds || b.ml_category_ids || "")
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
      keywords: Array.isArray(b.keywords)
        ? b.keywords.map(String)
        : String(b.keywords || "")
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
      excludeKeywords: Array.isArray(b.excludeKeywords)
        ? b.excludeKeywords.map(String)
        : String(b.excludeKeywords || "")
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
      active: b.active === undefined ? true : Boolean(b.active),
      sortOrder: b.sortOrder != null ? Number(b.sortOrder) : undefined,
      pushToMlList:
        b.pushToMlList === undefined ? undefined : Boolean(b.pushToMlList),
    });
    res.json({ ok: true, category: cat });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/categories/seed-suggestions", (req, res) => {
  const n = seedSuggestedCategories(Boolean(req.body?.activateAll));
  res.json({ ok: true, upserted: n, categories: listCategories() });
});

api.delete("/categories/:id", (req, res) => {
  try {
    deleteCategory(String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.get("/whatsapp/status", (_req, res) => {
  res.json(getWaStatus());
});

api.post("/whatsapp/connect", async (_req, res) => {
  try {
    await startWhatsApp();
    res.json({ ok: true, status: getWaStatus() });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.get("/whatsapp/groups", async (_req, res) => {
  try {
    const groups = await listWhatsAppGroups();
    res.json({ groups });
  } catch (err) {
    res.status(500).json({
      groups: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Grupos + comunidades (avisos) da conta — cadastro em 1 clique. */
api.get("/whatsapp/targets", async (_req, res) => {
  try {
    const targets = await listWhatsAppTargets();
    res.json({
      targets,
      tip: "Para Comunidades, use o grupo de Avisos (community_announce) — histórico das promoções fica lá.",
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/whatsapp/revoke-match", async (req, res) => {
  try {
    const groupId = Number(req.body?.groupId);
    const match = String(req.body?.match || "").trim();
    const fallback = Boolean(req.body?.fallback);
    if (!groupId || !match) {
      res.status(400).json({ error: "groupId e match são obrigatórios" });
      return;
    }
    const row = getDb()
      .prepare(`SELECT id, name, jid FROM wa_groups WHERE id = ?`)
      .get(groupId) as { id: number; name: string; jid: string } | undefined;
    if (!row?.jid) {
      res.status(404).json({ error: "grupo não encontrado" });
      return;
    }
    const result = await revokeOwnMessagesMatching({
      jid: row.jid,
      match,
    });
    let fallbackSent = false;
    if (result.revoked === 0 && fallback) {
      const text = [
        "⚠️ *Correção*",
        "",
        `O aviso anterior do cupom *${match}* foi publicado neste grupo por engano.`,
        "Esse cupom *não vale* nos produtos daqui — podem ignorar aquele post.",
      ].join("\n");
      await sendGroupText(row.jid, text);
      fallbackSent = true;
      getDb()
        .prepare(
          `INSERT INTO post_logs (deal_id, group_id, message_hash, ok, reason)
           VALUES (NULL, ?, ?, 1, ?)`,
        )
        .run(row.id, `revoke-fallback:${match}`, `correcao_cupom:${match}`);
    }
    if (result.revoked > 0) {
      getDb()
        .prepare(
          `UPDATE post_logs SET reason = reason || ' [apagado]'
           WHERE group_id = ? AND ok = 1 AND reason LIKE ? AND reason NOT LIKE '%apagado%'`,
        )
        .run(row.id, `%${match}%`);
    }
    res.json({ ok: result.revoked > 0 || fallbackSent, ...result, fallbackSent });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/whatsapp/revoke-key", async (req, res) => {
  try {
    const waKey = String(req.body?.waKey || "").trim();
    if (!waKey.includes("|")) {
      res.status(400).json({ error: "waKey no formato jid|id" });
      return;
    }
    await revokeByWaKey(waKey);
    res.json({ ok: true, waKey });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Cadastra um alvo já existente na conta (comunidade/grupo) sem invite. */
api.post("/groups/from-target", async (req, res) => {
  try {
    const b = req.body ?? {};
    let jid = String(b.jid || "").trim();
    let name = String(b.name || "").trim();
    const categories = String(b.categories || "").trim();
    if (!jid.endsWith("@g.us") || !name) {
      res.status(400).json({ error: "jid (@g.us) e name obrigatórios" });
      return;
    }
    if (!categories) {
      res.status(400).json({
        error: "Escolha a categoria no formulário antes de importar",
      });
      return;
    }
    let kind = String(b.kind || "group");

    // Nunca cadastrar a comunidade-pai — sempre o canal de Avisos
    if (kind === "community") {
      const resolved = await resolvePostableJid(jid);
      if (resolved.redirectedFrom || resolved.kind === "community_announce") {
        jid = resolved.jid;
        name = resolved.name || name;
        kind = resolved.kind;
      } else {
        res.status(400).json({
          error:
            "Selecione o canal de Avisos da comunidade (não a comunidade-pai).",
        });
        return;
      }
    }

    const brand = resolveGroupBrand({
      name,
      categories,
      watermark_handle: String(b.watermark_handle || ""),
      watermark_tagline: String(b.watermark_tagline || ""),
    });
    const dayLimit = Number(b.day_limit) > 0 ? Number(b.day_limit) : 0;
    const notes = kind.startsWith("community")
      ? `Comunidade WhatsApp (${kind})`
      : "Grupo WhatsApp";

    const existing = getDb()
      .prepare("SELECT id FROM wa_groups WHERE jid = ?")
      .get(jid) as { id: number } | undefined;
    if (existing) {
      getDb()
        .prepare(
          `UPDATE wa_groups SET
             name = ?, categories = ?, active = 1, notes = ?,
             watermark_handle = COALESCE(NULLIF(?, ''), watermark_handle),
             watermark_tagline = COALESCE(NULLIF(?, ''), watermark_tagline),
             interval_minutes = COALESCE(?, interval_minutes),
             sources = COALESCE(NULLIF(?, ''), sources),
             day_limit = COALESCE(?, day_limit)
           WHERE id = ?`,
        )
        .run(
          name,
          categories,
          notes,
          String(b.watermark_handle || "").trim(),
          String(b.watermark_tagline || "").trim(),
          b.interval_minutes != null ? Number(b.interval_minutes) : null,
          b.sources != null ? String(b.sources) : "",
          b.day_limit != null ? Number(b.day_limit) : null,
          existing.id,
        );
      res.json({ ok: true, id: existing.id, updated: true, jid, kind });
      return;
    }
    const info = getDb()
      .prepare(
        `INSERT INTO wa_groups (
           name, jid, categories, interval_minutes, active,
           sources, keywords, notes, watermark_handle, watermark_tagline, day_limit
         ) VALUES (?, ?, ?, ?, 1, ?, '', ?, ?, ?, ?)`,
      )
      .run(
        name,
        jid,
        categories,
        Number(b.interval_minutes || config.defaultIntervalMinutes),
        String(b.sources || getSetting("enabled_sources", "mercadolivre")),
        notes,
        brand.handle,
        brand.tagline,
        dayLimit,
      );
    res.json({
      ok: true,
      id: info.lastInsertRowid,
      updated: false,
      jid,
      kind,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Corrige cadastros que apontam para a comunidade-pai em vez do Avisos. */
api.post("/groups/repair-announce", async (_req, res) => {
  try {
    const fixed = await repairCommunityAnnounceJids();
    res.json({
      ok: true,
      fixed,
      message: fixed.length
        ? `Corrigidos ${fixed.length} destino(s) para o canal de Avisos.`
        : "Nada a corrigir — destinos já apontam para Avisos/grupos.",
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.get("/groups", (_req, res) => {
  const rows = getDb()
    .prepare("SELECT * FROM wa_groups ORDER BY id DESC")
    .all() as WaGroup[];
  res.json({
    groups: rows.map((g) => {
      const brand = resolveGroupBrand(g);
      return {
        ...g,
        watermark_handle: brand.handle,
        watermark_tagline: brand.tagline,
        hasLogo: Boolean(groupLogoPath(g.id)),
        logoUrl: `/api/groups/${g.id}/logo`,
        hasQr: Boolean(normalizeInviteUrl(g.invite_link)),
        qrUrl: `/api/groups/${g.id}/qr`,
      };
    }),
  });
});

/** Lista layouts com URL de preview (gera arte se ainda não existir). */
api.get("/layouts", async (_req, res) => {
  try {
    const previews = await ensureAllLayoutPreviews(false);
    res.json({
      layouts: [
        {
          id: "auto",
          name: "Automático (por categoria)",
          blurb: "Escolhe o layout conforme a categoria do grupo",
          previewUrl: null,
        },
        ...IMAGE_LAYOUTS.map((l) => ({
          ...l,
          previewUrl:
            previews.find((p) => p.id === l.id)?.url ||
            `/api/layouts/${l.id}/preview`,
        })),
      ],
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** JPEG 1080 do layout — gera na hora se faltar arquivo. */
api.get("/layouts/:id/preview", async (req, res) => {
  try {
    let id = String(req.params.id || "")
      .toLowerCase()
      .replace(/\.jpg$/i, "");
    if (id === "auto") {
      const cat = String(req.query.category || "geral");
      id = resolveImageLayout("auto", cat);
    }
    if (!IMAGE_LAYOUTS.some((l) => l.id === id)) {
      res.status(404).json({ error: "layout desconhecido" });
      return;
    }
    const force = String(req.query.refresh || "") === "1";
    const file = await ensureLayoutPreview(
      id as (typeof IMAGE_LAYOUTS)[number]["id"],
      force,
    );
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(fs.readFileSync(file));
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/layouts/refresh-previews", async (_req, res) => {
  try {
    const previews = await ensureAllLayoutPreviews(true);
    res.json({ ok: true, previews });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/groups", (req, res) => {
  const b = req.body ?? {};
  if (!b.name || !b.jid) {
    res.status(400).json({ error: "name e jid são obrigatórios" });
    return;
  }
  try {
    const cats = String(b.categories || "geral");
    const brand = resolveGroupBrand({
      name: String(b.name),
      categories: cats,
      watermark_handle: String(b.watermark_handle || ""),
      watermark_tagline: String(b.watermark_tagline || ""),
    });
    const info = getDb()
      .prepare(
        `INSERT INTO wa_groups (
           name, jid, categories, interval_minutes, active,
           sources, keywords, post_template, notes,
           watermark_handle, watermark_tagline, invite_link, day_limit, promo_url, image_layout
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(b.name),
        String(b.jid),
        cats,
        Number(b.interval_minutes || config.defaultIntervalMinutes),
        b.active === 0 || b.active === false ? 0 : 1,
        String(b.sources || getSetting("enabled_sources", "mercadolivre")),
        String(b.keywords || ""),
        String(b.post_template || ""),
        String(b.notes || ""),
        brand.handle,
        brand.tagline,
        b.invite_link ? String(b.invite_link) : null,
        Number(b.day_limit) > 0 ? Number(b.day_limit) : 0,
        String(b.promo_url || "").trim(),
        String(b.image_layout || "auto").trim() || "auto",
      );
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Cadastra um grupo já criado no WhatsApp: entra pelo link de convite
 * e associa a categoria (propósito) para rotear as promoções.
 */
api.post("/groups/register", async (req, res) => {
  try {
    const b = req.body ?? {};
    const invite = String(b.invite_link || b.invite || "").trim();
    const categories = String(b.categories || "").trim();
    if (!invite) {
      res.status(400).json({ error: "invite_link obrigatório" });
      return;
    }
    if (!categories) {
      res.status(400).json({
        error:
          "categories obrigatório — ex.: eletronicos (propósito do grupo)",
      });
      return;
    }

    const joined = await joinGroupFromInviteLink(invite);
    const name =
      String(b.name || "").trim() || joined.subject || "Comunidade WhatsApp";
    const kindNote =
      joined.kind && joined.kind !== "group"
        ? `Comunidade WhatsApp (${joined.kind})`
        : "Grupo/Comunidade WhatsApp";

    const existing = getDb()
      .prepare("SELECT * FROM wa_groups WHERE jid = ?")
      .get(joined.jid) as WaGroup | undefined;

    if (existing) {
      getDb()
        .prepare(
          `UPDATE wa_groups SET
             name = ?, categories = ?, active = 1,
             sources = COALESCE(NULLIF(?, ''), sources),
             keywords = COALESCE(NULLIF(?, ''), keywords),
             interval_minutes = COALESCE(?, interval_minutes),
             invite_link = ?,
             watermark_handle = COALESCE(NULLIF(?, ''), watermark_handle),
             watermark_tagline = COALESCE(NULLIF(?, ''), watermark_tagline),
             post_template = COALESCE(NULLIF(?, ''), post_template),
             notes = COALESCE(NULLIF(?, ''), notes),
             day_limit = COALESCE(?, day_limit),
             image_layout = COALESCE(NULLIF(?, ''), image_layout),
             promo_url = COALESCE(NULLIF(?, ''), promo_url)
           WHERE id = ?`,
        )
        .run(
          name,
          categories,
          b.sources != null ? String(b.sources) : "",
          b.keywords != null ? String(b.keywords) : "",
          b.interval_minutes != null
            ? Number(b.interval_minutes)
            : null,
          joined.invite_link,
          b.watermark_handle != null ? String(b.watermark_handle) : "",
          b.watermark_tagline != null ? String(b.watermark_tagline) : "",
          b.post_template != null ? String(b.post_template) : "",
          b.notes != null ? String(b.notes) : kindNote,
          b.day_limit != null ? Number(b.day_limit) : null,
          b.image_layout != null ? String(b.image_layout) : "",
          b.promo_url != null ? String(b.promo_url).trim() : "",
          existing.id,
        );
      res.json({
        ok: true,
        id: existing.id,
        jid: joined.jid,
        name,
        categories,
        invite_link: joined.invite_link,
        alreadyMember: joined.alreadyMember,
        kind: joined.kind,
        updated: true,
      });
      return;
    }

    const brand = resolveGroupBrand({
      name,
      categories,
      watermark_handle: String(b.watermark_handle || ""),
      watermark_tagline: String(b.watermark_tagline || ""),
    });
    const info = getDb()
      .prepare(
        `INSERT INTO wa_groups (
           name, jid, categories, interval_minutes, active,
           sources, keywords, post_template, notes,
           watermark_handle, watermark_tagline, invite_link, is_accepting, day_limit, promo_url, image_layout
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        name,
        joined.jid,
        categories,
        Number(b.interval_minutes || config.defaultIntervalMinutes),
        String(b.sources || getSetting("enabled_sources", "mercadolivre")),
        String(b.keywords || ""),
        String(b.post_template || ""),
        String(b.notes || kindNote),
        brand.handle,
        brand.tagline,
        joined.invite_link,
        Number(b.day_limit) > 0 ? Number(b.day_limit) : 0,
        String(b.promo_url || "").trim(),
        String(b.image_layout || "auto").trim() || "auto",
      );

    res.json({
      ok: true,
      id: info.lastInsertRowid,
      jid: joined.jid,
      name,
      categories,
      invite_link: joined.invite_link,
      alreadyMember: joined.alreadyMember,
      kind: joined.kind,
      updated: false,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.patch("/groups/:id", (req, res) => {
  const id = Number(req.params.id);
  const row = getDb()
    .prepare("SELECT * FROM wa_groups WHERE id = ?")
    .get(id) as WaGroup | undefined;
  if (!row) {
    res.status(404).json({ error: "grupo não encontrado" });
    return;
  }
  const b = req.body ?? {};
  const brand = resolveGroupBrand({
    name: String(b.name ?? row.name),
    categories: String(b.categories ?? row.categories),
    watermark_handle: b.watermark_handle ?? row.watermark_handle,
    watermark_tagline: b.watermark_tagline ?? row.watermark_tagline,
  });
  getDb()
    .prepare(
      `UPDATE wa_groups SET
         name = ?, jid = ?, categories = ?, interval_minutes = ?, active = ?,
         sources = ?, keywords = ?, post_template = ?, notes = ?,
         watermark_handle = ?, watermark_tagline = ?,
         invite_link = COALESCE(?, invite_link),
         day_limit = COALESCE(?, day_limit),
         ml_list_id = COALESCE(?, ml_list_id),
         promo_url = ?,
         image_layout = COALESCE(NULLIF(?, ''), image_layout)
       WHERE id = ?`,
    )
    .run(
      b.name ?? row.name,
      b.jid ?? row.jid,
      b.categories ?? row.categories,
      b.interval_minutes ?? row.interval_minutes,
      b.active === undefined ? row.active : b.active ? 1 : 0,
      b.sources ?? row.sources,
      b.keywords ?? row.keywords,
      b.post_template ?? row.post_template,
      b.notes ?? row.notes,
      brand.handle,
      brand.tagline,
      b.invite_link ?? null,
      b.day_limit != null ? Number(b.day_limit) : row.day_limit,
      b.ml_list_id != null ? String(b.ml_list_id) : row.ml_list_id,
      b.promo_url != null ? String(b.promo_url).trim() : row.promo_url || "",
      b.image_layout != null ? String(b.image_layout).trim() : "",
      id,
    );
  res.json({ ok: true });
});

api.post("/groups/:id/logo", async (req, res) => {
  const id = Number(req.params.id);
  const row = getDb()
    .prepare("SELECT id FROM wa_groups WHERE id = ?")
    .get(id) as { id?: number } | undefined;
  if (!row?.id) {
    res.status(404).json({ error: "grupo não encontrado" });
    return;
  }
  try {
    const data = String(req.body?.logoBase64 || req.body?.data || "");
    const logo = await saveGroupLogoFromBase64(id, data);
    res.json({
      ok: true,
      ...logo,
      hasLogo: true,
      url: `/api/groups/${id}/logo`,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Upload binário (image/jpeg|png|webp) — evita PayloadTooLarge do JSON base64. */
api.post(
  "/groups/:id/logo-bin",
  expressRaw({
    type: (req) => {
      const ct = String(req.headers["content-type"] || "");
      return /^image\//i.test(ct) || ct === "application/octet-stream";
    },
    limit: "15mb",
  }),
  async (req, res) => {
    const id = Number(req.params.id);
    const row = getDb()
      .prepare("SELECT id FROM wa_groups WHERE id = ?")
      .get(id) as { id?: number } | undefined;
    if (!row?.id) {
      res.status(404).json({ error: "grupo não encontrado" });
      return;
    }
    try {
      const buf = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(req.body || []);
      const logo = await saveGroupLogoFromBuffer(id, buf);
      res.json({
        ok: true,
        ...logo,
        hasLogo: true,
        url: `/api/groups/${id}/logo`,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

api.get("/groups/:id/logo", (req, res) => {
  const p = groupLogoPath(Number(req.params.id));
  if (!p) {
    res.status(404).json({ error: "sem logo neste grupo" });
    return;
  }
  res.sendFile(p);
});

api.get("/groups/:id/qr", async (req, res) => {
  const id = Number(req.params.id);
  const row = getDb()
    .prepare("SELECT invite_link FROM wa_groups WHERE id = ?")
    .get(id) as { invite_link?: string | null } | undefined;
  const url = normalizeInviteUrl(row?.invite_link);
  if (!url) {
    res.status(404).json({ error: "cadastre o convite do grupo para gerar o QR" });
    return;
  }
  const png = await generateInviteQrPng(url, 360);
  if (!png) {
    res.status(400).json({ error: "não deu para gerar o QR deste convite" });
    return;
  }
  res.setHeader("Content-Type", "image/png");
  res.send(png);
});

api.post("/groups/create-whatsapp", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      res.status(400).json({ error: "name obrigatório" });
      return;
    }
    const created = await createWhatsAppGroup(name);
    const invite = await getInviteLink(created.jid);
    const b = req.body ?? {};
    const cats = String(b.categories || "geral");
    const brand = resolveGroupBrand({
      name,
      categories: cats,
      watermark_handle: String(b.watermark_handle || ""),
      watermark_tagline: String(b.watermark_tagline || ""),
    });
    const info = getDb()
      .prepare(
        `INSERT INTO wa_groups (
           name, jid, categories, interval_minutes, active,
           sources, keywords, post_template, notes,
           watermark_handle, watermark_tagline, invite_link, is_accepting
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        name,
        created.jid,
        cats,
        Number(b.interval_minutes || config.defaultIntervalMinutes),
        String(b.sources || getSetting("enabled_sources", "mercadolivre")),
        String(b.keywords || ""),
        String(b.post_template || ""),
        String(b.notes || ""),
        brand.handle,
        brand.tagline,
        invite,
      );
    res.json({
      ok: true,
      id: info.lastInsertRowid,
      jid: created.jid,
      invite_link: invite,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/groups/:id/invite-link", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = getDb()
      .prepare("SELECT * FROM wa_groups WHERE id = ?")
      .get(id) as WaGroup | undefined;
    if (!row) {
      res.status(404).json({ error: "grupo não encontrado" });
      return;
    }
    const invite = await getInviteLink(row.jid);
    getDb()
      .prepare(`UPDATE wa_groups SET invite_link = ? WHERE id = ?`)
      .run(invite, id);
    res.json({ ok: true, invite_link: invite });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/groups/shorten-url", async (req, res) => {
  try {
    const { shortenHttpUrl } = await import("../services/shortLinks.js");
    const url = String(req.body?.url || "").trim();
    const short = await shortenHttpUrl(url);
    const groupId = Number(req.body?.groupId);
    if (Number.isFinite(groupId) && groupId > 0 && req.body?.save) {
      getDb()
        .prepare(`UPDATE wa_groups SET promo_url = ? WHERE id = ?`)
        .run(short, groupId);
    }
    res.json({ ok: true, short, original: url });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.delete("/groups/:id", (req, res) => {
  getDb().prepare("DELETE FROM wa_groups WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

api.get("/deals", (req, res) => {
  const category = String(req.query.category || "").trim().toLowerCase();
  const status = String(req.query.status || "").trim().toLowerCase();
  const q = String(req.query.q || "").trim().toLowerCase();
  const sort = String(req.query.sort || "date").trim().toLowerCase();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const where: string[] = ["1=1"];
  const params: Array<string | number> = [];
  if (category) {
    where.push("lower(category) = ?");
    params.push(category);
  }
  if (status) {
    where.push("lower(status) = ?");
    params.push(status);
  }
  if (q) {
    where.push(
      "(lower(title) LIKE ? OR lower(coupon) LIKE ? OR lower(external_id) LIKE ? OR lower(product_url) LIKE ? OR lower(affiliate_url) LIKE ?)",
    );
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  const whereSql = where.join(" AND ");
  const orderSql =
    sort === "commission"
      ? "COALESCE(commission_pct, -1) DESC, id DESC"
      : sort === "discount"
        ? "(CASE WHEN old_price > 0 THEN (old_price - price) * 1.0 / old_price ELSE 0 END) DESC, id DESC"
        : "id DESC";
  const total = (
    getDb()
      .prepare(`SELECT COUNT(*) AS c FROM deals WHERE ${whereSql}`)
      .get(...params) as { c: number }
  ).c;
  const deals = getDb()
    .prepare(
      `SELECT * FROM deals WHERE ${whereSql}
       ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as Deal[];
  res.json({
    deals,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

api.get("/deals.csv", (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT id, title, category, price, old_price, coupon, coupon_status, status, external_id, affiliate_url
       FROM deals WHERE status = 'queued' ORDER BY id DESC LIMIT 500`,
    )
    .all() as Array<Record<string, unknown>>;
  const header = [
    "id",
    "title",
    "category",
    "price",
    "old_price",
    "coupon",
    "coupon_status",
    "status",
    "external_id",
    "affiliate_url",
  ];
  const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const body = rows
    .map((r) => header.map((h) => esc(r[h])).join(","))
    .join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=fila.csv");
  res.send(`${header.join(",")}\n${body}`);
});

api.get("/report/daily", (_req, res) => {
  res.json(dailySendReport());
});

api.get("/runbook", (_req, res) => {
  res.json(buildRunbook());
});

api.get("/coupons/ranking", (_req, res) => {
  res.json({ ranking: couponConversionRanking() });
});

api.get("/report/weekly-top", (_req, res) => {
  res.json({ posts: weeklyTopPosts() });
});

api.get("/report/monthly", (_req, res) => {
  res.json(monthlyAudit());
});

api.get("/deals/pipeline", (req, res) => {
  try {
    res.json(
      getDealsPipeline({
        groupId: req.query.groupId ? Number(req.query.groupId) : undefined,
        category: req.query.category
          ? String(req.query.category)
          : undefined,
        page: Number(req.query.page) || 1,
        pageSize: Number(req.query.pageSize) || 6,
        q: req.query.q ? String(req.query.q) : undefined,
        groupPages: parseGroupPages(
          String(req.query.groupPages || req.query.gpages || ""),
        ),
        readyOnly:
          req.query.readyOnly === "1" ||
          req.query.readyOnly === "true",
      }),
    );
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.get("/deals/:id/preview", (req, res) => {
  const deal = getDb()
    .prepare("SELECT * FROM deals WHERE id = ?")
    .get(Number(req.params.id)) as Deal | undefined;
  if (!deal) {
    res.status(404).json({ error: "não encontrado" });
    return;
  }
  const groupId = Number(req.query.group_id || 0);
  const group = groupId
    ? (getDb()
        .prepare("SELECT * FROM wa_groups WHERE id = ?")
        .get(groupId) as WaGroup | undefined)
    : undefined;
  res.json({ text: composePromoMessage(deal, group || null) });
});

api.post("/coupons/revalidate", async (_req, res) => {
  const result = await revalidateCouponsContinuously();
  res.json(result);
});

api.post("/deals/fetch", async (req, res) => {
  if (req.body?.sources != null) {
    const src = Array.isArray(req.body.sources)
      ? req.body.sources.join(",")
      : String(req.body.sources);
    setSetting("enabled_sources", src || "mercadolivre");
  }
  const deals = await fetchDeals();
  const inserted = upsertDeals(deals);
  res.json({
    inserted,
    totalFetched: deals.length,
    sources: getSetting("enabled_sources", "mercadolivre"),
  });
});

api.post("/deals/prune-sources", async (_req, res) => {
  const { pruneDisabledSourceDeals } = await import("../services/affiliates.js");
  res.json(pruneDisabledSourceDeals());
});

/**
 * Importa links já gerados no Hub de Afiliados / Compartilhar.
 * Esta ferramenta NÃO entra na conta ML — só recebe o meli.la que você gerou logado no Hub.
 */
api.post("/deals/import-ml-hub", (req, res) => {
  const raw = String(req.body?.text || "");
  const titleHint = String(req.body?.title || "").trim();
  const price = Number(req.body?.price);
  const category = String(req.body?.category || "geral").trim() || "geral";

  // Aceita vários blocos (um por linha ou separados por linha em branco)
  const blocks = raw
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const chunks = blocks.length > 1 ? blocks : [raw.trim()].filter(Boolean);

  const imported: IncomingDeal[] = [];
  for (const chunk of chunks) {
    const parsed = parseMercadoLivreShareText(chunk);
    if (!parsed.shortLink) continue;
    const idPart =
      parsed.productShareId ||
      parsed.shortLink.replace(/^https?:\/\/(?:www\.)?meli\.la\//i, "");
    imported.push({
      external_id: `hub-${idPart}`,
      source: "mercadolivre",
      title:
        titleHint ||
        (parsed.productShareId
          ? `Produto ML ${parsed.productShareId}`
          : `Produto ML (${idPart})`),
      description:
        "Link gerado no Hub/Compartilhar do ML. Título/preço podem ser editados depois.",
      category,
      price: Number.isFinite(price) && price > 0 ? price : 0,
      old_price: null,
      currency: "BRL",
      coupon: null,
      image_url: null,
      product_url: parsed.shortLink,
      affiliate_url: parsed.shortLink,
    });
  }

  // Também aceita só URLs meli.la soltas (uma por linha)
  if (!imported.length) {
    const urls = raw.match(/https?:\/\/(?:www\.)?meli\.la\/[A-Za-z0-9]+/gi) || [];
    for (const u of urls) {
      const slug = u.replace(/^https?:\/\/(?:www\.)?meli\.la\//i, "");
      imported.push({
        external_id: `hub-${slug}`,
        source: "mercadolivre",
        title: titleHint || `Produto ML (${slug})`,
        description: "Link gerado no Hub de Afiliados do Mercado Livre.",
        category,
        price: Number.isFinite(price) && price > 0 ? price : 0,
        old_price: null,
        currency: "BRL",
        coupon: null,
        image_url: null,
        product_url: u,
        affiliate_url: u,
      });
    }
  }

  if (!imported.length) {
    res.status(400).json({
      error:
        "Cole o texto do Compartilhar ou o link meli.la gerado no Hub (logado na sua conta).",
      hub: "https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true",
    });
    return;
  }

  const inserted = upsertDeals(imported);
  res.json({
    ok: true,
    inserted,
    total: imported.length,
    note: "Links do Hub importados. Esta ferramenta não acessa sua conta ML.",
  });
});

api.get("/antiban", (req, res) => {
  const type = String(req.query.type || "").trim();
  const eventsSql = type
    ? `SELECT * FROM antiban_events WHERE event_type LIKE ? ORDER BY id DESC LIMIT 80`
    : `SELECT * FROM antiban_events ORDER BY id DESC LIMIT 50`;
  const events = (
    getDb()
      .prepare(eventsSql)
      .all(...(type ? [`%${type}%`] : [])) as Array<Record<string, unknown>>
  ).map((e) => ({
    ...e,
    created_at_br: formatBrDateTime(String(e.created_at || "")),
    created_at: formatBrDateTime(String(e.created_at || "")),
  }));
  const couponTests = (
    getDb()
      .prepare(
        `SELECT * FROM coupon_tests ORDER BY id DESC LIMIT 40`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((e) => ({
    ...e,
    created_at_br: formatBrDateTime(String(e.created_at || "")),
    created_at: formatBrDateTime(String(e.created_at || "")),
  }));
  res.json({
    status: getAntiBanStatus(),
    events,
    couponTests,
    timezone: "America/Sao_Paulo",
  });
});

api.post("/antiban/pause", (req, res) => {
  const minutes = Number(req.body?.minutes || 60);
  pauseSending(minutes, "pausa manual pelo painel");
  res.json({ ok: true, status: getAntiBanStatus() });
});

api.post("/antiban/resume", (_req, res) => {
  clearPause();
  res.json({ ok: true, status: getAntiBanStatus() });
});

api.post("/settings", (req, res) => {
  const {
    scheduler_enabled,
    demo_mode,
    fetch_interval_minutes,
    enabled_sources,
    coupon_revalidate_minutes,
    maintenance_mode,
    lunch_silence,
    post_hashtag,
    post_flash_peak,
    holiday_silence,
    tcg_official_only,
    require_meli_la,
    tcg_day_limit,
    electronics_day_limit,
    achadinhos_day_limit,
    post_inter_group_delay_sec,
    warmup_week1_cap,
    stock_warn_max,
    price_rise_skip_pct,
    reprint_min_price,
    reprint_min_discount_pct,
    lunch_start,
    lunch_end,
    http_block_pause_after,
    ml_hub_sync_limit,
    harvest_max_coupons,
    harvest_max_items,
    harvest_mint_links,
  } = req.body ?? {};
  if (scheduler_enabled !== undefined) {
    setSetting("scheduler_enabled", scheduler_enabled ? "1" : "0");
  }
  if (maintenance_mode !== undefined) {
    setSetting("maintenance_mode", maintenance_mode ? "1" : "0");
  }
  if (lunch_silence !== undefined) {
    setSetting("lunch_silence", lunch_silence ? "1" : "0");
  }
  if (post_hashtag !== undefined) {
    setSetting("post_hashtag", post_hashtag ? "1" : "0");
  }
  if (post_flash_peak !== undefined) {
    setSetting("post_flash_peak", post_flash_peak ? "1" : "0");
  }
  if (holiday_silence !== undefined) {
    setSetting("holiday_silence", holiday_silence ? "1" : "0");
  }
  if (tcg_official_only !== undefined) {
    setSetting("tcg_official_only", tcg_official_only ? "1" : "0");
  }
  if (require_meli_la !== undefined) {
    setSetting("require_meli_la", require_meli_la ? "1" : "0");
  }
  const clampSet = (
    key: string,
    raw: unknown,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const n = Number(raw);
    const v = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    setSetting(key, String(v));
  };
  if (tcg_day_limit !== undefined) clampSet("tcg_day_limit", tcg_day_limit, 45, 8, 200);
  if (electronics_day_limit !== undefined) {
    clampSet("electronics_day_limit", electronics_day_limit, 55, 8, 200);
  }
  if (achadinhos_day_limit !== undefined) {
    clampSet("achadinhos_day_limit", achadinhos_day_limit, 90, 8, 200);
  }
  if (post_inter_group_delay_sec !== undefined) {
    clampSet("post_inter_group_delay_sec", post_inter_group_delay_sec, 60, 45, 180);
  }
  setSetting("post_max_groups_per_wave", "1");
  if (warmup_week1_cap !== undefined) {
    clampSet("warmup_week1_cap", warmup_week1_cap, 40, 8, 200);
  }
  if (stock_warn_max !== undefined) clampSet("stock_warn_max", stock_warn_max, 8, 1, 80);
  if (price_rise_skip_pct !== undefined) {
    clampSet("price_rise_skip_pct", price_rise_skip_pct, 15, 5, 80);
  }
  if (reprint_min_price !== undefined) {
    clampSet("reprint_min_price", reprint_min_price, 180, 50, 5000);
  }
  if (reprint_min_discount_pct !== undefined) {
    clampSet("reprint_min_discount_pct", reprint_min_discount_pct, 8, 0, 90);
  }
  if (http_block_pause_after !== undefined) {
    clampSet("http_block_pause_after", http_block_pause_after, 3, 2, 10);
  }
  if (ml_hub_sync_limit !== undefined) {
    clampSet("ml_hub_sync_limit", ml_hub_sync_limit, 24, 1, 24);
  }
  if (harvest_max_coupons !== undefined) {
    clampSet("harvest_max_coupons", harvest_max_coupons, 10, 1, 20);
  }
  if (harvest_max_items !== undefined) {
    clampSet("harvest_max_items", harvest_max_items, 14, 1, 30);
  }
  if (harvest_mint_links !== undefined) {
    clampSet("harvest_mint_links", harvest_mint_links, 20, 0, 48);
  }
  if (lunch_start !== undefined) {
    const v = String(lunch_start).trim();
    if (/^\d{1,2}:\d{2}$/.test(v)) setSetting("lunch_start", v);
  }
  if (lunch_end !== undefined) {
    const v = String(lunch_end).trim();
    if (/^\d{1,2}:\d{2}$/.test(v)) setSetting("lunch_end", v);
  }
  if (demo_mode !== undefined) {
    setSetting("demo_mode", demo_mode ? "1" : "0");
  }
  if (fetch_interval_minutes !== undefined) {
    setSetting(
      "fetch_interval_minutes",
      String(Number(fetch_interval_minutes) || 25),
    );
  }
  if (enabled_sources !== undefined) {
    setSetting("enabled_sources", String(enabled_sources));
  }
  if (coupon_revalidate_minutes !== undefined) {
    updateCouponInterval(Number(coupon_revalidate_minutes) || 8);
  }
  res.json({ ok: true });
});

api.post("/cadence", (req, res) => {
  void import("../services/antiBan.js").then(({ saveCadenceSettings }) => {
    try {
      const b = req.body ?? {};
      const cadence = saveCadenceSettings({
        weekdayStart: b.weekdayStart,
        weekdayEnd: b.weekdayEnd,
        weekendStart: b.weekendStart,
        weekendEnd: b.weekendEnd,
        weekdayDayLimit:
          b.weekdayDayLimit != null ? Number(b.weekdayDayLimit) : undefined,
        weekendDayLimit:
          b.weekendDayLimit != null ? Number(b.weekendDayLimit) : undefined,
        weekdayHourLimit:
          b.weekdayHourLimit != null ? Number(b.weekdayHourLimit) : undefined,
        weekendHourLimit:
          b.weekendHourLimit != null ? Number(b.weekendHourLimit) : undefined,
        sundayDayLimit:
          b.sundayDayLimit != null ? Number(b.sundayDayLimit) : undefined,
        warmupEnabled:
          b.warmupEnabled === undefined ? undefined : Boolean(b.warmupEnabled),
        intervalMinMinutes:
          b.intervalMinMinutes != null ? Number(b.intervalMinMinutes) : undefined,
        intervalMaxMinutes:
          b.intervalMaxMinutes != null ? Number(b.intervalMaxMinutes) : undefined,
        warmupWeek1Cap:
          b.warmupWeek1Cap != null ? Number(b.warmupWeek1Cap) : undefined,
      });
      res.json({ ok: true, cadence });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
});

api.post("/run-once", async (_req, res) => {
  await runOnce();
  res.json({ ok: true });
});

api.post("/publish-now", async (req, res) => {
  const manual = req.body?.manual !== false; // padrão: clique do painel
  const force = Boolean(req.body?.force);
  if (force) {
    const { clearWaveCooldown, clearPause } = await import(
      "../services/antiBan.js"
    );
    clearWaveCooldown();
    clearPause();
  }
  const result = await runPublishWave({
    manual: manual || force,
    ignoreGroupInterval: force || manual,
  });
  res.json({
    ok: result.sent > 0,
    ...result,
    message:
      result.sent > 0
        ? `Enviado para ${result.sent} comunidade(s)/grupo(s).`
        : result.blockedReason || "Nada enviado",
  });
});

api.get("/sends/reset-preview", (req, res) => {
  const scope = String(req.query.scope || "today") as
    | "today"
    | "all"
    | "group"
    | "last24h";
  const groupId = req.query.groupId ? Number(req.query.groupId) : null;
  try {
    res.json({
      ok: true,
      preview: previewSendReset({ scope, groupId }),
      schedulerEnabled: getSetting("scheduler_enabled", "1") === "1",
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/sends/reset", (req, res) => {
  const scope = String(req.body?.scope || "today") as
    | "today"
    | "all"
    | "group"
    | "last24h";
  const groupId = req.body?.groupId != null ? Number(req.body.groupId) : null;
  try {
    const before = previewSendReset({ scope, groupId });
    const result = resetSends({
      scope,
      groupId,
      clearCadence: req.body?.clearCadence !== false,
      requeuePosted: req.body?.requeuePosted !== false,
      clearCouponAnnouncements: req.body?.clearCouponAnnouncements !== false,
    });
    res.json({ ...result, before });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/sends/undo-reset", (_req, res) => {
  try {
    res.json(undoLastSendReset());
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.get("/logs", (_req, res) => {
  const logs = getDb()
    .prepare("SELECT * FROM post_logs ORDER BY id DESC LIMIT 100")
    .all();
  res.json({ logs });
});

api.get("/credentials", (_req, res) => {
  res.json({
    ...getCredentialsPublicStatus(),
    pulse: getPulseStatus(),
  });
});

api.post("/credentials/amazon", (req, res) => {
  const { accessKey, secretKey, partnerTag, host, region } = req.body ?? {};
  if (!partnerTag && !accessKey && !secretKey) {
    res.status(400).json({ error: "Informe ao menos partnerTag e keys" });
    return;
  }
  saveAmazonCreds({ accessKey, secretKey, partnerTag, host, region });
  setSetting("demo_mode", "0");
  logAntiBan("creds_amazon_saved", "cofre atualizado (keys mascaradas no painel)");
  res.json({ ok: true, status: getCredentialsPublicStatus() });
});

api.post("/credentials/mercadolivre", (req, res) => {
  const {
    accessToken,
    refreshToken,
    affiliateTag,
    creatorUsername,
    clientId,
    clientSecret,
    hubCookie,
    hubCsrf,
    hubTag,
  } = req.body ?? {};
  const identity = String(creatorUsername || affiliateTag || "").trim();
  const looksLikeProductShare =
    /^[A-Z0-9]{4,10}-[A-Z0-9]{3,8}$/i.test(identity) ||
    /^https?:\/\/(?:www\.)?meli\.la\//i.test(identity);
  if (looksLikeProductShare) {
    res.status(400).json({
      error:
        "Isso é ID/link de produto (Compartilhar), não o ID da sua conta. Use o perfil social, ex.: https://www.mercadolivre.com.br/social/ocarafmz",
    });
    return;
  }
  saveMercadoLivreCreds({
    accessToken,
    refreshToken,
    affiliateTag,
    creatorUsername,
    clientId,
    clientSecret,
    hubCookie,
    hubCsrf,
    hubTag,
  });
  if (identity || String(hubCookie || "").trim()) {
    setSetting("demo_mode", "0");
  }
  logAntiBan("creds_ml_saved", "perfil/sessão Hub ML");
  res.json({ ok: true, status: getCredentialsPublicStatus() });
});

api.post("/mercadolivre/hub/test", async (_req, res) => {
  const { testHubSession } = await import("../services/mlHub.js");
  res.json(await testHubSession());
});

api.get("/mercadolivre/coupons", async (req, res) => {
  const {
    listAllStoredCoupons,
    listStoredCoupons,
    listCodedStoredCoupons,
    isDigitableCouponCode,
  } = await import("../services/mlCoupons.js");
  const { couponTargetCategories, groupsForCoupon } = await import(
    "../services/couponBroadcast.js"
  );
  const limit = Math.min(Number(req.query.limit) || 250, 800);
  const all = req.query.all === "1" || req.query.all === "true";
  const codedOnly =
    req.query.coded === "1" ||
    req.query.coded === "true" ||
    req.query.codedOnly === "1";
  let coupons = codedOnly
    ? listCodedStoredCoupons(limit)
    : all
      ? listAllStoredCoupons(limit)
      : listStoredCoupons(limit);
  const withCodeInDb =
    Number(
      (await import("../db/index.js")).getSetting("ml_coupons_with_code", "0"),
    ) || coupons.filter((c) => isDigitableCouponCode(c.code)).length;
  const returnedWithCode = coupons.filter((c) =>
    isDigitableCouponCode(c.code),
  ).length;
  res.json({
    syncedAt: getSetting("ml_coupons_synced_at", ""),
    count: Number(getSetting("ml_coupons_count", "0")) || coupons.length,
    withCode: withCodeInDb,
    returned: coupons.length,
    returnedWithCode,
    coupons: coupons.map((c) => {
      const cats = couponTargetCategories(c);
      const groups = groupsForCoupon(c);
      return {
        campaignId: c.campaignId,
        code: c.code,
        title: c.title,
        subtitle: c.subtitle,
        status: c.status,
        discountType: c.discountType,
        discountValue: c.discountValue,
        minAmount: c.minAmount,
        capAmount: c.capAmount,
        expiresAt: c.expiresAt,
        listUrl: c.listUrl,
        verticalHint: c.verticalHint,
        testedOk: c.testedOk ?? null,
        testedAt: c.testedAt || null,
        testedDetail: c.testedDetail || null,
        lastAnnouncedStatus: c.lastAnnouncedStatus || null,
        lastAnnouncedAt: c.lastAnnouncedAt || null,
        targetCategories: cats.length ? cats : ["geral"],
        targetGroups: groups.map((g) => ({ id: g.id, name: g.name, categories: g.categories })),
      };
    }),
    note:
      "Feed via /cupons/api (sessão). A maioria das campanhas não tem código digitável — use Tips + códigos. Sync Todos baixa o catálogo completo (~todas as páginas).",
  });
});

api.post("/mercadolivre/coupons/test", async (_req, res) => {
  const { testCouponsApi } = await import("../services/mlCoupons.js");
  const result = await testCouponsApi();
  res.status(result.ok ? 200 : 400).json(result);
});

api.post("/mercadolivre/coupons/test-catalog", async (_req, res) => {
  const { testDigitibleCatalogCoupons } = await import("../services/mlCoupons.js");
  const tested = await testDigitibleCatalogCoupons(20);
  const { processCouponAnnouncements } = await import(
    "../services/couponBroadcast.js"
  );
  const announced = await processCouponAnnouncements({ manual: true });
  res.json({ ok: true, tested, announced });
});

api.post("/mercadolivre/coupons/announce", async (req, res) => {
  const { getStoredCoupon } = await import("../services/mlCoupons.js");
  const { announceCouponToGroups } = await import(
    "../services/couponBroadcast.js"
  );
  const campaignId = String(req.body?.campaignId || "");
  const kind = req.body?.kind === "exhausted" ? "exhausted" : "valid";
  const coupon = getStoredCoupon(campaignId);
  if (!coupon) {
    res.status(404).json({ error: "cupom não encontrado no catálogo" });
    return;
  }
  const result = await announceCouponToGroups(coupon, kind, { manual: true });
  res.json({ ok: result.sent > 0, ...result });
});

api.post("/mercadolivre/coupons/sync", async (req, res) => {
  const { syncMlCouponsCatalog, enrichQueuedDealsWithCoupons } =
    await import("../services/mlCoupons.js");
  const maxPagesPerKey = Number(req.body?.maxPagesPerKey);
  const mode =
    req.body?.mode === "new" || req.body?.mode === "popular"
      ? req.body.mode
      : "all";
  const sync = await syncMlCouponsCatalog({
    maxPagesPerKey: Number.isFinite(maxPagesPerKey)
      ? maxPagesPerKey
      : mode === "all"
        ? 6
        : mode === "popular"
          ? 3
          : 1,
    mode,
    testAndAnnounce: req.body?.testAndAnnounce === true,
  });
  let match:
    | Awaited<ReturnType<typeof enrichQueuedDealsWithCoupons>>
    | undefined;
  // matchDeals só se pedido explicitamente (padrão: não — evita rajada)
  if (sync.ok && req.body?.matchDeals === true) {
    match = await enrichQueuedDealsWithCoupons({
      limit: Math.min(Number(req.body?.limit) || 8, 10),
      syncFirst: false,
    });
  }
  res.status(sync.ok ? 200 : 400).json({ ...sync, match });
});

api.post("/mercadolivre/coupons/match-deals", async (req, res) => {
  const { enrichQueuedDealsWithCoupons, enrichDealWithBestCoupon } =
    await import("../services/mlCoupons.js");
  if (req.body?.dealId) {
    const one = await enrichDealWithBestCoupon(Number(req.body.dealId), {
      validate: req.body?.validate !== false,
      syncIfEmpty: true,
    });
    return res.status(one.ok ? 200 : 400).json(one);
  }
  const result = await enrichQueuedDealsWithCoupons({
    limit: Number(req.body?.limit) || 40,
    syncFirst: req.body?.syncFirst !== false,
  });
  res.status(result.ok ? 200 : 400).json(result);
});

api.post("/mercadolivre/coupons/harvest", async (req, res) => {
  try {
    const { ingestDealsFromCouponLists } = await import(
      "../services/couponHarvest.js"
    );
    const result = await ingestDealsFromCouponLists({
      maxCoupons: Number(req.body?.maxCoupons) || undefined,
      maxItemsPerCoupon: Number(req.body?.maxItemsPerCoupon) || undefined,
      mintLinks: Number(req.body?.mintLinks) || undefined,
      preferCodes: Array.isArray(req.body?.preferCodes)
        ? req.body.preferCodes.map((c: unknown) => String(c || ""))
        : typeof req.body?.preferCodes === "string"
          ? String(req.body.preferCodes)
              .split(/[,\s]+/)
              .filter(Boolean)
          : undefined,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Resolve código digitável via /cupons/api/input-code (tips / LIBROS*). */
api.post("/mercadolivre/coupons/resolve", async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim().toUpperCase();
    const {
      resolveCouponByInputCode,
      discoverAndIngestTipCoupons,
    } = await import("../services/couponTipDiscovery.js");
    if (code) {
      const tips = await discoverAndIngestTipCoupons({
        maxResolve: 6,
        forceCodes: [code],
      });
      const one = await resolveCouponByInputCode(code);
      let announced:
        | Awaited<
            ReturnType<
              typeof import("../services/couponBroadcast.js").processCouponAnnouncements
            >
          >
        | undefined;
      let harvest:
        | Awaited<
            ReturnType<
              typeof import("../services/couponHarvest.js").ingestDealsFromCouponLists
            >
          >
        | undefined;
      if (tips.usable.length || one.usable) {
        const { processCouponAnnouncements } = await import(
          "../services/couponBroadcast.js"
        );
        announced = await processCouponAnnouncements({
          manual: true,
          priority: true,
        });
        const { ingestDealsFromCouponLists } = await import(
          "../services/couponHarvest.js"
        );
        harvest = await ingestDealsFromCouponLists({
          maxCoupons: 3,
          maxItemsPerCoupon: 6,
          mintLinks: 3,
        });
      }
      return res.json({ ok: true, resolve: one, tips, announced, harvest });
    }
    const tips = await discoverAndIngestTipCoupons({
      maxResolve: Number(req.body?.maxResolve) || 24,
    });
    let announced;
    let harvest;
    if (tips.usable.length || tips.newCodes.length) {
      const { processCouponAnnouncements } = await import(
        "../services/couponBroadcast.js"
      );
      announced = await processCouponAnnouncements({
        manual: true,
        priority: true,
      });
      const { ingestDealsFromCouponLists } = await import(
        "../services/couponHarvest.js"
      );
      harvest = await ingestDealsFromCouponLists({
        maxCoupons: 4,
        maxItemsPerCoupon: 6,
        mintLinks: 3,
      });
    }
    res.json({ ok: true, tips, announced, harvest });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.get("/mercadolivre/hub/sync-progress", (_req, res) => {
  res.json(getSyncProgress());
});

api.get("/mercadolivre/hub/sync-history", async (_req, res) => {
  try {
    const { syncScheduleSnapshot } = await import("../services/syncRuns.js");
    res.json(syncScheduleSnapshot());
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.get("/mercadolivre/official-stores", (_req, res) => {
  void import("../services/mlOfficialStores.js").then(({ listOfficialStores }) => {
    res.json({ stores: listOfficialStores() });
  });
});

api.post("/mercadolivre/official-stores", (req, res) => {
  void import("../services/mlOfficialStores.js").then(({ upsertOfficialStore }) => {
    try {
      const store = upsertOfficialStore({
        id: req.body?.id ? Number(req.body.id) : undefined,
        name: String(req.body?.name || ""),
        listUrl: String(req.body?.listUrl || req.body?.url || ""),
        category: String(req.body?.category || "tcg"),
        commissionHint: Number(req.body?.commissionHint ?? 12),
        active: req.body?.active !== false,
        maxItems: Number(req.body?.maxItems ?? 16),
      });
      res.json({ ok: true, store });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
});

api.delete("/mercadolivre/official-stores/:id", (req, res) => {
  void import("../services/mlOfficialStores.js").then(({ deleteOfficialStore }) => {
    const ok = deleteOfficialStore(Number(req.params.id));
    res.json({ ok });
  });
});

api.post("/mercadolivre/official-stores/:id/preview", async (req, res) => {
  const { getOfficialStore, fetchOfficialStoreProducts } = await import(
    "../services/mlOfficialStores.js"
  );
  const store = getOfficialStore(Number(req.params.id));
  if (!store) return res.status(404).json({ error: "Loja não encontrada" });
  const result = await fetchOfficialStoreProducts(store);
  res.json({
    ok: !result.error,
    store,
    count: result.products.length,
    products: result.products.slice(0, 12),
    error: result.error,
  });
});

api.post("/mercadolivre/hub/sync", async (req, res) => {
  const { syncTopCommissionDeals } = await import("../services/mlHub.js");
  const minCommission = Number(req.body?.minCommission);
  const limit = Number(req.body?.limit);
  if (Number.isFinite(minCommission) && minCommission >= 0) {
    setSetting("ml_hub_min_commission", String(minCommission));
  }
  if (Number.isFinite(limit) && limit > 0) {
    setSetting("ml_hub_sync_limit", String(limit));
  }
  if (req.body?.pushToList != null) {
    setSetting("ml_list_push_products", req.body.pushToList ? "1" : "0");
  }
  if (req.body?.enabledSources != null) {
    const src = Array.isArray(req.body.enabledSources)
      ? req.body.enabledSources.join(",")
      : String(req.body.enabledSources);
    setSetting("enabled_sources", src || "mercadolivre");
  }
  const result = await syncTopCommissionDeals({
    minCommission: Number.isFinite(minCommission) ? minCommission : undefined,
    limit: Number.isFinite(limit) ? Math.min(24, limit) : undefined,
    productsFromJson: req.body?.hubJson || undefined,
    pushToList: req.body?.pushToList,
    enrichCoupons: req.body?.enrichCoupons === true,
  });
  // Sync sozinho não posta (sem cupom). Harvest enche TCG/eletrônicos/achadinhos.
  let harvest:
    | Awaited<
        ReturnType<
          typeof import("../services/couponHarvest.js").ingestDealsFromCouponLists
        >
      >
    | undefined;
  if (result.ok && req.body?.skipHarvest !== true) {
    try {
      const { ingestDealsFromCouponLists } = await import(
        "../services/couponHarvest.js"
      );
      harvest = await ingestDealsFromCouponLists({});
      const { sanitizeSyncedQueue } = await import(
        "../services/queueSanitize.js"
      );
      sanitizeSyncedQueue();
    } catch (err) {
      /* harvest opcional — sync já gravou */
    }
  }
  res.status(result.ok ? 200 : 400).json({ ...result, harvest });
});

api.get("/mercadolivre/lists", async (req, res) => {
  const {
    listAffiliateLists,
    getMlListId,
    getMlListName,
    getMlListPublicUrl,
    getListItems,
    checkHubListsSession,
  } = await import("../services/mlLists.js");
  try {
    const { getMlProfilePath, getListMap } = await import("../services/mlLists.js");
    const listsOnly =
      req.query.listsOnly === "1" || req.query.listsOnly === "true";
    const force = req.query.force === "1" || req.query.force === "true";
    const hubSession = await checkHubListsSession();
    const lists = await listAffiliateLists({ force });
    const listId = String(req.query.listId || getMlListId());
    const meta = lists.find((l) => l.id === listId);
    const items =
      listsOnly || !listId ? [] : await getListItems(listId, { force });
    const { hubSessionReady } = await import("../services/mlHub.js");
    const hubOk = hubSessionReady() && hubSession.ok;
    const displayName =
      (meta?.name && !/^careca vip$/i.test(meta.name) ? meta.name : null) ||
      getMlListName();
    const namedLists = (lists.length
      ? lists
      : [
          {
            id: listId,
            name: getMlListName(),
            total: items.length,
            type: hubOk ? "hub" : "public",
          },
        ]
    ).map((l) =>
      l.id === listId
        ? { ...l, name: displayName, total: Math.max(l.total || 0, items.length) }
        : l,
    );
    res.json({
      lists: namedLists,
      selected: {
        id: listId,
        name: displayName,
        url: `https://www.mercadolivre.com.br/social/${getMlProfilePath()}/lists/${listId}`,
        total: items.length,
        items,
      },
      listMap: getListMap(),
      hubOk,
      hubListsOk: hubSession.ok,
      cached: !force,
      sessionHint:
        hubSession.hint ||
        (!hubOk
          ? "Sessão do Hub expirada — títulos/preços vêm da API pública do item. Atualize Cookie/CSRF em Contas. Listas novas: cole o link abaixo."
          : lists.length === 0
            ? "Nenhuma lista encontrada neste perfil."
            : undefined),
      pushToList: getSetting("ml_list_push_products", "1") === "1",
      defaultListId: getMlListId(),
      defaultListUrl: getMlListPublicUrl(),
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/mercadolivre/lists/register", async (req, res) => {
  const { registerListByUrl } = await import("../services/mlLists.js");
  try {
    const result = await registerListByUrl(
      String(req.body?.url || req.body?.listId || ""),
      req.body?.name ? String(req.body.name) : undefined,
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/mercadolivre/lists/settings", async (req, res) => {
  const { saveMlListSettings, getMlListPublicUrl, getMlListId, getMlListName } =
    await import("../services/mlLists.js");
  const saved = saveMlListSettings({
    listId: req.body?.listId,
    listName: req.body?.listName,
    pushToList: req.body?.pushToList ?? req.body?.pushElectronics,
    category: req.body?.category,
  });
  res.json({
    ok: true,
    id: getMlListId(),
    name: getMlListName(),
    url: getMlListPublicUrl(),
    pushToList: getSetting("ml_list_push_products", "1") === "1",
    category: req.body?.category || null,
    listMap: saved.listMap,
  });
});

api.post("/mercadolivre/lists/push", async (req, res) => {
  // Conservador: NÃO dispara Sync Hub + createLink. Só empurra a fila local.
  const { pushQueuedDealsToMappedLists } = await import("../services/mlLists.js");
  try {
    const result = await pushQueuedDealsToMappedLists({
      maxPerList: Number(req.body?.maxPerList) || undefined,
      listId: req.body?.listId ? String(req.body.listId) : undefined,
      category: req.body?.category ? String(req.body.category) : undefined,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/mercadolivre/lists/push-queued", async (req, res) => {
  const { pushQueuedDealsToMappedLists } = await import("../services/mlLists.js");
  try {
    const result = await pushQueuedDealsToMappedLists({
      maxPerList: Number(req.body?.maxPerList) || undefined,
      listId: req.body?.listId ? String(req.body.listId) : undefined,
      category: req.body?.category ? String(req.body.category) : undefined,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Remove da lista ML tudo que não cabe na categoria (moda em Informática, tabuleiro em TCG…). */
api.post("/mercadolivre/lists/sanitize", async (req, res) => {
  const { sanitizeMappedLists } = await import("../services/mlLists.js");
  try {
    const cats = Array.isArray(req.body?.categories)
      ? req.body.categories.map(String)
      : undefined;
    const result = await sanitizeMappedLists({ categories: cats });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Enche lista(s) com lojas oficiais (TCG/Pokémon…) sem createLink. */
api.post("/mercadolivre/lists/fill-stores", async (req, res) => {
  const { fillMappedListsFromOfficialStores } = await import(
    "../services/mlLists.js"
  );
  try {
    const result = await fillMappedListsFromOfficialStores({
      category: req.body?.category ? String(req.body.category) : undefined,
      listId: req.body?.listId ? String(req.body.listId) : undefined,
      maxPerList: Number(req.body?.maxPerList) || undefined,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/mercadolivre/lists/suggest-map", (req, res) => {
  void import("../services/mlLists.js").then(({ applySuggestedListMap }) => {
    try {
      const lists = Array.isArray(req.body?.lists) ? req.body.lists : undefined;
      const listMap = applySuggestedListMap(lists);
      res.json({ ok: true, listMap });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
});

api.post("/mercadolivre/lists/prune", async (req, res) => {
  const {
    pruneUnavailableListItems,
    pruneAllMappedLists,
    getMlListId,
  } = await import("../services/mlLists.js");
  if (req.body?.all) {
    const result = await pruneAllMappedLists();
    return res.json({ ok: true, ...result });
  }
  const listId = String(req.body?.listId || getMlListId());
  const result = await pruneUnavailableListItems(listId);
  res.json({ ok: true, ...result });
});

api.post("/mercadolivre/lists/prune-settings", (req, res) => {
  if (req.body?.enabled != null) {
    setSetting("ml_list_prune_enabled", req.body.enabled ? "1" : "0");
  }
  if (req.body?.timesPerDay != null) {
    const n = Math.max(1, Math.min(24, Number(req.body.timesPerDay) || 1));
    setSetting("ml_list_prune_times_per_day", String(n));
  }
  res.json({
    ok: true,
    enabled: getSetting("ml_list_prune_enabled", "1") === "1",
    timesPerDay: Number(getSetting("ml_list_prune_times_per_day", "1")) || 1,
    lastAt: getSetting("ml_list_prune_last_at", ""),
  });
});

api.get("/mercadolivre/lists/prune-settings", (_req, res) => {
  res.json({
    enabled: getSetting("ml_list_prune_enabled", "1") === "1",
    timesPerDay: Number(getSetting("ml_list_prune_times_per_day", "1")) || 1,
    lastAt: getSetting("ml_list_prune_last_at", ""),
  });
});

api.post("/mercadolivre/lists/remove-items", async (req, res) => {
  const { removeItemsFromList, getMlListId, removeItemFromAllKnownLists } =
    await import("../services/mlLists.js");
  const listId = String(req.body?.listId || getMlListId());
  const allLists = req.body?.allLists === true;
  const items = (req.body?.items || []) as Array<{
    itemId?: string;
    bookmarksId?: string | null;
  }>;
  const itemIds = (req.body?.itemIds || []) as string[];
  const payload = [
    ...items.map((it) => ({
      itemId: String(it.itemId || ""),
      bookmarksId: it.bookmarksId || null,
    })),
    ...itemIds.map((id) => ({ itemId: String(id), bookmarksId: null })),
  ].filter((it) => it.itemId || it.bookmarksId);
  if (!payload.length) {
    return res.status(400).json({ error: "Nenhum item para remover" });
  }
  if (allLists) {
    let removed = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const it of payload) {
      const r = await removeItemFromAllKnownLists(it.itemId);
      if (r.removed > 0) removed += r.removed;
      else {
        failed++;
        errors.push(`${it.itemId}: ${r.details.slice(0, 3).join("; ")}`);
      }
    }
    return res.json({ ok: removed > 0, removed, failed, errors, listId: "all" });
  }
  const result = await removeItemsFromList(payload, listId);
  res.json({ ok: result.removed > 0, ...result, listId });
});

/** Apaga da lista atual (e opcionalmente de todas) por trecho do título. */
api.post("/mercadolivre/lists/remove-by-title", async (req, res) => {
  const {
    getListItems,
    removeItemsFromList,
    getMlListId,
    getListMap,
  } = await import("../services/mlLists.js");
  const needle = String(req.body?.title || req.body?.q || "")
    .trim()
    .toLowerCase();
  if (needle.length < 4) {
    return res.status(400).json({ error: "Informe um trecho do título (≥4 letras)" });
  }
  const listId = String(req.body?.listId || getMlListId());
  const scanAll = req.body?.allLists !== false;
  const listIds = new Set<string>([listId]);
  if (scanAll) {
    for (const v of Object.values(getListMap())) {
      if (v?.id) listIds.add(v.id);
    }
  }
  let removed = 0;
  let matched = 0;
  const samples: string[] = [];
  for (const id of listIds) {
    const items = await getListItems(id);
    const hits = items.filter((it) =>
      String(it.title || "")
        .toLowerCase()
        .includes(needle),
    );
    matched += hits.length;
    for (const h of hits) {
      if (samples.length < 8) samples.push(`${h.title} (${h.itemId})`);
    }
    if (!hits.length) continue;
    const r = await removeItemsFromList(
      hits.map((h) => ({
        itemId: h.itemId,
        bookmarksId: h.bookmarksId,
      })),
      id,
    );
    removed += r.removed;
  }
  res.json({
    ok: removed > 0 || matched === 0,
    matched,
    removed,
    samples,
    needle,
  });
});

async function handleDeleteDeals(req: import("express").Request, res: import("express").Response) {
  const { deleteDeals } = await import("../services/mlLists.js");
  try {
    const ids = (req.body?.ids || [])
      .map((x: unknown) => Number(x))
      .filter((n: number) => Number.isFinite(n) && n > 0);
    const result = await deleteDeals(ids);
    res.json({
      ok: true,
      deleted: result.deleted,
      listRemoved: result.listRemoved,
      requested: ids.length,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      deleted: 0,
      listRemoved: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

api.post("/deals/delete", handleDeleteDeals);
api.delete("/deals", handleDeleteDeals);

api.post("/deals/prune", async (_req, res) => {
  const { pruneLocalDeals } = await import("../services/mlLists.js");
  const { sanitizeSyncedQueue } = await import("../services/queueSanitize.js");
  const pruned = pruneLocalDeals();
  const sanitized = sanitizeSyncedQueue();
  res.json({ ok: true, pruned, sanitized });
});

api.post("/deals/repair-prices", async (req, res) => {
  const { repairAbsurdDealPrices } = await import("../services/couponTester.js");
  const absurd = repairAbsurdDealPrices();
  const live =
    req.body?.live === false
      ? null
      : await (
          await import("../services/priceRefresh.js")
        ).refreshQueuedDealPrices({
          limit: Number(req.body?.limit) || 40,
        });
  res.json({ ok: true, absurd, live });
});

api.post("/deals/:id/refresh-price", async (req, res) => {
  const { refreshDealLivePrice } = await import("../services/priceRefresh.js");
  const result = await refreshDealLivePrice(Number(req.params.id));
  res.status(result.ok ? 200 : 400).json(result);
});

api.delete("/deals/:id", async (req, res) => {
  const id = Number(req.params.id);
  const row = getDb()
    .prepare(`SELECT title FROM deals WHERE id = ?`)
    .get(id) as { title?: string } | undefined;
  const { deleteDeals } = await import("../services/mlLists.js");
  try {
    const result = await deleteDeals([id]);
    res.json({
      ok: true,
      deleted: result.deleted,
      listRemoved: result.listRemoved,
      title: row?.title || "",
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      deleted: 0,
      listRemoved: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/mercadolivre/hub/settings", (req, res) => {
  const {
    minCommission,
    limit,
    autoSync,
    intervalMinutes,
    pushToList,
    enabledSources,
    autoPublishOnCouponValid,
    pruneEnabled,
    pruneTimesPerDay,
  } = req.body ?? {};
  if (minCommission != null) {
    setSetting(
      "ml_hub_min_commission",
      String(Math.max(0, Number(minCommission) || 20)),
    );
  }
  if (limit != null) {
    // Teto operacional 24: createLink em série com gap 7–14s (parecer humano).
    setSetting(
      "ml_hub_sync_limit",
      String(Math.max(1, Math.min(24, Number(limit) || 24))),
    );
  }
  if (autoSync != null) {
    setSetting("ml_hub_auto_sync", autoSync ? "1" : "0");
  }
  if (intervalMinutes != null) {
    // Piso 360 min: ritmo humano no Hub (anti rate-limit / re-login ML).
    setSetting(
      "ml_hub_sync_interval_minutes",
      String(Math.max(360, Number(intervalMinutes) || 360)),
    );
  }
  if (pushToList != null) {
    setSetting("ml_list_push_products", pushToList ? "1" : "0");
  }
  if (enabledSources != null) {
    const src = Array.isArray(enabledSources)
      ? enabledSources.join(",")
      : String(enabledSources);
    setSetting("enabled_sources", src || "mercadolivre");
  }
  if (autoPublishOnCouponValid != null) {
    setSetting(
      "auto_publish_on_coupon_valid",
      autoPublishOnCouponValid ? "1" : "0",
    );
  }
  if (pruneEnabled != null) {
    setSetting("ml_list_prune_enabled", pruneEnabled ? "1" : "0");
  }
  if (pruneTimesPerDay != null) {
    setSetting(
      "ml_list_prune_times_per_day",
      String(Math.max(1, Math.min(24, Number(pruneTimesPerDay) || 1))),
    );
  }
  res.json({
    ok: true,
    minCommission: Number(getSetting("ml_hub_min_commission", "20")),
    limit: Number(getSetting("ml_hub_sync_limit", "5")),
    autoSync: getSetting("ml_hub_auto_sync", "0") === "1",
    intervalMinutes: Number(getSetting("ml_hub_sync_interval_minutes", "360")),
    pushToList: getSetting("ml_list_push_products", "0") === "1",
    enabledSources: getSetting("enabled_sources", "mercadolivre"),
    autoPublishOnCouponValid:
      getSetting("auto_publish_on_coupon_valid", "0") === "1",
    pruneEnabled: getSetting("ml_list_prune_enabled", "1") === "1",
    pruneTimesPerDay:
      Number(getSetting("ml_list_prune_times_per_day", "1")) || 1,
    pruneLastAt: getSetting("ml_list_prune_last_at", ""),
  });
});

api.get("/mercadolivre/hub/settings", async (_req, res) => {
  let schedule = null;
  try {
    const { syncScheduleSnapshot } = await import("../services/syncRuns.js");
    schedule = syncScheduleSnapshot();
  } catch {
    schedule = null;
  }
  res.json({
    minCommission: Number(getSetting("ml_hub_min_commission", "20")),
    limit: Number(getSetting("ml_hub_sync_limit", "5")),
    autoSync: getSetting("ml_hub_auto_sync", "0") === "1",
    intervalMinutes: Number(getSetting("ml_hub_sync_interval_minutes", "360")),
    pushToList: getSetting("ml_list_push_products", "0") === "1",
    enabledSources: getSetting("enabled_sources", "mercadolivre"),
    autoPublishOnCouponValid:
      getSetting("auto_publish_on_coupon_valid", "0") === "1",
    pruneEnabled: getSetting("ml_list_prune_enabled", "1") === "1",
    pruneTimesPerDay:
      Number(getSetting("ml_list_prune_times_per_day", "1")) || 1,
    pruneLastAt: getSetting("ml_list_prune_last_at", ""),
    schedule,
  });
});

api.post("/mercadolivre/parse-share", (req, res) => {
  const parsed = parseMercadoLivreShareText(String(req.body?.text || ""));
  res.json(parsed);
});

api.post("/deals/:id/apply-ml-share", (req, res) => {
  const id = Number(req.params.id);
  const deal = getDb()
    .prepare("SELECT * FROM deals WHERE id = ?")
    .get(id) as Deal | undefined;
  if (!deal) {
    res.status(404).json({ error: "oferta não encontrada" });
    return;
  }
  const parsed = parseMercadoLivreShareText(String(req.body?.text || ""));
  if (!parsed.shortLink) {
    res.status(400).json({
      error: "Cole o texto do Compartilhar com o link meli.la",
      parsed,
    });
    return;
  }
  getDb()
    .prepare(
      `UPDATE deals SET affiliate_url = ?, product_url = COALESCE(product_url, ?) WHERE id = ?`,
    )
    .run(parsed.shortLink, parsed.shortLink, id);
  res.json({
    ok: true,
    affiliate_url: parsed.shortLink,
    productShareId: parsed.productShareId,
  });
});

api.delete("/credentials/:provider", (req, res) => {
  const provider = req.params.provider;
  const allowed = ["amazon", "mercadolivre", "shopee", "magalu", "awin"] as const;
  if (!allowed.includes(provider as (typeof allowed)[number])) {
    res.status(400).json({ error: "provider inválido" });
    return;
  }
  clearProviderCreds(provider as (typeof allowed)[number]);
  logAntiBan("creds_cleared", provider);
  res.json({ ok: true, status: getCredentialsPublicStatus() });
});

api.post("/credentials/shopee", (req, res) => {
  saveShopeeCreds(req.body ?? {});
  setSetting("demo_mode", "0");
  logAntiBan("creds_shopee_saved", "cofre atualizado");
  res.json({ ok: true, status: getCredentialsPublicStatus() });
});

api.post("/credentials/magalu", (req, res) => {
  saveMagaluCreds(req.body ?? {});
  setSetting("demo_mode", "0");
  logAntiBan("creds_magalu_saved", "cofre atualizado");
  res.json({ ok: true, status: getCredentialsPublicStatus() });
});

api.post("/credentials/awin", (req, res) => {
  saveAwinCreds(req.body ?? {});
  setSetting("demo_mode", "0");
  logAntiBan("creds_awin_saved", "cofre atualizado");
  res.json({ ok: true, status: getCredentialsPublicStatus() });
});

api.get("/fleets", (_req, res) => {
  const fleets = listFleets().map((f) => ({
    ...f,
    join_url: publicJoinUrl(f.slug),
    groups: groupsOfFleet(f.id),
  }));
  res.json({ fleets });
});

api.post("/fleets", async (req, res) => {
  try {
    const name_prefix = String(req.body?.name_prefix || "").trim();
    if (!name_prefix) {
      res.status(400).json({ error: "name_prefix obrigatório" });
      return;
    }
    const fleet = createFleet({
      name_prefix,
      slug: req.body?.slug,
      categories: req.body?.categories,
      start_number: Number(req.body?.start_number || 1),
      max_participants: Number(req.body?.max_participants || 950),
      watermark_handle: req.body?.watermark_handle,
      watermark_tagline: req.body?.watermark_tagline,
      interval_minutes: Number(req.body?.interval_minutes || 12),
    });
    let first = null as Awaited<ReturnType<typeof createNextFleetGroup>> | null;
    try {
      first = await createNextFleetGroup(fleet.id);
    } catch (err) {
      res.json({
        ok: true,
        fleet,
        join_url: publicJoinUrl(fleet.slug),
        warning:
          err instanceof Error
            ? err.message
            : "série criada; conecte o WhatsApp para gerar o primeiro grupo",
      });
      return;
    }
    res.json({
      ok: true,
      fleet,
      group: first,
      join_url: publicJoinUrl(fleet.slug),
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/fleets/:id/next-group", async (req, res) => {
  try {
    const group = await createNextFleetGroup(Number(req.params.id));
    res.json({ ok: true, group });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/groups/:id/refresh-capacity", async (req, res) => {
  try {
    const group = await refreshGroupCapacity(Number(req.params.id));
    res.json({ ok: true, group });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/deals/:id/test-coupon", async (req, res) => {
  try {
    const result = await applyCouponTestToDeal(Number(req.params.id));
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/deals/bulk-test-coupon", async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map((n: unknown) => Number(n))
    .filter((n: number) => Number.isFinite(n) && n > 0)
    .slice(0, 12);
  if (!ids.length) {
    res.status(400).json({ error: "Selecione ofertas com cupom" });
    return;
  }
  const results = [];
  for (const id of ids) {
    try {
      results.push({ id, ...(await applyCouponTestToDeal(id)) });
    } catch (err) {
      results.push({
        id,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  res.json({ ok: true, tested: results.length, results });
});

api.post("/deals/:id/expire-coupon", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const dealBefore = getDb()
      .prepare("SELECT * FROM deals WHERE id = ?")
      .get(id) as Deal | undefined;
    if (!dealBefore) {
      res.status(404).json({ error: "oferta não encontrada" });
      return;
    }
    if (!dealBefore.coupon) {
      res.status(400).json({ error: "oferta sem cupom" });
      return;
    }
    forceExpireCoupon(id, "marcado como esgotado no painel");
    // permite reenviar alerta se já tinha sido marcado
    getDb()
      .prepare(`UPDATE deals SET coupon_alert_sent = 0 WHERE id = ?`)
      .run(id);
    const deal = getDb()
      .prepare("SELECT * FROM deals WHERE id = ?")
      .get(id) as Deal;
    const alert = await notifyCouponExpired(deal, "cupom esgotado (painel/manual)");
    res.json({
      ok: true,
      preview: composeCouponExpiredMessage(deal),
      alert,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/brand", async (req, res) => {
  try {
    const { handle, tagline, public_base_url, groupName, logoBase64 } =
      req.body ?? {};
    if (handle) setSetting("brand_handle", String(handle));
    if (tagline) setSetting("brand_tagline", String(tagline));
    if (groupName) setSetting("brand_group_name", String(groupName));
    if (public_base_url) setSetting("public_base_url", String(public_base_url));
    let logo: { path: string; bytes: number } | undefined;
    if (logoBase64) {
      logo = await saveBrandLogoFromBase64(String(logoBase64));
    }
    res.json({
      ok: true,
      brand: {
        handle: getSetting("brand_handle"),
        tagline: getSetting("brand_tagline"),
        groupName: getSetting("brand_group_name", "Careca VIP"),
        public_base_url: getSetting("public_base_url"),
        hasLogo: brandLogoExists(),
        logoPath: brandLogoExists() ? brandLogoPath() : null,
      },
      logo,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/brand/logo", async (req, res) => {
  try {
    const data = String(req.body?.logoBase64 || req.body?.data || "");
    const logo = await saveBrandLogoFromBase64(data);
    res.json({
      ok: true,
      ...logo,
      hasLogo: true,
      url: "/api/brand/logo",
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.get("/brand/logo", (_req, res) => {
  if (!brandLogoExists()) {
    res.status(404).json({ error: "sem logo" });
    return;
  }
  res.sendFile(brandLogoPath());
});

api.get("/brand", (_req, res) => {
  res.json({
    handle: getSetting("brand_handle", "@carecavip"),
    tagline: getSetting(
      "brand_tagline",
      "O melhor grupo de promoções da internet",
    ),
    groupName: getSetting("brand_group_name", "Careca VIP"),
    public_base_url: getSetting("public_base_url"),
    hasLogo: brandLogoExists(),
  });
});

api.get("/deals/:id/preview-image", async (req, res) => {
  const id = Number(req.params.id);
  const { ensureDealImage } = await import("../services/dealMedia.js");
  await ensureDealImage(id);
  const deal = getDb()
    .prepare("SELECT * FROM deals WHERE id = ?")
    .get(id) as { image_url: string | null } | undefined;
  if (!deal?.image_url) {
    res.status(404).json({ error: "sem imagem — não achei thumbnail do produto" });
    return;
  }
  try {
    const groupId = Number(req.query.group_id || 0);
    const group = groupId
      ? (getDb()
          .prepare("SELECT * FROM wa_groups WHERE id = ?")
          .get(groupId) as WaGroup | undefined)
      : undefined;
    const brand = group ? resolveGroupBrand(group) : null;
    const fullDeal = getDb()
      .prepare("SELECT * FROM deals WHERE id = ?")
      .get(id) as Deal | undefined;
    const layoutQ = String(req.query.layout || "").trim();
    const buf = await watermarkProductImage({
      imageUrl: deal.image_url,
      handle: brand?.handle,
      tagline: brand?.tagline,
      groupName: group?.name,
      category: group?.categories || fullDeal?.category || "",
      layout:
        layoutQ ||
        String((group as WaGroup & { image_layout?: string })?.image_layout || "auto"),
      discountPct: fullDeal ? resolveDealPrices(fullDeal).discountPct : null,
      inviteUrl: group?.invite_link || group?.promo_url || null,
      logoPath: group ? groupLogoPath(group.id) : null,
    });
    res.setHeader("Content-Type", "image/jpeg");
    res.send(buf);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

api.post("/deals/backfill-images", async (req, res) => {
  const { backfillMissingDealImages } = await import("../services/dealMedia.js");
  const limit = Math.min(Number(req.body?.limit) || 20, 40);
  const result = await backfillMissingDealImages(limit);
  res.json({ ok: true, ...result });
});
