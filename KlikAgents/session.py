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
  TTL:    86400 segundos (24 horas) — la ventana activa de WhatsApp Business.
          Cada nuevo mensaje renueva el TTL automáticamente.

¿Por qué 24 horas?
  WhatsApp solo permite enviar mensajes a usuarios que te hayan escrito
  en las últimas 24 horas. Alinear el TTL del historial con esa ventana
  tiene sentido: si la conversación expiró en WPP, el contexto tampoco es útil.
"""

import os
import json
import redis.asyncio as redis

# Cliente Redis. Se instancia una sola vez (patrón singleton) para reutilizar
# la conexión entre requests.
_client: redis.Redis | None = None

SESSION_TTL = 60 * 60 * 24  # 24 horas en segundos


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
