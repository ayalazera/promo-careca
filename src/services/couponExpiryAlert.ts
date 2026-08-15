import { getDb, logAntiBan, type Deal, type WaGroup } from "../db/index.js";
import { canSendNow, hashMessage, sleep } from "./antiBan.js";
import { parseList } from "./composer.js";
import { getWaStatus, sendGroupText } from "./whatsapp.js";
import {
  confirmCouponLiveOnMl,
  isConfirmedDeadCouponText,
  isTransientCouponFail,
} from "./couponLiveCheck.js";

function brl(value: number): string {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

/** Aviso só quando o CÓDIGO está morto no ML (confirmado). */
export function composeCouponExhaustedMessage(code: string): string {
  return [
    "⚠️ *Cupom esgotado*",
    "",
    `O cupom \`${code}\` *não está mais ativo* no Mercado Livre.`,
    "",
    "Não usem mais esse código — a promoção expirou ou o estoque do cupom acabou.",
    "Novas ofertas válidas seguem no grupo 🔥",
  ].join("\n");
}

/**
 * Produto específico deixou de aceitar o cupom, mas o código ainda funciona
 * em outras ofertas — NÃO dizer “não usem mais esse cupom”.
 */
export function composeCouponProductMismatchMessage(deal: Deal): string {
  const coupon = deal.coupon || "CUPOM";
  const price = deal.price_with_coupon || deal.price;
  const lines = [
    "ℹ️ *Oferta atualizada*",
    "",
    `Esta oferta *não aplica* mais o cupom \`${coupon}\`:`,
    `*${deal.title}*`,
    "",
  ];
  if (Number.isFinite(price) && price > 1) {
    lines.push(`Preço de referência: ${brl(Number(price))}`);
    lines.push("");
  }
  lines.push(
    `O cupom \`${coupon}\` *pode continuar válido* em outros produtos do grupo.`,
  );
  lines.push("Vamos postar só ofertas em que o desconto confirma 🔥");
  return lines.join("\n");
}

/** @deprecated use composeCouponExhaustedMessage / composeCouponProductMismatchMessage */
export function composeCouponExpiredMessage(deal: Deal): string {
  return composeCouponProductMismatchMessage(deal);
}

/** Grupos que já receberam o post + grupos ativos com mesma categoria/fonte. */
export function findRelatedGroupsForDeal(deal: Deal): WaGroup[] {
  const posted = getDb()
    .prepare(
      `SELECT g.* FROM wa_groups g
       INNER JOIN post_logs p ON p.group_id = g.id
       WHERE p.deal_id = ? AND p.ok = 1 AND g.active = 1`,
    )
    .all(deal.id) as WaGroup[];

  const byId = new Map<number, WaGroup>();
  for (const g of posted) byId.set(g.id, g);

  const active = getDb()
    .prepare(`SELECT * FROM wa_groups WHERE active = 1`)
    .all() as WaGroup[];

  const dealSource = deal.source === "demo" ? "mercadolivre" : deal.source;
  const keywords = `${deal.title} ${deal.description}`.toLowerCase();

  for (const g of active) {
    if (byId.has(g.id)) continue;
    const cats = parseList(g.categories || "geral");
    if (!cats.includes(deal.category) && !cats.includes("geral")) continue;

    const sources = parseList(
      g.sources || "mercadolivre,amazon,shopee,magalu,demo",
    );
    const sourceOk =
      sources.includes(deal.source) ||
      sources.includes(dealSource) ||
      (deal.source === "demo" && sources.includes("mercadolivre"));
    if (!sourceOk) continue;

    const kws = parseList(g.keywords || "");
    if (kws.length > 0 && !kws.some((k) => keywords.includes(k))) continue;

    byId.set(g.id, g);
  }

  return [...byId.values()];
}

function alreadyAlerted(dealId: number): boolean {
  const row = getDb()
    .prepare(`SELECT coupon_alert_sent FROM deals WHERE id = ?`)
    .get(dealId) as { coupon_alert_sent?: number } | undefined;
  return Boolean(row?.coupon_alert_sent);
}

function markAlertSent(dealId: number): void {
  getDb()
    .prepare(`UPDATE deals SET coupon_alert_sent = 1 WHERE id = ?`)
    .run(dealId);
}

function logPost(opts: {
  dealId: number | null;
  groupId: number | null;
  messageHash: string;
  ok: boolean;
  reason: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO post_logs (deal_id, group_id, message_hash, ok, reason)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      opts.dealId,
      opts.groupId,
      opts.messageHash,
      opts.ok ? 1 : 0,
      opts.reason,
    );
}

async function sendAlertToGroups(
  deal: Deal,
  text: string,
  reasonTag: string,
): Promise<number> {
  const wa = getWaStatus();
  if (!wa.connected) return 0;
  const groups = findRelatedGroupsForDeal(deal);
  if (!groups.length) return 0;
  let notified = 0;
  for (const group of groups) {
    const decision = canSendNow({
      messageHash: hashMessage(`${group.jid}:coupon-alert:${deal.id}:${reasonTag}`),
      groupsInWave: 1,
    });
    if (!decision.allow) {
      await sleep(12_000);
      continue;
    }
    await sleep(Math.min(decision.delayMs, 60_000));
    try {
      await sendGroupText(group.jid, text);
      notified += 1;
      logPost({
        dealId: deal.id,
        groupId: group.id,
        messageHash: hashMessage(text),
        ok: true,
        reason: reasonTag,
      });
    } catch (err) {
      logPost({
        dealId: deal.id,
        groupId: group.id,
        messageHash: "",
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return notified;
}

/**
 * Avisa nos grupos só depois de confirmar no ML.
 * - Cupom morto no site → aviso “esgotado”
 * - Cupom vivo / inconclusivo / falha transitória → NÃO posta “não usem mais”
 */
export async function notifyCouponExpired(
  deal: Deal,
  reason = "cupom inválido/esgotado",
): Promise<{ notified: number; skippedReason?: string }> {
  if (!deal.coupon) {
    return { notified: 0, skippedReason: "sem cupom" };
  }
  if (alreadyAlerted(deal.id)) {
    return { notified: 0, skippedReason: "alerta já enviado" };
  }

  const detail = String(reason || "");
  if (isTransientCouponFail(detail)) {
    logAntiBan(
      "coupon_dead_skip_transient",
      `deal=${deal.id} coupon=${deal.coupon} ${detail}`,
    );
    return { notified: 0, skippedReason: `falha transitória: ${detail}` };
  }

  const live = await confirmCouponLiveOnMl(deal.coupon);
  if (live.live === true) {
    // Cupom ainda ativo no ML — não assustar o grupo dizendo que morreu.
    // Só marca alerta do deal (produto) sem postar, ou posta mismatch suave se já foi postado.
    const wasPosted = (
      getDb()
        .prepare(
          `SELECT COUNT(*) AS c FROM post_logs WHERE deal_id = ? AND ok = 1 AND reason = 'enviado'`,
        )
        .get(deal.id) as { c: number }
    ).c;
    if (!wasPosted) {
      markAlertSent(deal.id);
      logAntiBan(
        "coupon_dead_skip_still_live",
        `deal=${deal.id} coupon=${deal.coupon} ainda vivo (${live.detail}) — sem aviso WA`,
      );
      return {
        notified: 0,
        skippedReason: `cupom ainda ativo no ML (${live.source})`,
      };
    }
    const text = composeCouponProductMismatchMessage(deal);
    const notified = await sendAlertToGroups(
      deal,
      text,
      `aviso_cupom_produto: ${detail}`,
    );
    markAlertSent(deal.id);
    return { notified, skippedReason: "cupom vivo — aviso só do produto" };
  }

  if (live.live === null && !isConfirmedDeadCouponText(detail)) {
    logAntiBan(
      "coupon_dead_skip_unconfirmed",
      `deal=${deal.id} coupon=${deal.coupon} ${live.detail} | ${detail}`,
    );
    return {
      notified: 0,
      skippedReason: `não confirmado no ML: ${live.detail}`,
    };
  }

  // Confirmado morto (ou texto inequívoco + live=false)
  const wa = getWaStatus();
  if (!wa.connected) {
    return { notified: 0, skippedReason: "WhatsApp offline" };
  }

  const text = composeCouponExhaustedMessage(String(deal.coupon).toUpperCase());
  const notified = await sendAlertToGroups(
    deal,
    text,
    `aviso_cupom_esgotado: ${live.detail || detail}`,
  );
  markAlertSent(deal.id);
  logAntiBan(
    "coupon_dead_alert",
    `deal=${deal.id} coupon=${deal.coupon} notified=${notified} ${live.detail || detail}`,
  );
  return { notified };
}
