import fs from "node:fs";
import path from "node:path";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import pino from "pino";
import { Boom } from "@hapi/boom";
import { config } from "../config.js";
import { getDb, logAntiBan } from "../db/index.js";
import { clearPause, pauseSending } from "./antiBan.js";

export type WaStatus = {
  connected: boolean;
  connecting: boolean;
  phone?: string;
  lastDisconnect?: string;
  qrDataUrl?: string | null;
};

let sock: WASocket | null = null;
let status: WaStatus = {
  connected: false,
  connecting: false,
  qrDataUrl: null,
};
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let recent440: number[] = [];
let intentionalClose = false;
const pendingAcks = new Map<string, number>();

function watchWaKey(waKey: string): void {
  pendingAcks.set(waKey, Date.now());
  setTimeout(() => {
    if (!pendingAcks.has(waKey)) return;
    pendingAcks.delete(waKey);
    logAntiBan("wa_ack_timeout", waKey);
  }, 90_000);
}

const logger = pino({ level: "silent" });

function note440Storm(): boolean {
  const now = Date.now();
  recent440 = recent440.filter((t) => now - t < 30_000);
  recent440.push(now);
  return recent440.length >= 4;
}

function scheduleReconnect(delayMs: number, reason: string) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const wait = Math.max(2_000, Math.min(delayMs, 120_000));
  logAntiBan("wa_reconnect_scheduled", `wait=${Math.round(wait / 1000)}s reason=${reason}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    status.connecting = false;
    void startWhatsApp();
  }, wait);
}

async function closeSocketQuietly() {
  intentionalClose = true;
  const current = sock;
  sock = null;
  if (current) {
    try {
      current.ev.removeAllListeners("connection.update");
      current.ev.removeAllListeners("creds.update");
    } catch {
      /* ignore */
    }
    try {
      current.end(undefined);
    } catch {
      /* ignore */
    }
  }
  intentionalClose = false;
}

export function getWaStatus(): WaStatus {
  return { ...status };
}

export function getSocket(): WASocket | null {
  return sock;
}

export async function startWhatsApp(): Promise<void> {
  if (status.connecting || status.connected) return;

  status.connecting = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  fs.mkdirSync(config.authDir, { recursive: true });

  await closeSocketQuietly();

  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ["PromoAutonomo", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 25_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    retryRequestDelayMs: 350,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages) {
      rememberOutgoingFromWa(m);
    }
  });
  sock.ev.on("messaging-history.set", ({ messages }) => {
    for (const m of messages) {
      rememberOutgoingFromWa(m);
    }
  });

  sock.ev.on("messages.update", (updates) => {
    for (const u of updates) {
      const id = u.key?.id;
      const jid = u.key?.remoteJid || "";
      if (!id) continue;
      const waKey = `${jid}|${id}`;
      const st = Number((u.update as { status?: number })?.status);
      if (!pendingAcks.has(waKey)) continue;
      // Baileys 7: ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3
      if (st === 2 || st === 3 || st === 4 || st === 5) {
        pendingAcks.delete(waKey);
        continue;
      }
      if (st === 0) {
        pendingAcks.delete(waKey);
        logAntiBan("wa_undelivered", waKey);
        pauseSending(45, "mensagem não entregue (ack de erro)");
      }
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      status.qrDataUrl = await qrcode.toDataURL(qr);
      status.connected = false;
    }

    if (connection === "open") {
      status.connected = true;
      status.connecting = false;
      status.qrDataUrl = null;
      status.lastDisconnect = undefined;
      status.phone = sock?.user?.id?.split(":")[0];
      recent440 = [];
      clearPause();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      logAntiBan("wa_connected", status.phone || "ok");
    }

    if (connection === "close") {
      status.connected = false;
      status.connecting = false;
      if (intentionalClose) return;

      const code = (lastDisconnect?.error as Boom | undefined)?.output
        ?.statusCode;
      status.lastDisconnect = String(code ?? "unknown");

      const loggedOut = code === DisconnectReason.loggedOut;
      const connectionReplaced =
        code === DisconnectReason.connectionReplaced || code === 440;
      const forbidden =
        code === DisconnectReason.forbidden || code === 403;
      const restartRequired = code === DisconnectReason.restartRequired;

      logAntiBan("wa_reconnect", `code=${code}`);

      if (loggedOut) {
        status.qrDataUrl = null;
        logAntiBan("wa_logged_out", "escaneie o QR novamente");
        try {
          fs.rmSync(config.authDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        return;
      }

      // 440 = outra sessão tomou o lugar (Web/Desktop). NÃO pausar 2h — só esperar e reconectar.
      if (connectionReplaced) {
        const storm = note440Storm();
        if (storm) {
          logAntiBan(
            "wa_connection_replaced_storm",
            "feche WhatsApp Web/Desktop em outros aparelhos; só este painel deve ficar conectado",
          );
        }
        scheduleReconnect(storm ? 45_000 : 8_000, storm ? "440_storm" : "440");
        return;
      }

      if (forbidden) {
        pauseSending(30, `whatsapp_forbidden código ${code}`);
        scheduleReconnect(30 * 60_000, "forbidden");
        return;
      }

      scheduleReconnect(restartRequired ? 3_000 : 5_000, restartRequired ? "restart" : "close");
    }
  });
}

export type WaChatTarget = {
  jid: string;
  name: string;
  kind: "group" | "community" | "community_announce";
  linkedParent?: string | null;
  participants?: number;
};

export async function listWhatsAppGroups(): Promise<
  Array<{ jid: string; name: string }>
> {
  const all = await listWhatsAppTargets();
  return all.map((g) => ({ jid: g.jid, name: g.name }));
}

/** Lista grupos + comunidades (avisos) da conta conectada. */
export async function listWhatsAppTargets(): Promise<WaChatTarget[]> {
  if (!sock || !status.connected) return [];
  const groups = await sock.groupFetchAllParticipating();
  const out: WaChatTarget[] = Object.values(groups).map((g) => {
    let kind: WaChatTarget["kind"] = "group";
    if (g.isCommunity) kind = "community";
    else if (g.isCommunityAnnounce) kind = "community_announce";
    return {
      jid: g.id,
      name: g.subject || g.id,
      kind,
      linkedParent: g.linkedParent || null,
      participants: g.participants?.length || g.size || 0,
    };
  });

  // tenta enriquecer com communities API quando disponível
  try {
    if (typeof sock.communityFetchAllParticipating === "function") {
      const communities = await sock.communityFetchAllParticipating();
      for (const g of Object.values(communities)) {
        if (out.some((x) => x.jid === g.id)) continue;
        out.push({
          jid: g.id,
          name: g.subject || g.id,
          kind: g.isCommunityAnnounce
            ? "community_announce"
            : g.isCommunity
              ? "community"
              : "group",
          linkedParent: g.linkedParent || null,
          participants: g.participants?.length || g.size || 0,
        });
      }
    }
  } catch {
    /* ignore */
  }

  // Avisos primeiro — é o destino correto para postar promoções
  return out.sort((a, b) => {
    const score = (t: WaChatTarget) =>
      t.kind === "community_announce" ? 0 : t.kind === "community" ? 2 : 1;
    return score(a) - score(b) || a.name.localeCompare(b.name, "pt-BR");
  });
}

/**
 * Comunidade-pai NÃO recebe posts visíveis no app.
 * O canal de Avisos (isCommunityAnnounce) é o destino correto.
 */
export async function resolvePostableJid(jid: string): Promise<{
  jid: string;
  kind: WaChatTarget["kind"];
  name: string;
  redirectedFrom?: string;
}> {
  if (!sock || !status.connected) {
    throw new Error("WhatsApp desconectado");
  }
  const targets = await listWhatsAppTargets();
  const self = targets.find((t) => t.jid === jid);
  if (self?.kind === "community_announce" || self?.kind === "group") {
    return { jid: self.jid, kind: self.kind, name: self.name };
  }

  // Se cadastrou a comunidade-pai, acha o Avisos ligado a ela
  if (self?.kind === "community" || !self) {
    const announce = targets.find(
      (t) =>
        t.kind === "community_announce" &&
        (t.linkedParent === jid ||
          (self && t.name === self.name)),
    );
    if (announce) {
      return {
        jid: announce.jid,
        kind: "community_announce",
        name: announce.name,
        redirectedFrom: jid,
      };
    }
  }

  // fallback: metadata
  try {
    const meta = await sock.groupMetadata(jid);
    if (meta.isCommunityAnnounce) {
      return {
        jid,
        kind: "community_announce",
        name: meta.subject || jid,
      };
    }
    if (meta.isCommunity) {
      const announce = targets.find(
        (t) => t.kind === "community_announce" && t.linkedParent === jid,
      );
      if (announce) {
        return {
          jid: announce.jid,
          kind: "community_announce",
          name: announce.name,
          redirectedFrom: jid,
        };
      }
      throw new Error(
        `“${meta.subject || jid}” é a comunidade-pai. Cadastre o canal de Avisos (não a comunidade).`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Avisos")) throw err;
  }

  return {
    jid,
    kind: self?.kind || "group",
    name: self?.name || jid,
  };
}

/** Corrige no banco JIDs de comunidade-pai → canal de Avisos. */
export async function repairCommunityAnnounceJids(): Promise<
  Array<{ id: number; name: string; from: string; to: string }>
> {
  const { getDb } = await import("../db/index.js");
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, name, jid FROM wa_groups WHERE active = 1`)
    .all() as Array<{ id: number; name: string; jid: string }>;
  const fixed: Array<{ id: number; name: string; from: string; to: string }> =
    [];
  for (const row of rows) {
    try {
      const resolved = await resolvePostableJid(row.jid);
      if (resolved.redirectedFrom && resolved.jid !== row.jid) {
        // se já existe outro registro com o JID de avisos, só atualiza o atual
        const clash = db
          .prepare(`SELECT id FROM wa_groups WHERE jid = ? AND id != ?`)
          .get(resolved.jid, row.id) as { id: number } | undefined;
        if (clash) {
          db.prepare(`UPDATE wa_groups SET active = 0 WHERE id = ?`).run(row.id);
        } else {
          db.prepare(
            `UPDATE wa_groups SET jid = ?, notes = ? WHERE id = ?`,
          ).run(
            resolved.jid,
            `Comunidade WhatsApp (community_announce) · corrigido de ${row.jid}`,
            row.id,
          );
        }
        fixed.push({
          id: row.id,
          name: row.name,
          from: row.jid,
          to: resolved.jid,
        });
      }
    } catch {
      /* skip */
    }
  }
  return fixed;
}

export async function sendGroupText(
  jid: string,
  text: string,
): Promise<{ jid: string; redirectedFrom?: string; waKey?: string | null }> {
  if (!sock || !status.connected) {
    throw new Error("WhatsApp desconectado. Escaneie o QR no painel.");
  }
  if (!jid.endsWith("@g.us")) {
    throw new Error("JID inválido: use um grupo (@g.us)");
  }
  const target = await resolvePostableJid(jid);
  const sent = await sock.sendMessage(target.jid, { text });
  const waKey = sent?.key?.id ? `${target.jid}|${sent.key.id}` : null;
  if (waKey) watchWaKey(waKey);
  rememberOutgoing({
    jid: target.jid,
    id: sent?.key?.id || "",
    text,
  });
  return { jid: target.jid, redirectedFrom: target.redirectedFrom, waKey };
}

export async function sendGroupImage(
  jid: string,
  image: Buffer,
  caption: string,
): Promise<{ jid: string; redirectedFrom?: string; waKey?: string | null }> {
  if (!sock || !status.connected) {
    throw new Error("WhatsApp desconectado. Escaneie o QR no painel.");
  }
  if (!jid.endsWith("@g.us")) {
    throw new Error("JID inválido: use um grupo (@g.us)");
  }
  const target = await resolvePostableJid(jid);
  const sent = await sock.sendMessage(target.jid, {
    image,
    caption,
  });
  const waKey = sent?.key?.id ? `${target.jid}|${sent.key.id}` : null;
  if (waKey) watchWaKey(waKey);
  rememberOutgoing({
    jid: target.jid,
    id: sent?.key?.id || "",
    text: caption,
  });
  return { jid: target.jid, redirectedFrom: target.redirectedFrom, waKey };
}

export async function createWhatsAppGroup(
  subject: string,
): Promise<{ jid: string; subject: string }> {
  if (!sock || !status.connected) {
    throw new Error("WhatsApp desconectado. Escaneie o QR no painel.");
  }
  const me = sock.user?.id;
  if (!me) throw new Error("usuário WhatsApp não disponível");

  try {
    // Alguns aparelhos rejeitam criar grupo só com o próprio número
    const metadata = await sock.groupCreate(subject, [me]);
    return { jid: metadata.id, subject: metadata.subject || subject };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `WhatsApp recusou criar grupo (${msg}). Prefira criar a Comunidade no app e cadastrar o link aqui.`,
    );
  }
}

export async function getInviteLink(jid: string): Promise<string> {
  if (!sock || !status.connected) {
    throw new Error("WhatsApp desconectado");
  }
  const code = await sock.groupInviteCode(jid);
  return `https://chat.whatsapp.com/${code}`;
}

/** Extrai o código de https://chat.whatsapp.com/XXXX ou do código puro. */
export function parseInviteCode(inviteLinkOrCode: string): string {
  const raw = String(inviteLinkOrCode || "").trim();
  if (!raw) throw new Error("informe o link do grupo");
  const fromUrl = raw.match(
    /(?:https?:\/\/)?(?:chat\.)?whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]+)/i,
  );
  if (fromUrl?.[1]) return fromUrl[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(raw)) return raw;
  throw new Error(
    "link inválido — use algo como https://chat.whatsapp.com/KFTf7jBkEZk7GVpD5JlCw6",
  );
}

/**
 * Entra no grupo (se ainda não for membro) a partir do link de convite
 * e devolve jid + nome + link normalizado.
 */
export async function joinGroupFromInviteLink(inviteLinkOrCode: string): Promise<{
  jid: string;
  subject: string;
  invite_link: string;
  alreadyMember: boolean;
  kind: WaChatTarget["kind"];
}> {
  if (!sock || !status.connected) {
    throw new Error("WhatsApp desconectado. Escaneie o QR no painel.");
  }
  const code = parseInviteCode(inviteLinkOrCode);
  const invite_link = `https://chat.whatsapp.com/${code}`;

  let subject = "";
  let jidFromInfo = "";
  let kind: WaChatTarget["kind"] = "group";

  // tenta info de grupo e de comunidade
  for (const getter of [
    () => sock!.groupGetInviteInfo(code),
    () =>
      typeof sock!.communityGetInviteInfo === "function"
        ? sock!.communityGetInviteInfo(code)
        : Promise.reject(new Error("no community info")),
  ]) {
    try {
      const info = await getter();
      subject = info.subject || subject;
      jidFromInfo = info.id || jidFromInfo;
      if (info.isCommunity) kind = "community";
      else if (info.isCommunityAnnounce) kind = "community_announce";
      break;
    } catch {
      /* next */
    }
  }

  const participating = await sock.groupFetchAllParticipating();
  const already =
    (jidFromInfo && participating[jidFromInfo]) ||
    Object.values(participating).find(
      (g) => subject && g.subject === subject,
    );

  if (already) {
    if (already.isCommunity) kind = "community";
    else if (already.isCommunityAnnounce) kind = "community_announce";
    // Convite da comunidade-pai → usa o canal de Avisos para postar
    if (kind === "community") {
      const resolved = await resolvePostableJid(already.id);
      return {
        jid: resolved.jid,
        subject: resolved.name || already.subject || subject || already.id,
        invite_link,
        alreadyMember: true,
        kind: resolved.kind,
      };
    }
    return {
      jid: already.id,
      subject: already.subject || subject || already.id,
      invite_link,
      alreadyMember: true,
      kind,
    };
  }

  let jid = "";
  const acceptors = [
    () => sock!.groupAcceptInvite(code),
    () =>
      typeof sock!.communityAcceptInvite === "function"
        ? sock!.communityAcceptInvite(code)
        : Promise.reject(new Error("no community accept")),
  ];
  let lastErr = "falha ao aceitar convite";
  for (const accept of acceptors) {
    try {
      jid = (await accept()) || "";
      if (jid) break;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }

  if (!jid) {
    const again = await sock.groupFetchAllParticipating();
    if (jidFromInfo && again[jidFromInfo]) {
      const g = again[jidFromInfo];
      return {
        jid: g.id,
        subject: g.subject || subject || g.id,
        invite_link,
        alreadyMember: true,
        kind: g.isCommunityAnnounce
          ? "community_announce"
          : g.isCommunity
            ? "community"
            : kind,
      };
    }
    throw new Error(
      `não foi possível entrar na comunidade/grupo: ${lastErr}. Confira se o número conectado foi adicionado ou se o link ainda é válido.`,
    );
  }

  if (!jid) jid = jidFromInfo;
  if (!jid || !jid.endsWith("@g.us")) {
    throw new Error("não foi possível obter o JID pelo convite");
  }

  if (!subject) {
    try {
      const meta = await sock.groupMetadata(jid);
      subject = meta.subject || "";
      if (meta.isCommunity) kind = "community";
      else if (meta.isCommunityAnnounce) kind = "community_announce";
    } catch {
      subject = jid;
    }
  }

  if (kind === "community") {
    const resolved = await resolvePostableJid(jid);
    return {
      jid: resolved.jid,
      subject: resolved.name || subject || jid,
      invite_link,
      alreadyMember: false,
      kind: resolved.kind,
    };
  }

  return { jid, subject: subject || jid, invite_link, alreadyMember: false, kind };
}

export async function getGroupParticipantCount(jid: string): Promise<number> {
  if (!sock || !status.connected) return 0;
  const meta = await sock.groupMetadata(jid);
  return meta.participants?.length || 0;
}

export function authExists(): boolean {
  return fs.existsSync(path.join(config.authDir, "creds.json"));
}

function ensureOutgoingTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS wa_outgoing (
      wa_key TEXT PRIMARY KEY,
      jid TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      caption TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function extractMessageText(m: WAMessage): string {
  const msg = m.message || {};
  return String(
    msg.conversation ||
      msg.extendedTextMessage?.text ||
      msg.imageMessage?.caption ||
      msg.videoMessage?.caption ||
      msg.documentMessage?.caption ||
      "",
  );
}

function rememberOutgoing(opts: { jid: string; id: string; text: string }): void {
  const jid = String(opts.jid || "").trim();
  const id = String(opts.id || "").trim();
  if (!jid || !id) return;
  ensureOutgoingTable();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO wa_outgoing (wa_key, jid, msg_id, caption)
       VALUES (?, ?, ?, ?)`,
    )
    .run(`${jid}|${id}`, jid, id, String(opts.text || "").slice(0, 2000));
}

function rememberOutgoingFromWa(m: WAMessage): void {
  if (!m.key?.fromMe || !m.key.id || !m.key.remoteJid) return;
  rememberOutgoing({
    jid: m.key.remoteJid,
    id: m.key.id,
    text: extractMessageText(m),
  });
}

async function revokeById(jid: string, msgId: string): Promise<void> {
  if (!sock || !status.connected) {
    throw new Error("WhatsApp desconectado");
  }
  await sock.sendMessage(jid, {
    delete: {
      remoteJid: jid,
      fromMe: true,
      id: msgId,
      participant: sock.user?.id,
    },
  });
}

function idsMatching(jid: string, match: string): string[] {
  ensureOutgoingTable();
  const needle = `%${match}%`;
  const rows = getDb()
    .prepare(
      `SELECT msg_id FROM wa_outgoing
       WHERE jid = ? AND caption LIKE ? COLLATE NOCASE`,
    )
    .all(jid, needle) as Array<{ msg_id: string }>;
  const fromLogs = getDb()
    .prepare(
      `SELECT wa_key FROM post_logs
       WHERE wa_key IS NOT NULL AND trim(wa_key) != ''
         AND (wa_key LIKE ? OR reason LIKE ?)`,
    )
    .all(`${jid}|%`, needle) as Array<{ wa_key: string }>;
  const ids = new Set<string>();
  for (const r of rows) if (r.msg_id) ids.add(r.msg_id);
  for (const r of fromLogs) {
    const [logJid, id] = String(r.wa_key || "").split("|");
    if (logJid === jid && id) ids.add(id);
  }
  return [...ids];
}

async function pullHistoryForChat(jid: string, timeoutMs = 18_000): Promise<number> {
  if (!sock || !status.connected) return 0;
  const before = idsMatching(jid, "%").length;
  try {
    await sock.fetchMessageHistory(
      40,
      { remoteJid: jid, fromMe: true, id: "0" },
      Date.now(),
    );
  } catch (err) {
    logAntiBan(
      "wa_history_fail",
      err instanceof Error ? err.message : String(err),
    );
  }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 800));
    const n = idsMatching(jid, "%").length;
    if (n > before) break;
  }
  return idsMatching(jid, "%").length - before;
}

export async function revokeByWaKey(waKey: string): Promise<void> {
  const [jid, id] = String(waKey || "").split("|");
  if (!jid || !id) throw new Error("wa_key inválido");
  await revokeById(jid, id);
}

/** Apaga (revoke) mensagens nossas no grupo cujo texto/legenda contém `match`. */
export async function revokeOwnMessagesMatching(opts: {
  jid: string;
  match: string;
}): Promise<{ revoked: number; tried: number; details: string[] }> {
  if (!sock || !status.connected) {
    throw new Error("WhatsApp desconectado");
  }
  const match = String(opts.match || "").trim();
  if (!match) throw new Error("texto para localizar o post vazio");
  const target = await resolvePostableJid(opts.jid);
  const jid = target.jid;
  const details: string[] = [];
  if (target.redirectedFrom) {
    details.push(`avisos ${jid}`);
  }

  let ids = idsMatching(jid, match);
  if (!ids.length) {
    const pulled = await pullHistoryForChat(jid);
    details.push(`histórico +${pulled}`);
    ids = idsMatching(jid, match);
  }
  // Também tenta o JID original (caso o post tenha ido no pai, não no Avisos)
  if (!ids.length && opts.jid !== jid) {
    ids = idsMatching(opts.jid, match);
    if (!ids.length) {
      await pullHistoryForChat(opts.jid);
      ids = idsMatching(opts.jid, match);
    }
  }

  let revoked = 0;
  const triedJids = [jid, opts.jid].filter(
    (v, i, a) => v && a.indexOf(v) === i,
  );
  for (const chat of triedJids) {
    const chatIds = idsMatching(chat, match);
    for (const id of chatIds) {
      try {
        await revokeById(chat, id);
        revoked += 1;
        details.push(`apagou ${id.slice(0, 12)}`);
      } catch (err) {
        details.push(
          `falhou ${id.slice(0, 12)}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  logAntiBan(
    "wa_revoke",
    `match=${match} jid=${jid} revoked=${revoked} tried=${ids.length}`,
  );
  return { revoked, tried: ids.length, details };
}
