import { getDb, getSetting, logAntiBan, type GroupFleet, type WaGroup } from "../db/index.js";
import {
  createWhatsAppGroup,
  getGroupParticipantCount,
  getInviteLink,
  getWaStatus,
} from "./whatsapp.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
}

export function listFleets(): GroupFleet[] {
  return getDb()
    .prepare("SELECT * FROM group_fleets ORDER BY id DESC")
    .all() as GroupFleet[];
}

export function getFleetBySlug(slug: string): GroupFleet | undefined {
  return getDb()
    .prepare("SELECT * FROM group_fleets WHERE slug = ?")
    .get(slug) as GroupFleet | undefined;
}

export function createFleet(input: {
  name_prefix: string;
  slug?: string;
  categories?: string;
  start_number?: number;
  max_participants?: number;
  watermark_handle?: string;
  watermark_tagline?: string;
  interval_minutes?: number;
}): GroupFleet {
  const name_prefix = input.name_prefix.trim();
  const slug = input.slug?.trim() || slugify(name_prefix);
  const start = input.start_number ?? 1;
  const info = getDb()
    .prepare(
      `INSERT INTO group_fleets (
         name_prefix, slug, categories, start_number, current_number,
         max_participants, watermark_handle, watermark_tagline, interval_minutes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name_prefix,
      slug,
      input.categories || "geral",
      start,
      start,
      input.max_participants ?? 950,
      input.watermark_handle || getSetting("brand_handle", "@promocoes"),
      input.watermark_tagline ||
        getSetting("brand_tagline", "O melhor grupo de promoções da internet"),
      input.interval_minutes ?? 12,
    );

  return getDb()
    .prepare("SELECT * FROM group_fleets WHERE id = ?")
    .get(info.lastInsertRowid) as GroupFleet;
}

export function groupsOfFleet(fleetId: number): WaGroup[] {
  return getDb()
    .prepare(
      `SELECT * FROM wa_groups WHERE fleet_id = ? ORDER BY sequence_number ASC`,
    )
    .all(fleetId) as WaGroup[];
}

export function getAcceptingGroup(fleetId: number): WaGroup | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM wa_groups
       WHERE fleet_id = ? AND is_accepting = 1 AND active = 1
       ORDER BY sequence_number DESC
       LIMIT 1`,
    )
    .get(fleetId) as WaGroup | undefined;
}

export async function ensureFleetHasOpenGroup(
  fleetId: number,
): Promise<WaGroup> {
  const fleet = getDb()
    .prepare("SELECT * FROM group_fleets WHERE id = ?")
    .get(fleetId) as GroupFleet | undefined;
  if (!fleet) throw new Error("série não encontrada");

  let current = getAcceptingGroup(fleetId);
  if (current) {
    await refreshGroupCapacity(current.id);
    current = getDb()
      .prepare("SELECT * FROM wa_groups WHERE id = ?")
      .get(current.id) as WaGroup;
    if (
      current.is_accepting &&
      current.participant_count < current.max_participants
    ) {
      return current;
    }
  }

  return createNextFleetGroup(fleetId);
}

/** 1º grupo = nome puro; próximos = "Nome 2", "Nome 3"... */
export function fleetGroupTitle(prefix: string, sequence: number): string {
  const base = prefix.trim();
  if (sequence <= 1) return base;
  return `${base} ${sequence}`;
}

export async function createNextFleetGroup(fleetId: number): Promise<WaGroup> {
  const fleet = getDb()
    .prepare("SELECT * FROM group_fleets WHERE id = ?")
    .get(fleetId) as GroupFleet | undefined;
  if (!fleet) throw new Error("série não encontrada");

  const wa = getWaStatus();
  if (!wa.connected) {
    throw new Error("WhatsApp offline — conecte o QR antes de criar grupos");
  }

  getDb()
    .prepare(
      `UPDATE wa_groups SET is_accepting = 0
       WHERE fleet_id = ? AND participant_count >= max_participants`,
    )
    .run(fleetId);

  const nextNumber = fleet.current_number;
  const title = fleetGroupTitle(fleet.name_prefix, nextNumber);
  const created = await createWhatsAppGroup(title);
  const invite = await getInviteLink(created.jid);

  getDb()
    .prepare(`UPDATE wa_groups SET is_accepting = 0 WHERE fleet_id = ?`)
    .run(fleetId);

  const info = getDb()
    .prepare(
      `INSERT INTO wa_groups (
         name, jid, categories, active, interval_minutes, fleet_id,
         sequence_number, invite_link, participant_count, is_accepting, max_participants
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, 1, ?)`,
    )
    .run(
      title,
      created.jid,
      fleet.categories,
      fleet.interval_minutes,
      fleet.id,
      nextNumber,
      invite,
      fleet.max_participants,
    );

  getDb()
    .prepare(
      `UPDATE group_fleets SET current_number = ? WHERE id = ?`,
    )
    .run(nextNumber + 1, fleetId);

  logAntiBan("fleet_group_created", `${title} ${created.jid}`);

  return getDb()
    .prepare("SELECT * FROM wa_groups WHERE id = ?")
    .get(info.lastInsertRowid) as WaGroup;
}

export async function refreshGroupCapacity(groupId: number): Promise<WaGroup> {
  const group = getDb()
    .prepare("SELECT * FROM wa_groups WHERE id = ?")
    .get(groupId) as WaGroup | undefined;
  if (!group) throw new Error("grupo não encontrado");

  try {
    const count = await getGroupParticipantCount(group.jid);
    const full = count >= group.max_participants;
    getDb()
      .prepare(
        `UPDATE wa_groups
         SET participant_count = ?, is_accepting = ?
         WHERE id = ?`,
      )
      .run(count, full ? 0 : group.is_accepting ? 1 : 0, groupId);

    if (full && group.fleet_id) {
      logAntiBan("fleet_group_full", `${group.name} (${count})`);
      await createNextFleetGroup(group.fleet_id);
    }
  } catch (err) {
    logAntiBan(
      "fleet_capacity_err",
      err instanceof Error ? err.message : String(err),
    );
  }

  return getDb()
    .prepare("SELECT * FROM wa_groups WHERE id = ?")
    .get(groupId) as WaGroup;
}

/** Link público estável: /r/:slug → convite do grupo que ainda aceita gente */
export async function resolveFleetInvite(slug: string): Promise<string> {
  const fleet = getFleetBySlug(slug);
  if (!fleet || !fleet.active) {
    throw new Error("série não encontrada");
  }
  const group = await ensureFleetHasOpenGroup(fleet.id);
  if (!group.invite_link) {
    const link = await getInviteLink(group.jid);
    getDb()
      .prepare(`UPDATE wa_groups SET invite_link = ? WHERE id = ?`)
      .run(link, group.id);
    return link;
  }
  return group.invite_link;
}

export function publicJoinUrl(slug: string): string {
  const base = getSetting(
    "public_base_url",
    "http://localhost:3847",
  ).replace(/\/$/, "");
  return `${base}/r/${slug}`;
}
