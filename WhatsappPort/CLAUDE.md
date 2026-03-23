# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Instalar dependencias
node index.js        # Arrancar el bot (muestra QR en primer arranque)
npm start            # Equivalente a node index.js
```

No hay build step, linter, ni tests configurados.

## Architecture

Este servicio es un **puente puro**: no contiene lógica de negocio. Su único trabajo es:
1. Mantener la sesión de WhatsApp via Baileys
2. Recibir mensajes entrantes
3. Hacer `POST /chat` al microservicio KlikAgents (Python)
4. Reenviar la respuesta al usuario por WhatsApp

```
WhatsApp ↔ Baileys (index.js) ──HTTP──▶ KlikAgents (FastAPI, puerto 8000)
```

Toda la inteligencia del bot vive en KlikAgents. Si se cambia el agente, modelo o lógica, este servicio no se toca.

## Sesión de WhatsApp

Baileys guarda las credenciales en `auth_info_baileys/` (no commitear). Al primer arranque genera un QR en la terminal para escanear con WhatsApp. Reconexión automática ante caídas de red via llamada recursiva en el evento `connection.update`, excepto cuando `DisconnectReason.loggedOut` (cierre manual de sesión).

## Filtros de mensajes

Solo se procesan mensajes que cumplan:
- `msg.key.fromMe === false` — ignorar mensajes propios del bot
- `m.type === 'notify'` — ignorar mensajes históricos al reconectar
- El texto existe en `conversation` o `extendedTextMessage.text` — ignorar multimedia/stickers

## Variable de entorno

| Variable    | Default                   | Descripción                   |
|-------------|---------------------------|-------------------------------|
| `AGENT_URL` | `http://localhost:8000`   | URL base del servicio Python  |
