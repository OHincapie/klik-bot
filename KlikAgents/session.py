"""
session.py — Historial de conversación en Redis

¿Por qué Redis y no la memoria de Python?
  Cada request al agente es stateless: el agente no recuerda mensajes anteriores
  a menos que se los pasemos explícitamente. Redis actúa como la "memoria de corto
  plazo" del bot, persistiendo el historial entre mensajes.

Estructura en Redis:
  Clave:  "session:{phone}"      ej: "session:573001234567"
  Valor:  JSON de lista de mensajes en formato OpenAI:
          [
            {"role": "user",      "content": "Hola"},
            {"role": "assistant", "content": "¡Hola! Soy KlikBot..."},
            ...
          ]
  TTL:    7 días — cubre follow-ups y clientes que regresan en la semana.
          Cada nuevo mensaje renueva el TTL automáticamente.
          Para sesiones más largas, el contexto se reconstruye desde PostgreSQL
          (ver build_returning_customer_context en agent.py).
"""

import os
import json
import redis.asyncio as redis

# Cliente Redis. Se instancia una sola vez (patrón singleton) para reutilizar
# la conexión entre requests.
_client: redis.Redis | None = None

SESSION_TTL = 60 * 60 * 24 * 20  # 20 días — cubre follow-ups y clientes que regresan en la semana


def _get_client() -> redis.Redis:
    """
    Devuelve el cliente Redis (lo crea si no existe aún).
    redis.from_url() acepta la URL de Upstash directamente:
      rediss://default:PASSWORD@HOST:PORT
    El prefijo 'rediss://' (con doble s) indica TLS, requerido por Upstash.
    """
    global _client
    if _client is None:
        _client = redis.from_url(
            os.getenv("REDIS_URL"),
            decode_responses=True,
            ssl_cert_reqs=None,  # Fix SSL cert en macOS con Python 3.14
        )
    return _client


async def get_history(phone: str) -> list[dict]:
    """
    Devuelve el historial de mensajes de un número de teléfono.
    Si el usuario es nuevo o la sesión expiró, devuelve lista vacía.
    El agente usará esta lista para tener contexto de la conversación.
    """
    data = await _get_client().get(f"session:{phone}")
    return json.loads(data) if data else []


async def save_history(phone: str, messages: list[dict]) -> None:
    """
    Guarda el historial actualizado y renueva el TTL.
    setex() = SET + EXPIRE en una sola operación atómica.
    Guardamos solo mensajes de usuario y asistente (sin tool calls),
    para mantener el historial limpio y legible.
    """
    await _get_client().setex(
        f"session:{phone}",
        SESSION_TTL,
        json.dumps(messages),
    )


async def clear_history(phone: str) -> None:
    """Elimina el historial de un número. Útil para testear o resetear conversaciones."""
    await _get_client().delete(f"session:{phone}")


async def save_recovery(lid: str, messages: list[dict]) -> None:
    """Guarda mensajes históricos indexados por LID (ID de Baileys) con TTL de 24h.
    Se usa cuando WhatsApp manda historial con LIDs en vez de números reales."""
    await _get_client().setex(f"recovery:{lid}", SESSION_TTL, json.dumps(messages))


async def claim_recovery(lid: str) -> list[dict] | None:
    """Busca y elimina en una sola operación el historial guardado bajo un LID.
    Retorna los mensajes si existían, None si no hay nada que recuperar."""
    data = await _get_client().getdel(f"recovery:{lid}")
    return json.loads(data) if data else None


PAUSE_TTL = 60 * 60 * 24  # 24 horas — si nadie despausa, el bot retoma automáticamente

async def pause(phone: str) -> None:
    """Pausa el agente para este número. El bot deja de responder y un humano toma el control.
    Expira automáticamente en 24h para evitar que la sesión quede pausada para siempre."""
    await _get_client().setex(f"session:{phone}:paused", PAUSE_TTL, "1")


async def unpause(phone: str) -> None:
    """Reactiva el agente para este número."""
    await _get_client().delete(f"session:{phone}:paused")


async def is_paused(phone: str) -> bool:
    """Retorna True si la sesión está pausada (un humano está atendiendo)."""
    return await _get_client().exists(f"session:{phone}:paused") == 1


async def append_human_message(phone: str, text: str) -> None:
    """Agrega un mensaje del asesor humano al historial de Redis como rol 'assistant'.
    Permite que el agente tenga contexto de lo que el humano le dijo al cliente
    cuando retome la conversación tras el unpause."""
    history = await get_history(phone)
    history.append({"role": "assistant", "content": text})
    await save_history(phone, history)
