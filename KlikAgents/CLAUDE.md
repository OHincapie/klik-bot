# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pip install -r requirements.txt   # Instalar dependencias
uvicorn main:app --reload          # Arrancar en modo desarrollo (recarga automática)
uvicorn main:app                   # Arrancar en producción
```

API docs interactivos disponibles en `http://localhost:8000/docs` una vez corriendo.
Health check: `GET http://localhost:8000/health`

No hay linter, formatter, ni tests configurados.

## Architecture

Microservicio Python que recibe mensajes de WhatsappPort (Node.js) vía HTTP y devuelve la respuesta del agente de IA.

```
POST /chat {phone, message}
  → agent.run(phone, message)
      → session.get_history(phone)     ← Redis: historial previo
      → Runner.run(agent, messages)    ← OpenAI Agents SDK: loop ReAct automático
          → tools.py (si el LLM las solicita)
              → db.py → Supabase
      → session.save_history(phone)    ← Redis: guardar turno nuevo
  ← { reply }
```

## Módulos y sus responsabilidades

| Archivo | Responsabilidad |
|---|---|
| `main.py` | FastAPI app. Único endpoint `POST /chat`. Gestiona el ciclo de vida del pool DB via `lifespan`. |
| `agent.py` | Instancia el `Agent` (una vez, al importar). `run()` orquesta historial + SDK + persistencia. |
| `tools.py` | Todas las tools del agente. Cada `@function_tool` es una acción DB que GPT-4o puede invocar. |
| `prompt.py` | System prompt. **Es la pieza más importante para el comportamiento del bot.** Editar aquí para cambiar personalidad, flujo de atención o instrucciones de negocio. |
| `db.py` | Pool asyncpg (Supabase). Tres funciones: `fetch`, `fetchrow`, `execute`. SQL con parámetros `$1, $2...`. |
| `session.py` | Historial por número en Redis. Clave `session:{phone}`, TTL 24h, formato lista de mensajes OpenAI. |

## Decisiones de diseño importantes

**`load_dotenv()` va antes de todos los imports** en `main.py` — los módulos leen `os.getenv()` al importarse, por lo que si se llama después ya es tarde.

**`AgentContext` inyecta el teléfono en las tools** — el LLM nunca ve ni pasa el número de teléfono. El SDK lo inyecta automáticamente cuando el primer parámetro de una tool está anotado como `RunContextWrapper[AgentContext]`.

**El historial en Redis solo guarda pares user/assistant** — los tool calls intermedios del loop ReAct no se persisten. Esto mantiene el contexto limpio y reduce tamaño en Redis.

**El stock se descuenta al crear el pedido** — no al confirmar. Si se cancela, `cancel_order` lo repone. Solo se pueden cancelar pedidos en estado `pending`.

**`total_price` se guarda en el pedido** — aunque el precio del producto cambie después, el pedido conserva el precio original al momento de la compra.

## Para agregar una nueva tool

1. Definir la función en `tools.py` con `@function_tool` y docstring claro (el LLM usa el docstring para decidir cuándo llamarla).
2. Importarla en `agent.py` y agregarla a la lista `tools=[]` del `Agent`.
3. Si la tool necesita el teléfono del usuario, agregar `ctx: RunContextWrapper[AgentContext]` como primer parámetro.

## Variables de entorno

| Variable              | Descripción                                                          |
|-----------------------|----------------------------------------------------------------------|
| `OPENAI_API_KEY`      | Clave de OpenAI                                                      |
| `SUPABASE_DB_URL`     | PostgreSQL connection string con SSL requerido                       |
| `REDIS_URL`           | URL Upstash (`rediss://` con doble s = TLS)                          |
| `WHATSAPP_PORT_URL`   | URL de WhatsappPort para enviar alertas (default: `http://localhost:3000`) |

## Endpoints adicionales

| Método | Ruta                        | Descripción                                                      |
|--------|-----------------------------|------------------------------------------------------------------|
| POST   | `/session/{phone}/pause`    | Pausa el agente para ese número; el bot retorna `""` (silencio)  |
| POST   | `/session/{phone}/unpause`  | Reactiva el agente tras la atención humana                       |

Para resetear el historial de un número durante desarrollo, llamar `session.clear_history(phone)` directamente.

## Setup inicial (una sola vez)

1. Correr `schema.sql` en Supabase → SQL Editor
2. Crear base de datos en [upstash.com](https://upstash.com) y copiar `REDIS_URL`
3. Completar los `[TODO]` en `prompt.py` con nombre de tienda y descripción del producto
4. Descomentar y editar el `INSERT` al final de `schema.sql` para agregar el primer producto
