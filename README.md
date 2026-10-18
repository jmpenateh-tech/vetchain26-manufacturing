# manufacturing-service — VetChain

Servicio de fabricación. Administra el **catálogo de productos** del fabricante y la **creación de
lotes** con sus números de serie (unidades), calculando la fecha de vencimiento en el servidor.

## Responsabilidad en la arquitectura

Es el **origen de la cadena de custodia**. Registra los productos y los lotes que después se
distribuyen, verifican y dispensan.

- **Catálogo de productos (3.0)**: alta por el fabricante (imagen, concentración estructurada, forma
  farmacéutica, descripción y vida útil), con **flujo de aprobación** por la administración,
  historial de versiones y auditoría.
- **Lotes**: solo se crean desde un **producto aprobado**, con la **fecha de vencimiento calculada por
  el servidor** (`expiry.js`) y generación de seriales.
- Publica los eventos `batch.created` para que traceability, fraud y notification reaccionen.

## Tecnologías

| Componente | Versión |
|---|---|
| Node.js | ≥ 18 |
| Express | ^5.2.1 |
| pg | ^8.16.3 |
| amqplib (RabbitMQ) | ^0.10.9 |
| dotenv | ^18.0.1 |

## Instalación y ejecución

**Método oficial (recomendado): Docker Compose**, desde la raíz del proyecto:

```bash
docker compose up -d --build --wait
```

**Ejecución directa** (requiere PostgreSQL y RabbitMQ accesibles):

```bash
npm install
node index.js        # o: npm start
```

El servicio escucha en `PORT` (3002 por defecto).

## Endpoints principales

### Lotes y seriales (`index.js`)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/` , `/health` | Público | Identificación y estado. |
| POST | `/batches` | fabricante | Crea un lote desde un producto aprobado y genera sus seriales. |
| GET | `/batches` | Autenticado | Listado de lotes. |
| GET | `/batches/:id` | Autenticado | Detalle de un lote. |
| GET | `/serial-numbers/batch/:batch_id` | Autenticado | Seriales de un lote. |
| POST | `/batches/:id/serial-numbers` | fabricante | Genera seriales adicionales para un lote. |
| GET | `/serial-numbers/:serial` | Autenticado | Consulta un serial concreto. |

### Catálogo de productos (`products.js`)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| POST | `/products` | fabricante | Registra un producto y lo envía a aprobación. |
| GET | `/products/mine` | fabricante | Productos del fabricante autenticado. |
| GET | `/products/approved` | fabricante | Productos aprobados (para crear lotes). |
| GET | `/products/summary` | admin / master-admin | Resumen para la administración. |
| GET | `/products` | admin / master-admin | Listado con ámbito. |
| GET | `/products/:id` | Autenticado | Detalle + historial de versiones. |
| PUT | `/products/:id` | fabricante | Corrige y reenvía a aprobación. |
| POST | `/products/:id/approve` | admin / master-admin | Aprueba (confirmando la vida útil). |
| POST | `/products/:id/reject` | admin / master-admin | Rechaza con motivo. |
| GET | `/products/:id/expiry-preview` | fabricante | Previsualiza la fecha de vencimiento. |
| GET | `/product-images/:id` | Autenticado | Imagen del producto. |

## Variables de entorno

| Variable | Defecto | Descripción |
|---|---|---|
| `PORT` | `3002` | Puerto de escucha. |
| `DATABASE_URL` | — | Conexión a PostgreSQL. |
| `DB_NAME` | — | Base de datos a usar dentro de la misma instancia. |
| `DB_POOL_MAX` | `10` | Tamaño máximo del pool de conexiones. |
| `RABBITMQ_URL` | `amqp://localhost:5672` | Conexión AMQP. |
| `JWT_SECRET` | — | Verificación del token. |
| `AUTH_SERVICE_URL` | `http://localhost:3001` | Validación de sesión/ámbito. |
| `APP_TIMEZONE` | `America/Bogota` | Zona horaria para "hoy" (fechas civiles). |

## Base de datos

- `products`, `product_versions`, `product_decisions`, `product_images`, `schema_migrations` — catálogo.
- `batches` (`id`, `product_id`, `manufacture_date`, `expiry_date`, `quantity`, `status`, `manufacturer`, …).
- `serial_numbers` (`serial_code`, `batch_id`, `status`) + `idx_serials_batch`.

## Reglas de negocio

- **Un lote solo se crea desde un producto aprobado.** El `manufacturer` es la entidad autenticada
  (el valor del cuerpo se ignora).
- **Vencimiento calculado en el servidor** (`expiry.js`, fuente única de verdad):
  - Vida útil en **días**: fabricación + N días de calendario.
  - Vida útil en **meses**: mismo día del mes destino; si no existe (31 ene + 1 mes, 29 feb + 1 año),
    se usa el **último día** de ese mes. Nunca salta de mes.
  - La fecha de fabricación **no puede ser futura** (se compara en la zona horaria del negocio).
  - Límites: días 1–3650, meses 1–120.
- **Productos**: `name` 2–120, `description` 10–2000, `concentration_value` > 0 y ≤ 100000, para
  `tableta` el `concentration_unit` debe ser `mg/tableta`. Producto duplicado → `409`.
- **Cantidades**: `quantity` entero 1–100000; `product_id` con patrón `^[A-Z0-9][A-Z0-9._-]{0,39}$`.
- Cuerpo JSON limitado a **2 MB**.

## Eventos

- **Publica** (`vetchain.events`): `batch.created` al crear un lote.
- **Consume**: ninguno.
