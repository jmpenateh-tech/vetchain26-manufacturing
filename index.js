import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { pool, initDb, publish, consume, jsonError, fail, bodyDefault, installErrorHandlers } from "./common.js";

const app = express();
const PORT = process.env.PORT || 3002;
const MAX_QUANTITY = 100000;

app.use(express.json());
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

app.get("/", (_, res) => res.json({ service: "manufacturing-service", status: "ok" }));
app.get("/health", async (_, res) => {
  try { await pool.query("select 1"); res.json({ status: "ok", database: "ok" }); }
  catch { res.status(503).json({ status: "down" }); }
});

app.post("/batches", async (req, res) => {
  try {
    const { product_name, manufacture_date, expiry_date, quantity, generate_serials, serial_prefix } = req.body;
    const product_id = typeof req.body.product_id === "string" ? req.body.product_id.trim().toUpperCase() : req.body.product_id;
    // Fabricante: el que envía el frontend o, si no, el usuario autenticado (cabecera del gateway).
    let manufacturer = typeof req.body.manufacturer === "string" ? req.body.manufacturer.trim() : "";
    if (!manufacturer && req.headers["x-user-name"]) {
      try { manufacturer = decodeURIComponent(req.headers["x-user-name"]); } catch { /* ignorar */ }
    }
    if (!product_id || !manufacture_date || !expiry_date || !quantity) {
      return jsonError(res, 400, "product_id, manufacture_date, expiry_date y quantity son obligatorios");
    }
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
      return jsonError(res, 400, `quantity debe ser un entero entre 1 y ${MAX_QUANTITY}`);
    }
    const made = new Date(manufacture_date), exp = new Date(expiry_date);
    if (isNaN(made) || isNaN(exp)) return jsonError(res, 400, "Las fechas deben tener formato YYYY-MM-DD");
    if (exp <= made) return jsonError(res, 400, "La fecha de vencimiento debe ser posterior a la de fabricación");

    // El número de lote (product_id) identifica el lote para las personas: no puede repetirse.
    const dup = await pool.query("select 1 from batches where upper(product_id)=upper($1) limit 1", [product_id]);
    if (dup.rowCount) return jsonError(res, 409, `Ya existe un lote con el número ${product_id}`);

    const r = await pool.query(
      `INSERT INTO batches(id,product_id,product_name,manufacture_date,expiry_date,quantity,manufacturer)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [crypto.randomUUID(), product_id, product_name || null, manufacture_date, expiry_date, qty, manufacturer || null]
    );
    const batch = r.rows[0];
    // generate_serials=true: crea las unidades en la misma petición (antes eran 2 llamadas
    // y, si la segunda fallaba, el lote quedaba sin números de serie).
    if (generate_serials) {
      const serials = await insertSerials(batch, serial_prefix);
      res.status(201).json({ ...batch, serial_count: serials.length });
      await publish("batch.created", { batch, serial_numbers: serials });
    } else {
      res.status(201).json(batch);
      await publish("batch.created", { batch });
    }
  } catch (e) { if (!res.headersSent) fail(res, e, "Error registrando lote"); else console.error(e); }
});

app.get("/batches", async (_, res) =>
  res.json((await pool.query(
    `select b.*, (select count(*)::int from serial_numbers s where s.batch_id=b.id) as serial_count
       from batches b order by b.created_at desc`)).rows));

app.get("/batches/:id", async (req, res) => {
  const r = await pool.query("select * from batches where id=$1", [req.params.id]);
  if (!r.rowCount) return jsonError(res, 404, "Lote no encontrado");
  res.json(r.rows[0]);
});

async function insertSerials(b, rawPrefix) {
  const prefix = String(rawPrefix || "VET").replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "VET";
  const serials = [];
  for (let i = 0; i < b.quantity; i++) {
    serials.push(`${prefix}-${String(b.id).slice(0, 8)}-${String(i + 1).padStart(5, "0")}`);
  }
  await pool.query(
    `INSERT INTO serial_numbers(serial_code,batch_id)
     SELECT * FROM UNNEST($1::text[],$2::uuid[]) ON CONFLICT DO NOTHING`,
    [serials, serials.map(() => b.id)]
  );
  return serials;
}

app.get("/serial-numbers/batch/:batch_id", async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), MAX_QUANTITY);
  res.json((await pool.query(
    "select * from serial_numbers where batch_id=$1 order by serial_code limit $2",
    [req.params.batch_id, limit])).rows);
});

app.post("/batches/:id/serial-numbers", async (req, res) => {
  try {
    const b = (await pool.query("select * from batches where id=$1", [req.params.id])).rows[0];
    if (!b) return jsonError(res, 404, "Lote no encontrado");
    if (b.status === "recall") return jsonError(res, 409, "El lote está en recall: no se pueden generar seriales");

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
