import { getDb, setSetting, getSetting } from "../src/db/index.js";
import {
  getListMap,
  saveListMap,
  sanitizeMappedLists,
  pushQueuedDealsToMappedLists,
  fillMappedListsFromOfficialStores,
} from "../src/services/mlLists.js";
import { classifyProduct } from "../src/services/categories.js";

setSetting("ml_list_require_coupon", "1");
setSetting("ml_list_push_products", "1");
setSetting("ml_list_push_max_per_sync", "8");

const map = getListMap();
if (map.geral?.id) {
  map.moda = { id: map.geral.id, name: map.geral.name };
  map.beleza = { id: map.geral.id, name: map.geral.name };
  saveListMap(map);
  console.log("mapped moda/beleza →", map.geral.name);
}

try {
  getDb()
    .prepare(
      `UPDATE categories SET push_to_ml_list = 1
       WHERE id IN ('esportes','casa','tcg','informatica','eletronicos','games','geral')`,
    )
    .run();
} catch (e) {
  console.log("categories update skip", e);
}

const rows = getDb()
  .prepare(
    `SELECT id, title, category, product_url FROM deals
     WHERE status IN ('queued','hold_coupon','posted')`,
  )
  .all() as Array<{
  id: number;
  title: string;
  category: string;
  product_url: string | null;
}>;

let fixed = 0;
for (const r of rows) {
  const got = classifyProduct({
    title: r.title,
    productUrl: r.product_url || "",
    categoryHint: r.category,
  });
  if (got !== r.category) {
    getDb().prepare(`UPDATE deals SET category = ? WHERE id = ?`).run(got, r.id);
    fixed++;
  }
}
console.log("recategorized", fixed, "of", rows.length);
console.log("require_coupon", getSetting("ml_list_require_coupon", ""));

console.log("\n=== SANITIZE LISTS ===");
const cleaned = await sanitizeMappedLists();
console.log(JSON.stringify(cleaned, null, 2));

console.log("\n=== PUSH QUEUED WITH COUPON ===");
const pushed = await pushQueuedDealsToMappedLists({ maxPerList: 8 });
console.log(JSON.stringify(pushed, null, 2));

console.log("\n=== FILL TCG FROM OFFICIAL STORES ===");
try {
  const fill = await fillMappedListsFromOfficialStores({
    category: "tcg",
    maxPerList: 8,
  });
  console.log(JSON.stringify(fill, null, 2));
} catch (e) {
  console.log("fill tcg error", e);
}

console.log("\n=== FILL ELECTRONICS / INFO ===");
try {
  const fillE = await fillMappedListsFromOfficialStores({
    category: "eletronicos",
    maxPerList: 6,
  });
  console.log(JSON.stringify(fillE, null, 2));
} catch (e) {
  console.log("fill eletron error", e);
}
