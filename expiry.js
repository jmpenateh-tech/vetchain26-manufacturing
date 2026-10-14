// =============================================================================
// VetChain 3.0 — cálculo de la fecha de vencimiento de un lote.
//
// Sin dependencias y sin zonas horarias: las fechas de fabricación y de vencimiento
// son fechas CIVILES ("YYYY-MM-DD", columnas DATE de PostgreSQL). Toda la aritmética
// se hace con componentes de calendario en UTC, así el resultado no cambia según la
// zona horaria del servidor ni por el horario de verano.
//
// Reglas (documentadas en INFORME-3.0.md):
//   - Vida útil en DÍAS:  fabricación + N días de calendario.
//   - Vida útil en MESES: el mismo día del mes de destino. Si ese día no existe
//     (p. ej. 31 de enero + 1 mes, o 29 de febrero + 12 meses en año no bisiesto),
//     se usa el ÚLTIMO día de ese mes (28/29 de febrero, 30 de abril...). Nunca se
//     "salta" al mes siguiente.
//       2027-01-15 + 12 meses = 2028-01-15
//       2024-02-29 + 12 meses = 2025-02-28
//       2026-01-31 +  1 mes   = 2026-02-28
//   - "Hoy" (para impedir fechas de fabricación futuras) se calcula en la zona
//     horaria del negocio (APP_TIMEZONE, por defecto America/Bogota), no en UTC.
//
// El frontend tiene una copia de addShelfLife() solo para la VISTA PREVIA
// (frontend/js/api.js); el valor que se guarda es siempre el de este archivo.
// tests/expiry-3.0.test.mjs comprueba que ambas copias dan el mismo resultado.
// =============================================================================

export const SHELF_LIFE_UNITS = {
  dias: { label: "días", min: 1, max: 3650 },  // hasta 10 años
  meses: { label: "meses", min: 1, max: 120 }, // hasta 10 años
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n, w = 2) => String(n).padStart(w, "0");

// "YYYY-MM-DD" -> { y, m, d } o null si el formato o la fecha no son válidos
// (2026-02-30, 2026-13-01... devuelven null).
export function parseCivilDate(value) {
  const match = DATE_RE.exec(String(value ?? ""));
  if (!match) return null;
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  if (y < 1900 || y > 9999) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d };
}

const fmt = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12

export function shelfLifeProblem(value, unit) {
  const spec = SHELF_LIFE_UNITS[unit];
  if (!spec) return "La unidad de la vida útil debe ser «dias» o «meses»";
  const n = Number(value);
  if (!Number.isInteger(n) || n < spec.min || n > spec.max) return `La vida útil debe ser un número entero entre ${spec.min} y ${spec.max} ${spec.label}`;
  return null;
}

// Fecha de vencimiento = fabricación + vida útil. Lanza RangeError si algo no es válido.
export function addShelfLife(manufactureDate, value, unit) {
  const p = parseCivilDate(manufactureDate);
  if (!p) throw new RangeError("La fecha de fabricación debe tener formato YYYY-MM-DD y ser una fecha real");
  const problem = shelfLifeProblem(value, unit);
  if (problem) throw new RangeError(problem);
  const n = Number(value);
  if (unit === "dias") {
    const t = new Date(Date.UTC(p.y, p.m - 1, p.d) + n * 86400000);
    return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  const total = (p.m - 1) + n;
  const y = p.y + Math.floor(total / 12);
  const m = (total % 12) + 1;
  return fmt(y, m, Math.min(p.d, daysInMonth(y, m)));
}

// Fecha de hoy ("YYYY-MM-DD") en una zona horaria IANA.
export function todayIn(timeZone = "America/Bogota", now = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  }
  const get = (t) => parts.find((x) => x.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Valida la fecha de fabricación y calcula el vencimiento con la vida útil APROBADA.
// Devuelve { ok:true, manufacture_date, expiry_date } o { ok:false, error }.
export function computeBatchExpiry({ manufactureDate, shelfLifeValue, shelfLifeUnit, today }) {
  if (!parseCivilDate(manufactureDate)) return { ok: false, error: "La fecha de fabricación debe tener formato YYYY-MM-DD y ser una fecha real" };
  if (manufactureDate > today) return { ok: false, error: "La fecha de fabricación no puede ser futura" };
  const problem = shelfLifeProblem(shelfLifeValue, shelfLifeUnit);
  if (problem) return { ok: false, error: `El producto no tiene una vida útil válida: ${problem}` };
  const expiry = addShelfLife(manufactureDate, shelfLifeValue, shelfLifeUnit);
  if (!(expiry > manufactureDate)) return { ok: false, error: "La fecha de vencimiento debe ser posterior a la de fabricación" };
  return { ok: true, manufacture_date: manufactureDate, expiry_date: expiry };
}
