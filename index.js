import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { pool, initDb, publish, consume, jsonError, fail, bodyDefault, installErrorHandlers,
  authenticate, auditTrail, requireRole, sameEntity } from "./common.js";
// 3.0: catálogo de productos, aprobación administrativa y vencimiento automático.
import { PRODUCT_SCHEMA_SQL, PRODUCT_AUDIT_RULES, registerProductRoutes, resolveApprovedProduct, concentrationLabel } from "./products.js";

const app = express();
const PORT = process.env.PORT || 3002;
const MAX_QUANTITY = 100000;
const PRODUCT_ID_RE = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.disable("x-powered-by");
// 3.0: 2 MB para admitir la imagen del producto (data URL, máx. PRODUCT_IMAGE_MAX_KB).
app.use(express.json({ limit: "2mb" }));
app.use(bodyDefault);

await initDb(`
CREATE TABLE IF NOT EXISTS batches(
  id UUID PRIMARY KEY,
  product_id TEXT NOT NULL,
  manufacture_date DATE NOT NULL,
  expiry_date DATE NOT NULL,
  quantity INT NOT NULL CHECK(quantity>0),
  status TEXT NOT NULL DEFAULT 'activo',
  created_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE batches ADD COLUMN IF NOT EXISTS product_name TEXT;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS manufacturer TEXT;
CREATE TABLE IF NOT EXISTS serial_numbers(
  serial_code TEXT PRIMARY KEY,
  batch_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'activo');
CREATE INDEX IF NOT EXISTS idx_serials_batch ON serial_numbers(batch_id);`);
// 3.0: migración no destructiva del catálogo (ver products.js). Los lotes 2.x no se tocan.
await initDb(PRODUCT_SCHEMA_SQL);

app.get("/", (_, res) => res.json({ service: "manufacturing-service", status: "ok" }));
app.get("/health", async (_, res) => {
  try { await pool.query("select 1"); res.json({ status: "ok", database: "ok" }); }
  catch { res.status(503).json({ status: "down" }); }
});

// 2.7: todas las rutas (salvo / y /health) exigen una sesión válida (C1).
// 2.8: registro de auditoría (va antes de authenticate para anotar también los 401).
app.use(auditTrail("manufacturing", [
  ["POST", /^\/batches\/?$/, "batch.created", (b, r) => ({ target: r.product_id || b.product_id, message: `Registró el lote ${r.product_id || b.product_id || ""}${r.product_name ? ` de ${r.product_name}` : ""}${r.serial_count ? ` con ${r.serial_count} unidades` : ""}${r.expiry_date ? `, vence ${r.expiry_date}` : ""}` })],
  ...PRODUCT_AUDIT_RULES,
  ["POST", /^\/batches\/[^/]+\/serial-numbers\/?$/, "batch.serials", (b, r) => ({ target: r.batch_id, message: `Generó ${r.count ?? ""} números de serie` })],
]));
app.use(authenticate);

// 3.0: un lote SOLO puede crearse a partir de un producto APROBADO del catálogo del
// fabricante. La fecha de vencimiento la calcula el servidor con la vida útil de la
// versión aprobada y se guarda junto con la referencia a esa versión.
app.post("/batches", requireRole("fabricante"), async (req, res) => {
  const { manufacture_date, quantity, generate_serials, serial_prefix } = req.body;
  const product_id = typeof req.body.product_id === "string" ? req.body.product_id.trim().toUpperCase() : "";
  // 2.7 (A1): el fabricante es SIEMPRE la cuenta que inicia sesión; se ignora el
  // "manufacturer" que venga en el cuerpo.
  const manufacturer = req.auth.name;
  if (!req.body.catalog_product_id) {
    return jsonError(res, 400, "Desde VetChain 3.0 los lotes se crean a partir de un producto aprobado: selecciona uno de tu catálogo (catalog_product_id)");
  }
  if (!product_id || !manufacture_date || !quantity) {
    return jsonError(res, 400, "catalog_product_id, product_id (número de lote), manufacture_date y quantity son obligatorios");
  }
  if (!PRODUCT_ID_RE.test(product_id)) {
    return jsonError(res, 400, "El número de lote solo admite letras, números, punto, guion y guion bajo (máx. 40)");
  }
  // quantity = número de UNIDADES fabricadas (tabletas, frascos...). No tiene relación
  // con la concentración del producto (mg por tableta / mg por ml).
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
    return jsonError(res, 400, `quantity debe ser un entero entre 1 y ${MAX_QUANTITY}`);
  }

  const client = await pool.connect();
  let batch, serials = null;
  try {
    await client.query("BEGIN");
    const resolved = await resolveApprovedProduct(client, req, req.body);
    if (resolved.error) { await client.query("ROLLBACK"); return jsonError(res, resolved.status, resolved.error); }
    const v = resolved.version;
    // El número de lote (product_id) identifica el lote para las personas: no puede repetirse.
    const dup = await client.query("select 1 from batches where upper(product_id)=upper($1) limit 1", [product_id]);
    if (dup.rowCount) { await client.query("ROLLBACK"); return jsonError(res, 409, `Ya existe un lote con el número ${product_id}`); }
    // product_name se sigue llenando (lo usan distribución, seguimiento, reportes y PDF).
    const productName = `${v.name} ${concentrationLabel(v)}`.slice(0, 160);
    const r = await client.query(
      `INSERT INTO batches(id,product_id,product_name,manufacture_date,expiry_date,quantity,manufacturer,catalog_product_id,product_version_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [crypto.randomUUID(), product_id, productName, resolved.manufacture_date, resolved.expiry_date, qty, manufacturer || null, v.pid, v.id]
    );
    batch = r.rows[0];
    // generate_serials=true: crea las unidades en la misma transacción (antes eran 2
    // llamadas y, si la segunda fallaba, el lote quedaba sin números de serie).
    if (generate_serials) serials = await insertSerials(batch, serial_prefix, client);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e?.code === "23505" && /uq_batches_lot_number/.test(e.constraint || e.message || "")) return jsonError(res, 409, `Ya existe un lote con el número ${product_id}`);
    return fail(res, e, "Error registrando lote");
  } finally {
    client.release(); // siempre, también en las respuestas de error tempranas
  }
  const out = await batchWithCatalog(batch.id);
  res.status(201).json(serials ? { ...out, serial_count: serials.length } : out);
  await publish("batch.created", serials ? { batch: out, serial_numbers: serials } : { batch: out });
});

// 3.0: cada lote incluye "catalog" con la versión APROBADA usada al fabricarlo (la
// copia inmutable de product_versions). Es null en los lotes anteriores a la 3.0.
const CATALOG_SQL = `case when v.id is null then null else json_build_object(
    'product_id', v.product_id, 'version_id', v.id, 'version_no', v.version_no, 'name', v.name,
    'dosage_form', v.dosage_form, 'concentration_value', v.concentration_value, 'concentration_unit', v.concentration_unit,
    'volume_ml', v.volume_ml, 'shelf_life_value', v.shelf_life_value, 'shelf_life_unit', v.shelf_life_unit,
    'image_id', v.image_id, 'approved_by_name', v.approved_by_name, 'approved_at', v.approved_at) end as catalog`;

function withCatalogLabel(b) {
  if (b?.catalog) b.catalog.concentration_label = concentrationLabel(b.catalog);
  return b;
}
async function batchWithCatalog(id) {
  const r = await pool.query(
    `select b.*, ${CATALOG_SQL} from batches b left join product_versions v on v.id=b.product_version_id where b.id=$1`, [id]);
  return withCatalogLabel(r.rows[0] || null);
}

app.get("/batches", async (_, res) =>
  res.json((await pool.query(
    `select b.*, (select count(*)::int from serial_numbers s where s.batch_id=b.id) as serial_count, ${CATALOG_SQL}
       from batches b left join product_versions v on v.id=b.product_version_id order by b.created_at desc`)).rows.map(withCatalogLabel)));

app.get("/batches/:id", async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return jsonError(res, 404, "Lote no encontrado");
  const b = await batchWithCatalog(req.params.id);
  if (!b) return jsonError(res, 404, "Lote no encontrado");
  res.json(b);
});

// 2.7 (M1): cada serial lleva 8 caracteres aleatorios (crypto) en lugar de un
// consecutivo: conocer una unidad ya no permite deducir las demás del lote.
// Formato: VET-1A2B3C4D-K7Q9XM2P (prefijo, inicio del id del lote, parte aleatoria).
const SERIAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O ni 1/I
function randomCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (const byte of bytes) out += SERIAL_ALPHABET[byte % SERIAL_ALPHABET.length];
  return out;
}

async function insertSerials(b, rawPrefix, db = pool) {
  const prefix = (String(rawPrefix || "VET").replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "VET").toUpperCase();
  const head = `${prefix}-${String(b.id).slice(0, 8).toUpperCase()}-`;
  const wanted = new Set();
  while (wanted.size < b.quantity) wanted.add(head + randomCode());
  const serials = [...wanted];
  const r = await db.query(
    `INSERT INTO serial_numbers(serial_code,batch_id)
     SELECT * FROM UNNEST($1::text[],$2::uuid[]) ON CONFLICT DO NOTHING RETURNING serial_code`,
    [serials, serials.map(() => b.id)]
  );
  return r.rows.map((x) => x.serial_code);
}

app.get("/serial-numbers/batch/:batch_id", async (req, res) => {
  if (!UUID_RE.test(req.params.batch_id)) return res.json([]);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), MAX_QUANTITY);
  res.json((await pool.query(
    "select * from serial_numbers where batch_id=$1 order by serial_code limit $2",
    [req.params.batch_id, limit])).rows);
});

app.post("/batches/:id/serial-numbers", requireRole("fabricante"), async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return jsonError(res, 404, "Lote no encontrado");
    const b = (await pool.query("select * from batches where id=$1", [req.params.id])).rows[0];
    if (!b) return jsonError(res, 404, "Lote no encontrado");
    // 2.7 (A1): solo el fabricante dueño del lote puede generar sus unidades.
    if (!sameEntity(b.manufacturer, req.auth.name)) return jsonError(res, 403, "Solo el fabricante que registró el lote puede generar sus números de serie");
    if (b.status === "recall") return jsonError(res, 409, "El lote está en recall: no se pueden generar seriales");
    // Con seriales aleatorios, regenerar crearía unidades de más: solo se permite una vez.
    const existing = await pool.query("select count(*)::int as n from serial_numbers where batch_id=$1", [b.id]);
    if (existing.rows[0].n > 0) return jsonError(res, 409, "Este lote ya tiene sus números de serie generados");

    const serials = await insertSerials(b, req.body.prefix);
    await publish("batch.created", { batch: b, serial_numbers: serials });
    res.status(201).json({ batch_id: b.id, count: serials.length, serial_numbers: serials });
  } catch (e) { fail(res, e, "Error generando seriales"); }
});

app.get("/serial-numbers/:serial", async (req, res) => {
  const r = await pool.query("select * from serial_numbers where serial_code=$1", [req.params.serial]);
  if (!r.rowCount) return jsonError(res, 404, "Serial no encontrado");
  res.json(r.rows[0]);
});

// 3.0: catálogo de productos (fabricante) y solicitudes de aprobación (administración).
registerProductRoutes(app, { pool });

// Un recall marca el lote y todas sus unidades como retirados.
consume("manufacturing-service", async (msg) => {
  if (msg.event === "recall.initiated") {
    const id = msg.payload.batch_id;
    await pool.query("update batches set status='recall' where id=$1", [id]);
    await pool.query("update serial_numbers set status='retirado' where batch_id=$1", [id]);
  }
});

installErrorHandlers(app);
app.listen(PORT, () => console.log(`Manufacturing Service http://localhost:${PORT}`));
