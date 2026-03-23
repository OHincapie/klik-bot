-- ============================================================
-- KlikBot Schema
-- Correr en: Supabase → SQL Editor → New query → Run
-- ============================================================

-- PRODUCTOS
-- Cada producto tiene nombre, descripción, precio y stock.
-- is_active permite "ocultar" un producto sin borrarlo (soft delete).
CREATE TABLE products (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- ID único generado automáticamente
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    price       DECIMAL(10, 2) NOT NULL,                   -- Hasta 99,999,999.99
    stock       INTEGER NOT NULL DEFAULT 0,
    is_active   BOOLEAN DEFAULT TRUE,                      -- FALSE = no aparece en el bot
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- CLIENTES
-- Un cliente se identifica por su número de teléfono (único).
-- Se registra la primera vez que interactúa con el bot.
CREATE TABLE customers (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number VARCHAR(20) UNIQUE NOT NULL,              -- ej: "573001234567"
    name         VARCHAR(255),
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- PEDIDOS
-- Relaciona un cliente con un producto.
-- status representa el ciclo de vida del pedido:
--   pending   → recién creado, esperando confirmación/pago
--   confirmed → pago confirmado o pedido aceptado manualmente
--   shipped   → en camino
--   delivered → entregado
--   cancelled → cancelado (stock repuesto automáticamente por el bot)
CREATE TABLE orders (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers (id),
    product_id  UUID NOT NULL REFERENCES products (id),
    quantity    INTEGER NOT NULL DEFAULT 1,
    total_price DECIMAL(10, 2) NOT NULL,  -- Precio total al momento del pedido
    status          VARCHAR(50) NOT NULL DEFAULT 'pending',
    payment_method  VARCHAR(20) NOT NULL DEFAULT 'contra_entrega', -- 'contra_entrega' | 'nequi' | 'bre_b'
    notes           TEXT,                     -- Notas adicionales del cliente (dirección, variante, etc.)
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- DATOS DE ENVÍO
-- Se crea un registro por cada pedido con la dirección de entrega.
-- Separado de orders para mantener los datos estructurados y consultables,
-- y poder integrarse fácilmente con transportadoras (Servientrega, Coordinadora, etc.)
CREATE TABLE shipping_info (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id),
    full_name       VARCHAR(255) NOT NULL,       -- Nombre completo del destinatario
    cedula          VARCHAR(20) NOT NULL,         -- Cédula para entrega y guía
    phone           VARCHAR(20) NOT NULL,         -- Teléfono de contacto para el mensajero
    city            VARCHAR(100) NOT NULL,        -- Ciudad de entrega
    neighborhood    VARCHAR(100) NOT NULL,        -- Barrio
    address         VARCHAR(255) NOT NULL,        -- Dirección completa (calle, número)
    address_details TEXT,                         -- Indicaciones opcionales (apto, punto de referencia)
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Producto inicial (descomentar y editar con tu producto real)
-- ============================================================
-- INSERT INTO products (name, description, price, stock)
-- VALUES (
--     'Nombre del producto',
--     'Descripción del producto',
--     99.99,
--     100
-- );
