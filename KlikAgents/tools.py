"""
tools.py — Herramientas que el agente puede usar para interactuar con la base de datos

¿Qué es una "tool" en este contexto?
  Cuando el agente (GPT-4o) decide que necesita información o debe ejecutar una acción,
  le "pide" al SDK que llame una función Python. El SDK ejecuta la función, le pasa el
  resultado al modelo, y el modelo continúa razonando. Esto es el loop ReAct.

@function_tool:
  El decorador del SDK convierte una función Python normal en una tool que GPT puede usar.
  El SDK automáticamente:
    - Lee el nombre y el docstring de la función → descripción de la tool para el LLM
    - Lee los parámetros y sus tipos → esquema JSON que el LLM usa para llamarla
    - Ejecuta la función cuando el LLM la solicita

RunContextWrapper[AgentContext]:
  El primer parámetro de una tool puede ser el "contexto de ejecución".
  Si el parámetro está anotado como RunContextWrapper[T], el SDK lo inyecta
  automáticamente — el LLM NO lo ve ni lo pasa como argumento.
  Esto nos permite inyectar el número de teléfono del usuario en todas las tools
  sin que el modelo tenga que "saber" el número ni pasarlo explícitamente.

Parámetros SQL ($1, $2, ...):
  asyncpg usa placeholders posicionales en lugar de f-strings o .format()
  para prevenir SQL injection. Los valores van como argumentos separados.
"""

import json
from dataclasses import dataclass
from agents import function_tool, RunContextWrapper
import db


@dataclass
class AgentContext:
    """
    Datos de contexto disponibles en todas las tools durante una ejecución.
    El agente no ve este objeto directamente, solo lo usamos internamente.
    """
    phone: str  # Número de teléfono del usuario activo


# ──────────────────────────────────────────────────────────────────────────────
# PRODUCTOS
# ──────────────────────────────────────────────────────────────────────────────

@function_tool
async def list_products(ctx: RunContextWrapper[AgentContext]) -> str:
    """
    Lista todos los productos disponibles con su precio y stock.
    El agente llama esta tool cuando el usuario pregunta qué se vende
    o antes de crear un pedido para verificar disponibilidad.
    """
    rows = await db.fetch(
        "SELECT id, name, description, price, stock FROM products WHERE is_active = TRUE"
    )
    if not rows:
        return "No hay productos disponibles en este momento."

    # Convertimos a lista de dicts para serializar a JSON.
    # default=str maneja tipos como UUID y Decimal que no son JSON-serializables nativamente.
    products = [dict(r) for r in rows]
    return json.dumps(products, default=str)


# ──────────────────────────────────────────────────────────────────────────────
# CLIENTES
# ──────────────────────────────────────────────────────────────────────────────

@function_tool
async def register_customer(ctx: RunContextWrapper[AgentContext], name: str) -> str:
    """
    Registra al cliente con su nombre. Usar cuando el cliente se presenta por primera vez.
    Si el cliente ya existe, actualiza su nombre si cambió.
    El número de teléfono se obtiene del contexto (no lo pasa el LLM).
    """
    phone = ctx.context.phone  # Inyectado desde AgentContext, no viene del LLM

    # Verificar si ya existe (upsert manual)
    existing = await db.fetchrow(
        "SELECT id, name FROM customers WHERE phone_number = $1", phone
    )
    if existing:
        if existing["name"] != name:
            await db.execute(
                "UPDATE customers SET name = $1 WHERE phone_number = $2", name, phone
            )
        return json.dumps({"id": str(existing["id"]), "name": name})

    # Cliente nuevo: insertar y devolver el registro creado
    row = await db.fetchrow(
        "INSERT INTO customers (phone_number, name) VALUES ($1, $2) RETURNING id, name",
        phone, name,
    )
    return json.dumps({"id": str(row["id"]), "name": row["name"]})


@function_tool
async def get_customer(ctx: RunContextWrapper[AgentContext]) -> str:
    """
    Obtiene el perfil del cliente actual. Útil para verificar si ya está registrado
    y obtener su nombre para personalizar la conversación.
    """
    phone = ctx.context.phone
    row = await db.fetchrow(
        "SELECT id, name, created_at FROM customers WHERE phone_number = $1", phone
    )
    if not row:
        return "Cliente no encontrado. Debe registrarse primero."
    return json.dumps(dict(row), default=str)


# ──────────────────────────────────────────────────────────────────────────────
# PEDIDOS
# ──────────────────────────────────────────────────────────────────────────────

@function_tool
async def create_order(
    ctx: RunContextWrapper[AgentContext],
    product_id: str,
    quantity: int,
    payment_method: str = "contra_entrega",
    notes: str = "",
) -> str:
    """
    Crea un pedido para el cliente actual. Valida que el cliente exista
    y que haya suficiente stock antes de confirmar. Descuenta el stock automáticamente.
    payment_method debe ser uno de: 'contra_entrega', 'nequi', 'bre_b'.
    """
    phone = ctx.context.phone

    # Verificar que el cliente esté registrado antes de crear el pedido
    customer = await db.fetchrow(
        "SELECT id FROM customers WHERE phone_number = $1", phone
    )
    if not customer:
        return "El cliente no está registrado. Pedir que se registre primero."

    # Verificar que el producto existe, está activo y tiene suficiente stock
    product = await db.fetchrow(
        "SELECT id, name, price, stock FROM products WHERE id = $1 AND is_active = TRUE",
        product_id,
    )
    if not product:
        return "Producto no encontrado o no disponible."
    if product["stock"] < quantity:
        return f"Stock insuficiente. Solo quedan {product['stock']} unidades."

    # Calcular el precio total al momento del pedido
    # (importante guardarlo: si el precio cambia después, el pedido ya tiene el precio original)
    total = float(product["price"]) * quantity

    # Insertar el pedido y obtener el registro creado en una sola operación
    order = await db.fetchrow(
        """
        INSERT INTO orders (customer_id, product_id, quantity, total_price, payment_method, notes)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, order_number, status, total_price, payment_method, created_at
        """,
        customer["id"], product_id, quantity, total, payment_method, notes,
    )

    # Descontar el stock inmediatamente al crear el pedido
    await db.execute(
        "UPDATE products SET stock = stock - $1 WHERE id = $2",
        quantity, product_id,
    )

    return json.dumps({
        "order_id": str(order["id"]),
        "order_number": order["order_number"],
        "product": product["name"],
        "quantity": quantity,
        "total": float(order["total_price"]),
        "status": order["status"],
        "payment_method": order["payment_method"],
    }, default=str)


@function_tool
async def get_my_orders(ctx: RunContextWrapper[AgentContext]) -> str:
    """
    Lista los últimos 10 pedidos del cliente actual, con nombre de producto,
    cantidad, total, estado y fecha. El agente lo llama cuando el usuario
    pregunta por el estado de sus compras.
    """
    phone = ctx.context.phone
    rows = await db.fetch(
        """
        SELECT o.id, p.name AS product, o.quantity, o.total_price, o.status, o.created_at
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        JOIN products p ON p.id = o.product_id
        WHERE c.phone_number = $1
        ORDER BY o.created_at DESC
        LIMIT 10
        """,
        phone,
    )
    if not rows:
        return "No tienes pedidos registrados aún."
    return json.dumps([dict(r) for r in rows], default=str)


@function_tool
async def save_shipping_info(
    ctx: RunContextWrapper[AgentContext],
    order_id: str,
    full_name: str,
    cedula: str,
    phone: str,
    city: str,
    neighborhood: str,
    address: str,
    address_details: str = "",
) -> str:
    """
    Guarda los datos de envío de un pedido. Llamar justo después de create_order,
    una vez que el cliente haya proporcionado todos sus datos de entrega.
    Extrae los campos del bloque de datos que el cliente envió.
    """
    await db.execute(
        """
        INSERT INTO shipping_info
            (order_id, full_name, cedula, phone, city, neighborhood, address, address_details)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        """,
        order_id, full_name, cedula, phone, city, neighborhood, address, address_details,
    )
    return json.dumps({
        "status": "ok",
        "message": f"Datos de envío guardados para el pedido {order_id}.",
    })


@function_tool
async def handoff_to_human(ctx: RunContextWrapper[AgentContext]) -> str:
    """
    Pausa el agente para este cliente y transfiere la conversación a un asesor humano.
    Llamar SIEMPRE justo después de confirmar el pedido al cliente (paso final del cierre).
    Después de esta llamada el agente deja de responder y un humano toma el control.
    """
    import os
    import httpx
    import session as _session

    import logging
    log = logging.getLogger("handoff_to_human")

    phone = ctx.context.phone
    log.info(f"Iniciando para phone={phone}")

    # Obtener cliente con su número secuencial
    customer = await db.fetchrow(
        "SELECT name, customer_number FROM customers WHERE phone_number = $1", phone
    )
    log.info(f"customer={dict(customer) if customer else None}")

    # Obtener el último pedido con datos de envío y número secuencial
    order = await db.fetchrow(
        """
        SELECT o.order_number, p.name AS product, o.quantity, o.total_price, o.payment_method,
               s.full_name, s.cedula, s.phone AS customer_phone,
               s.city, s.neighborhood, s.address, s.address_details
        FROM orders o
        JOIN products p  ON p.id = o.product_id
        JOIN customers c ON c.id = o.customer_id
        LEFT JOIN shipping_info s ON s.order_id = o.id
        WHERE c.phone_number = $1
        ORDER BY o.created_at DESC
        LIMIT 1
        """,
        phone,
    )
    log.info(f"order encontrado={order is not None}")

    # Construir el mensaje de alerta para los asesores
    customer_label = f"Cliente #{customer['customer_number']}" if customer and customer.get("customer_number") else "Cliente"
    customer_name = customer["name"] if customer and customer["name"] else phone
    lines = [
        "🔔 *Nuevo pedido*",
        f"👤 {customer_label} — {customer_name}",
        f"📱 {phone}",
    ]

    if order:
        payment_labels = {"contra_entrega": "Contra entrega", "nequi": "Nequi", "bre_b": "Bre-B"}
        payment = payment_labels.get(order["payment_method"], order["payment_method"])
        lines.append(f"\n📦 Pedido #{order['order_number']} — *{order['product']}* x{order['quantity']}")
        lines.append(f"💰 ${order['total_price']} — {payment}")
        if order["full_name"]:
            lines += [
                "\n📝 *Datos de envío:*",
                f"  Nombre: {order['full_name']}",
                f"  Cédula: {order['cedula']}",
                f"  Teléfono: {order['customer_phone']}",
                f"  Ciudad: {order['city']}, {order['neighborhood']}",
                f"  Dirección: {order['address']}",
            ]
            if order["address_details"]:
                lines.append(f"  Detalle: {order['address_details']}")

    alert_message = "\n".join(lines)

    # Pausar el agente antes de notificar
    await _session.pause(phone)
    log.info(f"Sesión pausada para phone={phone}")

    # Notificar a WhatsappPort para que envíe el mensaje a los asesores
    # Si la notificación falla, la sesión igual queda pausada (el silencio es seguro)
    whatsapp_port_url = os.getenv("WHATSAPP_PORT_URL", "http://localhost:3000")
    log.info(f"Enviando alerta a {whatsapp_port_url}/alert")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(f"{whatsapp_port_url}/alert", json={"message": alert_message})
            log.info(f"Respuesta de WhatsappPort: status={response.status_code} body={response.text}")
    except Exception as e:
        log.error(f"⚠️ No se pudo enviar alerta WPP: {type(e).__name__}: {e}")

    return "Sesión pausada. El asesor humano tomará el control."


@function_tool
async def cancel_order(ctx: RunContextWrapper[AgentContext], order_id: str) -> str:
    """
    Cancela un pedido pendiente del cliente. Solo funciona si el estado es 'pending'
    (no se puede cancelar algo que ya fue enviado). Repone el stock al cancelar.
    """
    phone = ctx.context.phone

    # Buscar el pedido verificando que pertenezca a este cliente (seguridad)
    order = await db.fetchrow(
        """
        SELECT o.id, o.status, o.product_id, o.quantity
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1 AND c.phone_number = $2
        """,
        order_id, phone,
    )
    if not order:
        return "Pedido no encontrado o no pertenece a este cliente."
    if order["status"] != "pending":
        return f"No se puede cancelar. El pedido ya está en estado '{order['status']}'."

    # Cancelar el pedido y reponer el stock en dos operaciones
    await db.execute(
        "UPDATE orders SET status = 'cancelled' WHERE id = $1", order_id
    )
    await db.execute(
        "UPDATE products SET stock = stock + $1 WHERE id = $2",
        order["quantity"], order["product_id"],
    )
    return "Pedido cancelado exitosamente. ✅"
