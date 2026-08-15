/**
 * 1) Restaura hold_coupon causados por teste transitório (ex.: sem token ML)
 *    quando há teste OK anterior.
 * 2) Recategorize / sanitize fila (tira não-eletrônicos de Eletrônicos).
 * 3) Se Achadinhos estiver preso em cupom sem estoque, promove fila de espera.
 */
import { getDb, logAntiBan, setSetting } from "../src/db/index.js";
import { sanitizeSyncedQueue } from "../src/services/queueSanitize.js";
import { recategorizeNonTcgDeals } from "../src/services/categories.js";
import {
  clearGroupFocusCoupon,
  pushGroupFocusCoupon,
  shiftWaitingCoupon,
  getGroupFocusCoupon,
} from "../src/services/couponCategories.js";
import { listQueuedDealsForGroup } from "../src/services/affiliates.js";
import { isTransientCouponFail } from "../src/services/couponLiveCheck.js";

function restoreTransientHolds(): number {
  const rows = getDb()
    .prepare(
      `SELECT d.id, d.coupon, d.status, d.coupon_status,
              (SELECT detail FROM coupon_tests ct
               WHERE ct.deal_id = d.id ORDER BY ct.id DESC LIMIT 1) AS last_detail,
              (SELECT ok FROM coupon_tests ct
               WHERE ct.deal_id = d.id AND ct.ok = 1
               ORDER BY ct.id DESC LIMIT 1) AS had_ok
       FROM deals d
       WHERE d.status = 'hold_coupon'
         AND d.coupon IS NOT NULL
         AND d.coupon != ''`,
    )
    .all() as Array<{
    id: number;
    coupon: string;
    status: string;
    coupon_status: string;
    last_detail: string | null;
    had_ok: number | null;
  }>;

  let n = 0;
  const upd = getDb().prepare(
    `UPDATE deals SET status = 'queued', coupon_status = 'valid'
     WHERE id = ?`,
  );
  for (const r of rows) {
    const transient =
      r.had_ok === 1 &&
      (!r.last_detail || isTransientCouponFail(r.last_detail));
    if (!transient) continue;
    upd.run(r.id);
    n += 1;
  }
  return n;
}

function rotateEmptyFocus(groupId: number): string {
  const focus = getGroupFocusCoupon(groupId);
  if (!focus) return "sem foco";
  const group = getDb()
    .prepare(`SELECT * FROM wa_groups WHERE id = ?`)
    .get(groupId) as Parameters<typeof listQueuedDealsForGroup>[0] | undefined;
  if (!group) return "grupo ausente";
  const withFocus = listQueuedDealsForGroup(group, 5, { coupon: focus });
  if (withFocus.length) return `foco ${focus} ok (${withFocus.length})`;
  clearGroupFocusCoupon(groupId, focus);
  const next = shiftWaitingCoupon(groupId);
  if (next?.code) {
    pushGroupFocusCoupon(groupId, next.code, next.until);
    return `${focus} sem estoque → ${next.code}`;
  }
  setSetting(`group_focus_coupon_${groupId}`, "");
  return `${focus} limpo (sem espera)`;
}

const restored = restoreTransientHolds();
const recat = recategorizeNonTcgDeals();
const san = sanitizeSyncedQueue();
const acha = rotateEmptyFocus(7);

logAntiBan(
  "restore_hold_recategorize",
  `restored=${restored} recat=${recat} deleted=${san.deleted} kept=${san.kept} achadinhos=${acha}`,
);

console.log(
  JSON.stringify(
    { restored, recategorized: recat, sanitize: san, achadinhosFocus: acha },
    null,
    2,
  ),
);
