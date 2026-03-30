"""
main.py — Punto de entrada de KlikAgents

FastAPI expone un único endpoint POST /chat que recibe mensajes de WhatsappPort
y devuelve la respuesta del agente.

Flujo completo:
  WhatsappPort (Node.js)
    → POST /chat { phone, message }
    → agent.run(phone, message)       ← toda la lógica está aquí
    → respuesta de texto
    ← { reply: "..." }
  WhatsappPort (Node.js)
    → sock.sendMessage(...)
"""

from contextlib import asynccontextmanager
from dotenv import load_dotenv
import logging

# load_dotenv() debe llamarse ANTES de importar cualquier módulo que use os.getenv(),
# porque esos módulos leen las variables en el momento de importación.
load_dotenv()

logging.basicConfig(level=logging.INFO)

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import db
import agent
import session


# lifespan es el mecanismo de FastAPI para ejecutar código al arrancar y al apagar.
# Lo usamos para abrir el pool de conexiones a Supabase al iniciar,
# y cerrarlo limpiamente al apagar (sin lifespan, las conexiones quedarían abiertas).
@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init()   # Abre el pool de conexiones PostgreSQL
    yield             # El servidor corre aquí (entre yield y el bloque de abajo)
    await db.close()  # Cierra el pool al apagar


app = FastAPI(title="KlikAgents", lifespan=lifespan)


# Pydantic valida automáticamente que el JSON entrante tenga estos campos y tipos.
# Si falta algún campo, FastAPI devuelve un 422 automáticamente.
class ChatRequest(BaseModel):
    phone: str    # Número de teléfono del usuario (ej: "573001234567")
    message: str  # Texto del mensaje enviado por el usuario


class ChatResponse(BaseModel):
    reply: str    # Texto de respuesta que WhatsappPort enviará al usuario


class RestoreRequest(BaseModel):
    history: list[dict]  # [{role: "user"|"assistant", content: "..."}]
    lid: str | None = None  # Si se pasa, intenta mergear con recovery:{lid} de Redis


class RecoveryRequest(BaseModel):
    messages: list[dict]  # [{role: "user"|"assistant", content: "..."}]


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    """
    Endpoint principal. Recibe un mensaje y devuelve la respuesta del agente.
    Si la sesión está pausada, el bot no responde (un asesor humano tiene el control).
    """
    if not req.phone or not req.message:
        raise HTTPException(status_code=400, detail="phone y message son requeridos")

    if await session.is_paused(req.phone):
        return ChatResponse(reply="")   # Silencio total — el humano está atendiendo

    reply = await agent.run(req.phone, req.message)
    return ChatResponse(reply=reply)


@app.get("/session/{phone}/status")
async def session_status(phone: str):
    """Devuelve si la sesión está pausada o activa. Usado por el dashboard."""
    paused = await session.is_paused(phone)
    return {"phone": phone, "status": "paused" if paused else "active"}


@app.post("/session/{phone}/pause")
async def pause_session(phone: str):
    """Pausa el agente para este número. Llámalo cuando un humano toma el control."""
    await session.pause(phone)
    return {"status": "paused", "phone": phone}


@app.post("/session/{phone}/unpause")
async def unpause_session(phone: str):
    """Reactiva el agente para este número cuando el humano termina de atender."""
    await session.unpause(phone)
    return {"status": "active", "phone": phone}


@app.post("/recovery/{lid}")
async def save_recovery(lid: str, req: RecoveryRequest):
    """Guarda historial indexado por LID de Baileys. Lo llama WhatsappPort tras messaging-history.set."""
    if not req.messages:
        raise HTTPException(status_code=400, detail="messages no puede estar vacío")
    await session.save_recovery(lid, req.messages)
    return {"status": "saved", "lid": lid, "messages": len(req.messages)}


@app.post("/session/{phone}/restore")
async def restore_session(phone: str, req: RestoreRequest):
    """Restaura conversación tras una caída: registra cliente en Supabase y guarda historial en Redis."""
    history = req.history

    # Si viene un LID, intentar recuperar el historial guardado y mergearlo
    if req.lid:
        recovered = await session.claim_recovery(req.lid)
        if recovered:
            history = recovered + history  # histórico primero, luego mensajes nuevos

    if not history:
        raise HTTPException(status_code=400, detail="history no puede estar vacío")

    await session.save_history(phone, history)
    return {"status": "restored", "phone": phone, "messages": len(history)}


@app.post("/session/{phone}/human-message")
async def human_message(phone: str, req: ChatRequest):
    """Guarda un mensaje enviado por el asesor humano en el historial de Redis.
    Lo llama WhatsappPort cuando detecta un mensaje saliente (fromMe) del asesor al cliente."""
    await session.append_human_message(phone, req.message)
    return {"status": "saved", "phone": phone}


@app.get("/health")
async def health():
    """Endpoint simple para verificar que el servicio está vivo."""
    return {"status": "ok"}
