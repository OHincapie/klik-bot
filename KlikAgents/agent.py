"""
agent.py — Inicialización del agente y manejo del loop de conversación

¿Qué hace el OpenAI Agents SDK por nosotros?
  En TrazzaJS teníamos un loop manual de hasta 20 iteraciones donde:
    1. Llamábamos a GPT-4o
    2. Revisábamos si quería llamar una tool
    3. Ejecutábamos la tool
    4. Volvíamos a llamar a GPT-4o con el resultado
    5. Repetíamos hasta que GPT respondía sin tools

  El SDK hace exactamente eso internamente con Runner.run().
  Nosotros solo definimos el agente y sus tools, y llamamos Runner.run().

Contexto de conversación:
  El agente es stateless por naturaleza: no recuerda mensajes anteriores.
  Para darle memoria, recuperamos el historial de Redis y se lo pasamos
  como parte del input junto con el mensaje nuevo del usuario.
"""

from agents import Agent, Runner
from prompt import SYSTEM_PROMPT
from tools import (
    AgentContext,
    list_products,
    register_customer,
    get_customer,
    create_order,
    save_shipping_info,
    handoff_to_human,
    get_my_orders,
    cancel_order,
    update_lead_status,
)
import session
import db

# Instancia del agente. Se crea una vez al importar el módulo y se reutiliza.
# Agent() no abre conexiones ni hace llamadas — solo define la configuración.
_agent = Agent(
    name="KlikBot",
    instructions=SYSTEM_PROMPT,  # El "rol" del agente: qué es, cómo actúa, qué puede hacer
    tools=[                       # Lista de funciones que el agente puede llamar
        list_products,
        register_customer,
        get_customer,
        create_order,
        save_shipping_info,
        handoff_to_human,
        get_my_orders,
        cancel_order,
        update_lead_status,
    ],
    model="gpt-5-mini",
)


async def build_returning_customer_context(phone: str) -> str | None:
    """
    Construye un bloque de contexto para clientes que regresan después de que
    su sesión de Redis expiró (más de 7 días sin escribir).

    Este contexto se inyecta como el primer par de mensajes del historial para
    que el agente sepa con quién está hablando sin tener que preguntar de nuevo.
    No se guarda en Redis — es efímero y solo existe en la llamada actual.

    Retorna None si el cliente es completamente nuevo (sin registro en DB).
    """
    customer = await db.fetchrow(
        """
        SELECT id, name, lead_status, lead_notes
        FROM customers
        WHERE phone_number = $1
        """,
        phone,
    )

    # Si no existe en la DB es un cliente nuevo — sin contexto que inyectar
    if not customer or not customer["name"]:
        return None

    orders = await db.fetch(
        """
        SELECT p.name AS product, o.quantity, o.total_price, o.status,
               o.created_at, o.payment_method
        FROM orders o
        JOIN products p ON p.id = o.product_id
        WHERE o.customer_id = $1
        ORDER BY o.created_at DESC
        LIMIT 5
        """,
        customer["id"],
    )

    parts = [
        "=== CONTEXTO DEL CLIENTE (interno — el cliente NO ve esto) ===",
        f"Nombre registrado: {customer['name']}",
        f"Estado previo del lead: {customer['lead_status']}",
    ]

    if customer["lead_notes"]:
        parts.append(f"Notas del asesor: {customer['lead_notes']}")

    if orders:
        payment_labels = {
            "contra_entrega": "contra entrega",
            "nequi": "Nequi",
            "bre_b": "Bre-B",
        }
        parts.append("Compras anteriores:")
        for o in orders:
            date_str = o["created_at"].strftime("%d/%m/%Y") if o["created_at"] else "?"
            payment = payment_labels.get(o["payment_method"], o["payment_method"])
            parts.append(
                f"  • {o['product']} x{o['quantity']} — ${float(o['total_price']):.0f}"
                f" ({payment}) — {o['status']} — {date_str}"
            )
    else:
        parts.append("Compras anteriores: ninguna")

    parts.append("=== FIN CONTEXTO ===")
    return "\n".join(parts)


async def run(phone: str, message: str) -> str:
    """
    Ejecuta el agente para un mensaje entrante y devuelve su respuesta.

    Flujo:
      1. Recuperar historial de Redis (puede ser lista vacía si es nuevo usuario)
      2. Construir el input: historial + mensaje nuevo
      3. Runner.run() ejecuta el loop del agente (tool calls, razonamiento, respuesta)
      4. Guardar en Redis: historial + mensaje nuevo + respuesta del agente
      5. Devolver la respuesta de texto

    Args:
        phone:   Número de teléfono del usuario (ej: "573001234567")
        message: Texto del mensaje enviado por el usuario

    Returns:
        Texto de respuesta del agente para enviar por WhatsApp
    """
    # 1. Recuperar historial previo de esta conversación
    history = await session.get_history(phone)

    # 2. Si la sesión es nueva (Redis vacío o expirado), inyectar contexto del cliente
    #    desde PostgreSQL para que el agente no empiece de cero con clientes que regresan.
    #    Este bloque NO se guarda en Redis — solo existe en esta llamada.
    context_prefix: list[dict] = []
    if not history:
        ctx = await build_returning_customer_context(phone)
        if ctx:
            context_prefix = [
                {"role": "user", "content": ctx},
                {"role": "assistant", "content": "Contexto cargado. Atiendo al cliente."},
            ]

    # 3. Construir el input: contexto (si aplica) + historial + mensaje nuevo
    input_messages = context_prefix + history + [{"role": "user", "content": message}]

    # 4. Runner.run() ejecuta el loop completo:
    #    - Llama a GPT-4o con el system prompt + historial + mensaje
    #    - Si GPT decide llamar una tool, el SDK la ejecuta automáticamente
    #    - Repite hasta que GPT responde sin tools
    #    context=AgentContext(phone=phone) inyecta el número en todas las tools
    #    que lo necesiten (sin que el LLM tenga que pasarlo explícitamente)
    result = await Runner.run(
        _agent,
        input_messages,
        context=AgentContext(phone=phone),
        max_turns=10,
    )

    reply = result.final_output  # El texto final que el agente decidió enviar

    # 5. Guardar en Redis solo los mensajes de usuario y asistente.
    #    NO guardamos los tool calls (son artefactos internos del loop, no relevantes
    #    para el contexto de la conversación desde el punto de vista del usuario).
    updated_history = history + [
        {"role": "user", "content": message},
        {"role": "assistant", "content": reply},
    ]
    await session.save_history(phone, updated_history)

    return reply
