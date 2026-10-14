// =============================================================================
// VetChain 3.0 — catálogo de productos, aprobación administrativa y especificaciones
// aprobadas para fabricar lotes.
//
// ¿Por qué aquí y no en un microservicio nuevo? El catálogo existe solo para crear
// lotes: la regla «solo un producto aprobado puede usarse para fabricar» y la copia de
// la vida útil aprobada en el lote tienen que validarse en la MISMA transacción que
// inserta el lote. Con el catálogo en manufacturing_db eso se garantiza con claves
// foráneas y bloqueos de fila; en otro servicio haría falta una llamada de red dentro
// de la creación del lote y no habría integridad referencial.
//
// Modelo (manufacturing_db):
//   product_images     metadatos de cada imagen (el archivo va en disco/volumen, NO en la tabla)
//   products           solicitud vigente: datos, estado (pendiente|aprobado|rechazado),
//                      revisión, última decisión y puntero a la versión aprobada
//   product_versions   copia INMUTABLE de las especificaciones de cada aprobación
//   product_decisions  historial: envíos, reenvíos, aprobaciones y rechazos
//   batches            + catalog_product_id y product_version_id (NULL en lotes 2.x)
//
// Seguridad: la identidad sale SIEMPRE del token (req.auth). El estado, la versión,
// la revisión y quién decide nunca se leen del cuerpo de la petición.
// =============================================================================
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { jsonError, fail, getScope, ScopeError, isMaster, isAdmin, requireRole, ADMIN_ROLES } from "./common.js";
import { SHELF_LIFE_UNITS, shelfLifeProblem, computeBatchExpiry, todayIn, parseCivilDate } from "./expiry.js";

export const APP_TIMEZONE = process.env.APP_TIMEZONE || "America/Bogota";
export const IMAGE_DIR = path.resolve(process.env.PRODUCT_IMAGE_DIR || "./uploads/product-images");
const IMAGE_MAX_KB = Number(process.env.PRODUCT_IMAGE_MAX_KB) || 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STATUSES = ["pendiente", "aprobado", "rechazado"];
export const DOSAGE_FORMS = {
  tableta: { label: "Tableta/Pastilla", unit: "mg/tableta" },
  liquido: { label: "Líquido", unit: "mg/ml" },
};

// ---------------------------------------------------------------------------
// Esquema (migración no destructiva: solo CREATE ... IF NOT EXISTS / ADD COLUMN)
// ---------------------------------------------------------------------------
export const PRODUCT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations(
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS product_images(
  id UUID PRIMARY KEY,
  owner_id INT NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  size_bytes INT NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS products(
  id UUID PRIMARY KEY,
  manufacturer_id INT NOT NULL,
  manufacturer_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','aprobado','rechazado')),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  description TEXT NOT NULL,
  dosage_form TEXT NOT NULL CHECK (dosage_form IN ('tableta','liquido')),
  concentration_value NUMERIC(12,3) NOT NULL CHECK (concentration_value > 0),
  concentration_unit TEXT NOT NULL CHECK (concentration_unit IN ('mg/tableta','mg/ml')),
  volume_ml NUMERIC(10,3) CHECK (volume_ml IS NULL OR volume_ml > 0),
  shelf_life_value INT NOT NULL CHECK (shelf_life_value > 0),
  shelf_life_unit TEXT NOT NULL CHECK (shelf_life_unit IN ('dias','meses')),
  image_id UUID NOT NULL REFERENCES product_images(id),
  revision INT NOT NULL DEFAULT 1,
  approved_version_id UUID,
  decided_by_id INT,
  decided_by_name TEXT,
  decided_by_role TEXT,
  decided_at TIMESTAMPTZ,
  rejection_reason TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT products_form_unit CHECK (
    (dosage_form = 'tableta' AND concentration_unit = 'mg/tableta' AND volume_ml IS NULL) OR
    (dosage_form = 'liquido' AND concentration_unit = 'mg/ml' AND volume_ml IS NOT NULL)));
-- Un fabricante no puede registrar dos veces el mismo producto (nombre + forma + concentración).
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_dup
  ON products(manufacturer_id, name_key, dosage_form, concentration_value, concentration_unit, COALESCE(volume_ml, 0));
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_owner ON products(manufacturer_id);

CREATE TABLE IF NOT EXISTS product_versions(
  id UUID PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES products(id),
  version_no INT NOT NULL,
  revision INT NOT NULL,
  manufacturer_id INT NOT NULL,
  manufacturer_name TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  dosage_form TEXT NOT NULL,
  concentration_value NUMERIC(12,3) NOT NULL,
  concentration_unit TEXT NOT NULL,
  volume_ml NUMERIC(10,3),
  shelf_life_value INT NOT NULL CHECK (shelf_life_value > 0),
  shelf_life_unit TEXT NOT NULL CHECK (shelf_life_unit IN ('dias','meses')),
  image_id UUID NOT NULL REFERENCES product_images(id),
  approved_by_id INT NOT NULL,
  approved_by_name TEXT NOT NULL,
  approved_by_role TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, version_no));

CREATE TABLE IF NOT EXISTS product_decisions(
  id BIGSERIAL PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES products(id),
  revision INT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('enviado','reenviado','aprobado','rechazado')),
  actor_id INT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  reason TEXT,
  version_id UUID REFERENCES product_versions(id),
  snapshot JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_product_decisions ON product_decisions(product_id, at);

-- Relación lote -> producto aprobado y versión exacta usada para el vencimiento.
-- Los lotes anteriores a la 3.0 quedan con NULL: no se modifican.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS catalog_product_id UUID REFERENCES products(id);
ALTER TABLE batches ADD COLUMN IF NOT EXISTS product_version_id UUID REFERENCES product_versions(id);
CREATE INDEX IF NOT EXISTS idx_batches_catalog ON batches(catalog_product_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_approved_version_fk') THEN
    ALTER TABLE products ADD CONSTRAINT products_approved_version_fk
      FOREIGN KEY (approved_version_id) REFERENCES product_versions(id);
  END IF;
  -- Número de lote único también a nivel de base (2.x solo lo comprobaba en la API).
  -- Si hubiera duplicados históricos no se crea el índice ni se toca ningún dato.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_batches_lot_number')
     AND NOT EXISTS (SELECT 1 FROM batches GROUP BY upper(product_id) HAVING count(*) > 1) THEN
    CREATE UNIQUE INDEX uq_batches_lot_number ON batches (upper(product_id));
  END IF;
END $$;

INSERT INTO schema_migrations(id) VALUES ('3.0-product-catalog') ON CONFLICT DO NOTHING;`;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const num = (v) => (v === null || v === undefined ? null : Number(v));
const nameKey = (s) => String(s).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const clean = (v) => (typeof v === "string" ? v.normalize("NFKC").trim().replace(/[ \t]+/g, " ") : "");

// "250 mg/tableta", "50 mg/ml", "250 mg/5 ml"
export function concentrationLabel(p) {
  const v = Number(p.concentration_value).toLocaleString("es-CO", { maximumFractionDigits: 3 });
  if (p.dosage_form === "tableta") return `${v} mg/tableta`;
  const vol = Number(p.volume_ml);
  return vol === 1 ? `${v} mg/ml` : `${v} mg/${vol.toLocaleString("es-CO", { maximumFractionDigits: 3 })} ml`;
}

function mapProduct(r) {
  if (!r) return null;
  const out = {
    id: r.id,
    manufacturer_id: r.manufacturer_id,
    manufacturer_name: r.manufacturer_name,
    status: r.status,
    name: r.name,
    description: r.description,
    dosage_form: r.dosage_form,
    dosage_form_label: DOSAGE_FORMS[r.dosage_form]?.label,
    concentration_value: num(r.concentration_value),
    concentration_unit: r.concentration_unit,
    volume_ml: num(r.volume_ml),
    concentration_label: concentrationLabel(r),
    shelf_life_value: r.shelf_life_value,
    shelf_life_unit: r.shelf_life_unit,
    image_id: r.image_id,
    revision: r.revision,
    approved_version_id: r.approved_version_id,
    approved_version_no: r.approved_version_no ?? null,
    decided_by_name: r.decided_by_name,
    decided_by_role: r.decided_by_role,
    decided_at: r.decided_at,
    rejection_reason: r.rejection_reason,
    submitted_at: r.submitted_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  return out;
}

function mapVersion(v) {
  if (!v) return null;
  return {
    id: v.id, product_id: v.product_id, version_no: v.version_no, revision: v.revision,
    name: v.name, description: v.description, dosage_form: v.dosage_form, dosage_form_label: DOSAGE_FORMS[v.dosage_form]?.label,
    concentration_value: num(v.concentration_value), concentration_unit: v.concentration_unit, volume_ml: num(v.volume_ml),
    concentration_label: concentrationLabel(v), shelf_life_value: v.shelf_life_value, shelf_life_unit: v.shelf_life_unit,
    image_id: v.image_id, manufacturer_name: v.manufacturer_name, approved_by_name: v.approved_by_name,
    approved_by_role: v.approved_by_role, approved_at: v.approved_at,
  };
}

const PRODUCT_SELECT = `select p.*, v.version_no as approved_version_no
  from products p left join product_versions v on v.id = p.approved_version_id`;

// ---------------------------------------------------------------------------
// Imágenes: data URL JPEG/PNG/WebP, firma de bytes comprobada, tamaño limitado.
// Se guardan como archivo (volumen de Docker "product_images"); en la base solo
// quedan sus metadatos. Cada imagen es inmutable: una corrección crea otra nueva,
// así las versiones aprobadas conservan la imagen con la que se aprobaron.
// ---------------------------------------------------------------------------
const IMAGE_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export function decodeImage(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl) return { error: "Adjunta una imagen del producto" };
  const m = IMAGE_RE.exec(dataUrl);
  if (!m) return { error: "Formato de imagen no permitido: usa JPG, PNG o WebP" };
  const bytes = Buffer.from(m[2], "base64");
  if (!bytes.length) return { error: "La imagen está vacía" };
  if (bytes.length > IMAGE_MAX_KB * 1024) return { error: `La imagen supera el máximo de ${IMAGE_MAX_KB} KB` };
  const okSig = {
    "image/jpeg": bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    "image/png": bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/webp": bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP",
  }[m[1]];
  if (!okSig) return { error: "El contenido del archivo no corresponde a una imagen válida" };
  return { mime: m[1], bytes };
}

async function writeImageFile(img) {
  await fs.mkdir(IMAGE_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const key = `${id}.${EXT[img.mime]}`;
  const tmp = path.join(IMAGE_DIR, `.${key}.tmp`);
  await fs.writeFile(tmp, img.bytes, { mode: 0o640 });
  await fs.rename(tmp, path.join(IMAGE_DIR, key));
  return { id, key, sha256: crypto.createHash("sha256").update(img.bytes).digest("hex") };
}
const imagePath = (key) => path.join(IMAGE_DIR, path.basename(key));

// ---------------------------------------------------------------------------
// Validación de la solicitud (frontend y servidor aplican las mismas reglas).
// Devuelve { errors: {campo: mensaje}, data }.
// ---------------------------------------------------------------------------
export function validateProductInput(body, { requireImage = true } = {}) {
  const errors = {};
  const name = clean(body.name);
  const description = typeof body.description === "string" ? body.description.normalize("NFKC").trim() : "";
  const dosage_form = typeof body.dosage_form === "string" ? body.dosage_form.trim().toLowerCase() : "";
  if (!name) errors.name = "El nombre del producto es obligatorio";
  else if (name.length < 2 || name.length > 120) errors.name = "El nombre debe tener entre 2 y 120 caracteres";
  if (!description) errors.description = "La descripción es obligatoria";
  else if (description.length < 10 || description.length > 2000) errors.description = "La descripción debe tener entre 10 y 2000 caracteres";
  if (!DOSAGE_FORMS[dosage_form]) errors.dosage_form = "Elige la forma farmacéutica: Tableta/Pastilla o Líquido";

  const conc = typeof body.concentration_value === "string" ? Number(body.concentration_value.replace(",", ".")) : Number(body.concentration_value);
  if (body.concentration_value === undefined || body.concentration_value === null || body.concentration_value === "") errors.concentration_value = "La concentración es obligatoria";
  else if (!Number.isFinite(conc) || conc <= 0 || conc > 100000) errors.concentration_value = "La concentración debe ser un número mayor que 0 y como máximo 100.000 mg";
  else if (Math.abs(conc * 1000 - Math.round(conc * 1000)) > 1e-6) errors.concentration_value = "La concentración admite como máximo 3 decimales";

  let volume_ml = null;
  if (dosage_form === "liquido") {
    const rawVol = body.volume_ml === undefined || body.volume_ml === null || body.volume_ml === "" ? 1 : body.volume_ml;
    volume_ml = typeof rawVol === "string" ? Number(rawVol.replace(",", ".")) : Number(rawVol);
    if (!Number.isFinite(volume_ml) || volume_ml <= 0 || volume_ml > 1000) errors.volume_ml = "El volumen de referencia debe estar entre 0,001 y 1000 ml";
  } else if (dosage_form === "tableta" && body.volume_ml !== undefined && body.volume_ml !== null && body.volume_ml !== "") {
    errors.volume_ml = "Las tabletas no llevan volumen de referencia";
  }
  const expectedUnit = DOSAGE_FORMS[dosage_form]?.unit;
  if (body.concentration_unit !== undefined && body.concentration_unit !== null && body.concentration_unit !== "" && expectedUnit && body.concentration_unit !== expectedUnit) {
    errors.concentration_unit = `Para ${DOSAGE_FORMS[dosage_form].label} la concentración se expresa en ${expectedUnit}`;
  }

  const shelf_life_unit = typeof body.shelf_life_unit === "string" ? body.shelf_life_unit.trim().toLowerCase().replace("í", "i") : "";
  const shelf_life_value = typeof body.shelf_life_value === "string" ? Number(body.shelf_life_value) : body.shelf_life_value;
  if (body.shelf_life_value === undefined || body.shelf_life_value === null || body.shelf_life_value === "") errors.shelf_life_value = "La vida útil es obligatoria";
  else {
    const problem = shelfLifeProblem(shelf_life_value, shelf_life_unit);
    if (problem) errors[SHELF_LIFE_UNITS[shelf_life_unit] ? "shelf_life_value" : "shelf_life_unit"] = problem;
  }

  let image = null;
  if (body.image !== undefined && body.image !== null && body.image !== "") {
    image = decodeImage(body.image);
    if (image.error) { errors.image = image.error; image = null; }
  } else if (requireImage) errors.image = "Adjunta una imagen del producto";

  return {
    errors,
    data: {
      name, name_key: nameKey(name), description, dosage_form,
      concentration_value: Math.round(conc * 1000) / 1000,
      concentration_unit: expectedUnit,
      volume_ml: volume_ml === null ? null : Math.round(volume_ml * 1000) / 1000,
      shelf_life_value: Number(shelf_life_value), shelf_life_unit, image,
    },
  };
}

function badInput(res, errors) {
  const first = Object.values(errors)[0];
  return res.status(400).json({ error: Object.keys(errors).length > 1 ? `Revisa los campos marcados: ${first}` : first, fields: errors });
}

// ¿El que llama (admin) puede ver/decidir sobre productos de este fabricante?
async function adminCanSee(req, manufacturerId) {
  if (isMaster(req)) return true;
  if (!isAdmin(req)) return false;
  const scope = await getScope(req);
  return scope.all || (scope.users || []).some((u) => Number(u.id) === Number(manufacturerId));
}
async function adminScopeIds(req) {
  if (isMaster(req)) return null; // sin filtro
  const scope = await getScope(req);
  if (scope.all) return null;
  return (scope.users || []).filter((u) => u.role === "fabricante").map((u) => Number(u.id));
}
function scopeFail(res, e, msg) {
  if (e instanceof ScopeError) return jsonError(res, e.status, e.message);
  return fail(res, e, msg);
}

async function decisionsOf(db, productId) {
  const r = await db.query(
    `select d.id, d.revision, d.action, d.actor_id, d.actor_name, d.actor_role, d.reason, d.at, d.snapshot,
            v.version_no
       from product_decisions d left join product_versions v on v.id = d.version_id
      where d.product_id = $1 order by d.at, d.id`, [productId]);
  return r.rows;
}

const snapshotOf = (d, imageId) => ({
  name: d.name, description: d.description, dosage_form: d.dosage_form, concentration_value: d.concentration_value,
  concentration_unit: d.concentration_unit, volume_ml: d.volume_ml, shelf_life_value: d.shelf_life_value,
  shelf_life_unit: d.shelf_life_unit, image_id: imageId,
});

const isDuplicate = (e) => e?.code === "23505" && /uq_products_dup/.test(e.constraint || e.message || "");
const DUP_MSG = "Ya registraste un producto con el mismo nombre, forma farmacéutica y concentración";

// ---------------------------------------------------------------------------
// Auditoría: reglas para auditTrail() (common.js). Los nombres no terminan en
// ".rejected" porque auditTrail usa "<prefijo>.rejected" para operaciones fallidas.
// ---------------------------------------------------------------------------
export const PRODUCT_AUDIT_RULES = [
  ["POST", /^\/products\/?$/, "catalog.product_submitted", (b, r) => ({ target: r.name || b.name, message: `Envió a aprobación el producto ${r.name || b.name || ""}${r.concentration_label ? ` (${r.concentration_label})` : ""}` })],
  ["PUT", /^\/products\/[^/]+\/?$/, "catalog.product_resubmitted", (b, r) => ({ target: r.name || b.name, message: `Corrigió y reenvió el producto ${r.name || b.name || ""} (revisión ${r.revision ?? "?"})` })],
  ["POST", /^\/products\/[^/]+\/approve\/?$/, "catalog.product_approved", (b, r) => ({ severity: "warning", target: r.name, message: `Aprobó el producto ${r.name || ""} de ${r.manufacturer_name || ""} (versión ${r.approved_version_no ?? "?"}, vida útil ${r.shelf_life_value ?? "?"} ${r.shelf_life_unit ?? ""})` })],
  ["POST", /^\/products\/[^/]+\/reject\/?$/, "catalog.product_rejected", (b, r) => ({ severity: "warning", target: r.name, message: `Rechazó el producto ${r.name || ""} de ${r.manufacturer_name || ""}: ${String(b.reason || "").slice(0, 160)}` })],
];

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
export function registerProductRoutes(app, { pool }) {
  const FAB = requireRole("fabricante");
  const ADM = requireRole(...ADMIN_ROLES);

  // ---- Fabricante: enviar una solicitud nueva ----
  app.post("/products", FAB, async (req, res) => {
    const { errors, data } = validateProductInput(req.body, { requireImage: true });
    if (Object.keys(errors).length) return badInput(res, errors);
    let file = null;
    const client = await pool.connect();
    try {
      const dup = await client.query(
        `select 1 from products where manufacturer_id=$1 and name_key=$2 and dosage_form=$3 and concentration_value=$4
            and concentration_unit=$5 and coalesce(volume_ml,0)=coalesce($6::numeric,0) limit 1`,
        [req.auth.id, data.name_key, data.dosage_form, data.concentration_value, data.concentration_unit, data.volume_ml]);
      if (dup.rowCount) return jsonError(res, 409, DUP_MSG);
      file = await writeImageFile(data.image);
      await client.query("BEGIN");
      await client.query(
        "insert into product_images(id,owner_id,mime,size_bytes,sha256,storage_key) values($1,$2,$3,$4,$5,$6)",
        [file.id, req.auth.id, data.image.mime, data.image.bytes.length, file.sha256, file.key]);
      const id = crypto.randomUUID();
      const r = await client.query(
        `insert into products(id,manufacturer_id,manufacturer_name,status,name,name_key,description,dosage_form,
            concentration_value,concentration_unit,volume_ml,shelf_life_value,shelf_life_unit,image_id,revision)
         values($1,$2,$3,'pendiente',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1) returning *`,
        [id, req.auth.id, req.auth.name, data.name, data.name_key, data.description, data.dosage_form, data.concentration_value,
          data.concentration_unit, data.volume_ml, data.shelf_life_value, data.shelf_life_unit, file.id]);
      await client.query(
        `insert into product_decisions(product_id,revision,action,actor_id,actor_name,actor_role,snapshot)
         values($1,1,'enviado',$2,$3,$4,$5)`, [id, req.auth.id, req.auth.name, req.auth.role, snapshotOf(data, file.id)]);
      await client.query("COMMIT");
      res.status(201).json({ ...mapProduct(r.rows[0]), message: "Solicitud enviada. Quedó pendiente de aprobación." });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (file) fs.unlink(imagePath(file.key)).catch(() => {});
      if (isDuplicate(e)) return jsonError(res, 409, DUP_MSG);
      fail(res, e, "No se pudo registrar la solicitud");
    } finally { client.release(); }
  });

  // ---- Fabricante: sus solicitudes (cualquier estado) ----
  app.get("/products/mine", FAB, async (req, res) => {
    try {
      const status = STATUSES.includes(req.query.status) ? req.query.status : null;
      const r = await pool.query(
        `${PRODUCT_SELECT} where p.manufacturer_id=$1 and ($2::text is null or p.status=$2) order by p.submitted_at desc`,
        [req.auth.id, status]);
      res.json(r.rows.map(mapProduct));
    } catch (e) { fail(res, e, "No se pudieron cargar tus productos"); }
  });

  // ---- Fabricante: productos aprobados y disponibles para fabricar ----
  // Devuelve las especificaciones de la VERSIÓN APROBADA (no las de la fila editable).
  app.get("/products/approved", FAB, async (req, res) => {
    try {
      const r = await pool.query(
        `select v.*, p.id as product_id, p.revision as product_revision
           from products p join product_versions v on v.id = p.approved_version_id
          where p.manufacturer_id=$1 and p.status='aprobado' order by lower(v.name)`, [req.auth.id]);
      res.json({ today: todayIn(APP_TIMEZONE), timezone: APP_TIMEZONE, products: r.rows.map((v) => ({ ...mapVersion(v), product_id: v.product_id })) });
    } catch (e) { fail(res, e, "No se pudieron cargar los productos aprobados"); }
  });

  // ---- Administración: conteo por estado (para el contador del menú) ----
  app.get("/products/summary", ADM, async (req, res) => {
    try {
      const ids = await adminScopeIds(req);
      const r = await pool.query(
        `select status, count(*)::int as n from products where ($1::int[] is null or manufacturer_id = any($1)) group by status`, [ids]);
      const out = { pendiente: 0, aprobado: 0, rechazado: 0 };
      r.rows.forEach((x) => { out[x.status] = x.n; });
      res.json(out);
    } catch (e) { scopeFail(res, e, "No se pudo calcular el resumen"); }
  });

  // ---- Administración: solicitudes de su ámbito ----
  app.get("/products", ADM, async (req, res) => {
    try {
      const ids = await adminScopeIds(req);
      const status = STATUSES.includes(req.query.status) ? req.query.status : null;
      const r = await pool.query(
        `${PRODUCT_SELECT} where ($1::int[] is null or p.manufacturer_id = any($1)) and ($2::text is null or p.status=$2)
          order by (p.status='pendiente') desc, p.submitted_at desc limit 1000`, [ids, status]);
      res.json(r.rows.map(mapProduct));
    } catch (e) { scopeFail(res, e, "No se pudieron cargar las solicitudes"); }
  });

  // ---- Detalle + historial (dueño o administración con ámbito) ----
  app.get("/products/:id", async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) return jsonError(res, 404, "Producto no encontrado");
      const p = (await pool.query(`${PRODUCT_SELECT} where p.id=$1`, [req.params.id])).rows[0];
      const own = p && req.auth.role === "fabricante" && Number(p.manufacturer_id) === Number(req.auth.id);
      // Fuera de su ámbito: 404 (no revela si existe), igual que en 2.10.
      if (!p || !(own || (isAdmin(req) && await adminCanSee(req, p.manufacturer_id)))) return jsonError(res, 404, "Producto no encontrado");
      const versions = (await pool.query("select * from product_versions where product_id=$1 order by version_no", [p.id])).rows.map(mapVersion);
      const batches = (await pool.query(
        `select b.id, b.product_id as lot_number, b.manufacture_date, b.expiry_date, b.quantity, b.status, v.version_no
           from batches b left join product_versions v on v.id=b.product_version_id
          where b.catalog_product_id=$1 order by b.created_at desc limit 200`, [p.id])).rows;
      res.json({ ...mapProduct(p), history: await decisionsOf(pool, p.id), versions, batches });
    } catch (e) { scopeFail(res, e, "No se pudo cargar el producto"); }
  });

  // ---- Fabricante: corregir y reenviar (rechazado) o pedir un cambio (aprobado) ----
  // Siempre vuelve a "pendiente". Si estaba aprobado, deja de poder usarse para
  // fabricar hasta la nueva aprobación; los lotes ya fabricados conservan su versión.
  app.put("/products/:id", FAB, async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return jsonError(res, 404, "Producto no encontrado");
    const { errors, data } = validateProductInput(req.body, { requireImage: false });
    if (Object.keys(errors).length) return badInput(res, errors);
    const expectedRevision = Number(req.body.revision);
    let file = null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const p = (await client.query("select * from products where id=$1 for update", [req.params.id])).rows[0];
      if (!p || Number(p.manufacturer_id) !== Number(req.auth.id)) { await client.query("ROLLBACK"); return jsonError(res, 404, "Producto no encontrado"); }
      if (p.status === "pendiente") { await client.query("ROLLBACK"); return jsonError(res, 409, "La solicitud ya está pendiente de revisión: espera la decisión antes de modificarla"); }
      if (!Number.isInteger(expectedRevision) || expectedRevision !== p.revision) {
        await client.query("ROLLBACK");
        return jsonError(res, 409, "La solicitud cambió mientras la editabas. Recarga la página para ver la versión actual.");
      }
      let imageId = p.image_id;
      if (data.image) {
        file = await writeImageFile(data.image);
        await client.query(
          "insert into product_images(id,owner_id,mime,size_bytes,sha256,storage_key) values($1,$2,$3,$4,$5,$6)",
          [file.id, req.auth.id, data.image.mime, data.image.bytes.length, file.sha256, file.key]);
        imageId = file.id;
      }
      const revision = p.revision + 1;
      const r = await client.query(
        `update products set status='pendiente', name=$2, name_key=$3, description=$4, dosage_form=$5, concentration_value=$6,
            concentration_unit=$7, volume_ml=$8, shelf_life_value=$9, shelf_life_unit=$10, image_id=$11, revision=$12,
            manufacturer_name=$13, decided_by_id=null, decided_by_name=null, decided_by_role=null, decided_at=null,
            rejection_reason=null, submitted_at=now(), updated_at=now()
          where id=$1 returning *`,
        [p.id, data.name, data.name_key, data.description, data.dosage_form, data.concentration_value, data.concentration_unit,
          data.volume_ml, data.shelf_life_value, data.shelf_life_unit, imageId, revision, req.auth.name]);
      await client.query(
        `insert into product_decisions(product_id,revision,action,actor_id,actor_name,actor_role,snapshot)
         values($1,$2,'reenviado',$3,$4,$5,$6)`, [p.id, revision, req.auth.id, req.auth.name, req.auth.role, snapshotOf(data, imageId)]);
      await client.query("COMMIT");
      const full = (await pool.query(`${PRODUCT_SELECT} where p.id=$1`, [p.id])).rows[0] || r.rows[0];
      res.json({ ...mapProduct(full), message: "Solicitud reenviada. Quedó pendiente de aprobación." });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (file) fs.unlink(imagePath(file.key)).catch(() => {});
      if (isDuplicate(e)) return jsonError(res, 409, DUP_MSG);
      fail(res, e, "No se pudo reenviar la solicitud");
    } finally { client.release(); }
  });

  // ---- Administración: aprobar / rechazar ----
  // Concurrencia: la fila se bloquea (FOR UPDATE) y se exige que siga "pendiente" en la
  // MISMA revisión que vio el administrador. Si otro administrador decidió antes, o el
  // fabricante la cambió, responde 409 y no se registra una segunda decisión.
  async function decide(req, res, action) {
    if (!UUID_RE.test(req.params.id)) return jsonError(res, 404, "Producto no encontrado");
    const reason = typeof req.body.reason === "string" ? req.body.reason.normalize("NFKC").trim() : "";
    const expectedRevision = Number(req.body.revision);
    if (action === "rechazado") {
      if (!reason) return res.status(400).json({ error: "Indica el motivo del rechazo", fields: { reason: "El motivo es obligatorio" } });
      if (reason.length < 10 || reason.length > 1000) return res.status(400).json({ error: "El motivo debe tener entre 10 y 1000 caracteres", fields: { reason: "Entre 10 y 1000 caracteres" } });
    }
    if (action === "aprobado" && req.body.confirm_shelf_life !== true) {
      return res.status(400).json({ error: "Confirma que la información está completa y que la vida útil fue validada", fields: { confirm_shelf_life: "Confirmación obligatoria" } });
    }
    if (!Number.isInteger(expectedRevision)) return jsonError(res, 400, "Falta la revisión de la solicitud que estás decidiendo");
    let p;
    try {
      p = (await pool.query("select id, manufacturer_id from products where id=$1", [req.params.id])).rows[0];
      if (!p || !(await adminCanSee(req, p.manufacturer_id))) return jsonError(res, 404, "Producto no encontrado");
    } catch (e) { return scopeFail(res, e, "No se pudo registrar la decisión"); }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cur = (await client.query("select * from products where id=$1 for update", [p.id])).rows[0];
      if (cur.status !== "pendiente") { await client.query("ROLLBACK"); return jsonError(res, 409, `La solicitud ya fue ${cur.status === "aprobado" ? "aprobada" : "rechazada"} por ${cur.decided_by_name || "otro administrador"}`); }
      if (cur.revision !== expectedRevision) { await client.query("ROLLBACK"); return jsonError(res, 409, "El fabricante modificó la solicitud mientras la revisabas. Vuelve a abrirla para ver la versión actual."); }
      let versionId = null;
      if (action === "aprobado") {
        // Información completa: todos los campos y la imagen (también en disco).
        const missing = ["name", "description", "dosage_form", "concentration_value", "concentration_unit", "shelf_life_value", "shelf_life_unit", "image_id"].filter((k) => cur[k] === null || cur[k] === "");
        const img = (await client.query("select storage_key from product_images where id=$1", [cur.image_id])).rows[0];
        const fileOk = img && await fs.stat(imagePath(img.storage_key)).then(() => true, () => false);
        if (missing.length || !fileOk) { await client.query("ROLLBACK"); return jsonError(res, 409, `No se puede aprobar: falta información (${[...missing, ...(fileOk ? [] : ["imagen"])].join(", ")})`); }
        const problem = shelfLifeProblem(cur.shelf_life_value, cur.shelf_life_unit);
        if (problem) { await client.query("ROLLBACK"); return jsonError(res, 409, `No se puede aprobar: ${problem}`); }
        const vno = (await client.query("select coalesce(max(version_no),0)+1 as n from product_versions where product_id=$1", [cur.id])).rows[0].n;
        versionId = crypto.randomUUID();
        await client.query(
          `insert into product_versions(id,product_id,version_no,revision,manufacturer_id,manufacturer_name,name,description,dosage_form,
              concentration_value,concentration_unit,volume_ml,shelf_life_value,shelf_life_unit,image_id,approved_by_id,approved_by_name,approved_by_role)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [versionId, cur.id, vno, cur.revision, cur.manufacturer_id, cur.manufacturer_name, cur.name, cur.description, cur.dosage_form,
            cur.concentration_value, cur.concentration_unit, cur.volume_ml, cur.shelf_life_value, cur.shelf_life_unit, cur.image_id,
            req.auth.id, req.auth.name, req.auth.role]);
      }
      await client.query(
        `update products set status=$2, decided_by_id=$3, decided_by_name=$4, decided_by_role=$5, decided_at=now(),
            rejection_reason=$6, approved_version_id=coalesce($7, approved_version_id), updated_at=now()
          where id=$1`,
        [cur.id, action, req.auth.id, req.auth.name, req.auth.role, action === "rechazado" ? reason : null, versionId]);
      await client.query(
        `insert into product_decisions(product_id,revision,action,actor_id,actor_name,actor_role,reason,version_id)
         values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [cur.id, cur.revision, action, req.auth.id, req.auth.name, req.auth.role, action === "rechazado" ? reason : null, versionId]);
      await client.query("COMMIT");
      const full = (await pool.query(`${PRODUCT_SELECT} where p.id=$1`, [cur.id])).rows[0];
      res.json({ ...mapProduct(full), message: action === "aprobado" ? "Producto aprobado: ya puede usarse para fabricar lotes." : "Solicitud rechazada. El fabricante verá el motivo." });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      fail(res, e, "No se pudo registrar la decisión");
    } finally { client.release(); }
  }
  app.post("/products/:id/approve", ADM, (req, res) => decide(req, res, "aprobado"));
  app.post("/products/:id/reject", ADM, (req, res) => decide(req, res, "rechazado"));

  // ---- Vista previa del vencimiento calculada por el servidor ----
  app.get("/products/:id/expiry-preview", FAB, async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) return jsonError(res, 404, "Producto no encontrado");
      const r = await pool.query(
        `select v.* from products p join product_versions v on v.id=p.approved_version_id
          where p.id=$1 and p.manufacturer_id=$2 and p.status='aprobado'`, [req.params.id, req.auth.id]);
      if (!r.rowCount) return jsonError(res, 404, "Producto aprobado no encontrado");
      const v = r.rows[0];
      const calc = computeBatchExpiry({ manufactureDate: String(req.query.manufacture_date || ""), shelfLifeValue: v.shelf_life_value, shelfLifeUnit: v.shelf_life_unit, today: todayIn(APP_TIMEZONE) });
      if (!calc.ok) return jsonError(res, 400, calc.error);
      res.json({ ...calc, product_version_id: v.id, version_no: v.version_no, shelf_life_value: v.shelf_life_value, shelf_life_unit: v.shelf_life_unit });
    } catch (e) { fail(res, e, "No se pudo calcular el vencimiento"); }
  });

  // ---- Imagen de un producto ----
  // Ven la imagen: su dueño, la administración con ámbito sobre el dueño y, si la
  // imagen pertenece a una versión APROBADA (producto en el mercado), cualquier sesión.
  app.get("/product-images/:id", async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) return jsonError(res, 404, "Imagen no encontrada");
      const img = (await pool.query(
        `select i.*, exists(select 1 from product_versions v where v.image_id=i.id) as published
           from product_images i where i.id=$1`, [req.params.id])).rows[0];
      const allowed = img && (img.published || Number(img.owner_id) === Number(req.auth.id) || (isAdmin(req) && await adminCanSee(req, img.owner_id)));
      if (!allowed) return jsonError(res, 404, "Imagen no encontrada");
      const buf = await fs.readFile(imagePath(img.storage_key)).catch(() => null);
      if (!buf) return jsonError(res, 404, "El archivo de la imagen no está disponible");
      res.set({ "Content-Type": img.mime, "Content-Length": String(buf.length), "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600", "Content-Security-Policy": "default-src 'none'" });
      res.end(buf);
    } catch (e) { scopeFail(res, e, "No se pudo cargar la imagen"); }
  });
}

// ---------------------------------------------------------------------------
// Creación de lotes a partir de un producto aprobado (la llama POST /batches,
// dentro de su transacción). Bloquea la fila del producto (FOR SHARE) para que
// una modificación simultánea no cambie la versión a mitad de la operación.
// Devuelve { error, status } o { version, expiry_date, manufacture_date }.
// ---------------------------------------------------------------------------
export async function resolveApprovedProduct(client, req, body) {
  const pid = typeof body.catalog_product_id === "string" ? body.catalog_product_id.trim() : "";
  if (!UUID_RE.test(pid)) return { status: 400, error: "Selecciona un producto aprobado del catálogo" };
  const r = await client.query(
    // Las columnas del producto llevan alias propios: v.* (LEFT JOIN) trae también
    // "manufacturer_id" e "id", que serían NULL si el producto aún no tiene versión aprobada.
    `select v.*, p.id as pid, p.status as product_status, p.manufacturer_id as owner_id, p.approved_version_id as current_version_id
       from products p left join product_versions v on v.id = p.approved_version_id
      where p.id=$1 for share of p`, [pid]);
  const row = r.rows[0];
  if (!row || Number(row.owner_id) !== Number(req.auth.id)) return { status: 404, error: "Producto no encontrado en tu catálogo" };
  if (row.product_status !== "aprobado" || !row.current_version_id) {
    return { status: 409, error: row.product_status === "pendiente" ? "El producto está pendiente de aprobación: todavía no puede usarse para fabricar" : "El producto fue rechazado: corrígelo y espera su aprobación antes de fabricar" };
  }
  // Si el cliente indica la versión que vio, debe seguir siendo la vigente.
  if (body.product_version_id !== undefined && body.product_version_id !== null && body.product_version_id !== "" && body.product_version_id !== row.current_version_id) {
    return { status: 409, error: "Las especificaciones aprobadas del producto cambiaron. Vuelve a seleccionarlo para ver los datos vigentes." };
  }
  const calc = computeBatchExpiry({
    manufactureDate: String(body.manufacture_date || ""), shelfLifeValue: row.shelf_life_value,
    shelfLifeUnit: row.shelf_life_unit, today: todayIn(APP_TIMEZONE),
  });
  if (!calc.ok) return { status: 400, error: calc.error };
  // La fecha de vencimiento NO se acepta del cliente. Si llega una distinta a la
  // calculada, se rechaza (petición manipulada); si coincide, es solo informativa.
  if (body.expiry_date !== undefined && body.expiry_date !== null && body.expiry_date !== "" && body.expiry_date !== calc.expiry_date) {
    return { status: 400, error: `La fecha de vencimiento la calcula VetChain y no puede enviarse desde el cliente (enviada ${String(body.expiry_date).slice(0, 10)}, calculada ${calc.expiry_date})` };
  }
  return { version: { ...row, id: row.current_version_id }, ...calc };
}

export { mapVersion };
