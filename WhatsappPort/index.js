require('dotenv').config();

const {
    makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,   // Descarga el contenido binario de un mensaje multimedia
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const { OpenAI, toFile } = require('openai');
const { MongoClient } = require('mongodb');
const { useMongoAuthState } = require('./mongo-auth-state');

const http = require('http');
const path = require('path');
const fs   = require('fs');

// Imágenes del producto almacenadas en images/
// La etiqueta [IMAGEN_PRODUCTO] en el reply activa el envío automático.
const PRODUCT_IMAGES = [
    path.join(__dirname, 'images', 'shilajit1.jpg'),
];

const AGENT_URL   = process.env.AGENT_URL   || 'http://127.0.0.1:8000';
const API_PORT    = process.env.PORT || process.env.API_PORT || 3000;

// Controla si el historial de WhatsApp se persiste automáticamente en Redis
// al recibir messaging-history.set. Por defecto false — activar solo en recovery.
// Para activar: RECOVERY_AUTO_PERSIST=true en .env o al arrancar el proceso.
const RECOVERY_AUTO_PERSIST = process.env.RECOVERY_AUTO_PERSIST === 'true';

// Números que recibirán la alerta cuando un pedido quede pendiente de atención.
// Formato: "573001234567,573009876543" (sin espacios, con código de país, sin +)
const NOTIFY_PHONES = (process.env.NOTIFY_PHONES || '').split(',').filter(Boolean);

// Referencia global al socket de Baileys.
// Se asigna una vez que la conexión con WhatsApp está abierta,
// y la usa el servidor HTTP interno para enviar mensajes de alerta.
let sock = null;

// ── Debouncing de mensajes ───────────────────────────────────────────────────
// Si un usuario manda varios mensajes seguidos antes de que el bot responda,
// los acumulamos y los enviamos juntos como un solo mensaje al agente.
// Esto evita respuestas múltiples y mantiene el historial limpio.
const pendingMessages = new Map(); // phone → { timer, messages[], sendJid }
const DEBOUNCE_MS = 2500; // 3 segundos — cubre la mayoría de los casos en WhatsApp

// ── Cache de historial para recuperación tras caídas ─────────────────────────
// Se puebla via messaging-history.set al reconectar con syncFullHistory: true.
// Clave: phone — Valor: [{ fromMe, text, timestamp }]
const messageCache = new Map();

// Mapa LID → phone real. WhatsApp usa LIDs para ocultar números en el protocolo.
// lid-mapping.update provee la traducción cuando Baileys la recibe del servidor.
const lidToPhone = new Map();

// ── Servidor HTTP interno ────────────────────────────────────────────────────
// Expone POST /alert para que KlikAgents pueda disparar notificaciones WPP
// sin necesidad de mantener su propia conexión a WhatsApp.
const apiServer = http.createServer(async (req, res) => {
    // GET /cache → resumen de cuántos números y mensajes hay en cache
    // GET /cache/:phone → mensajes de un número específico
    if (req.method === 'GET' && req.url.startsWith('/cache')) {
        const phone = req.url.split('/cache/')[1];
        if (phone) {
            const msgs = (messageCache.get(phone) || []).sort((a, b) => a.timestamp - b.timestamp);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ phone, count: msgs.length, messages: msgs }));
        } else {
            const summary = {};
            for (const [p, msgs] of messageCache) summary[p] = msgs.length;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ total_phones: messageCache.size, phones: summary }));
        }
        return;
    }

    // POST /recover → toma los números del cache y restaura en KlikAgents
    if (req.method === 'POST' && req.url === '/recover') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { phones, count = 50 } = JSON.parse(body);
                if (!Array.isArray(phones) || phones.length === 0) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'phones debe ser un array no vacío' }));
                    return;
                }

                const results = [];
                for (const phone of phones) {
                    const msgs = (messageCache.get(phone) || [])
                        .sort((a, b) => a.timestamp - b.timestamp)
                        .slice(-count);

                    if (msgs.length === 0) {
                        results.push({ phone, status: 'no_messages' });
                        continue;
                    }

                    const history = msgs.map(m => ({
                        role: m.fromMe ? 'assistant' : 'user',
                        content: m.text,
                    }));

                    const agentRes = await fetch(`${AGENT_URL}/recovery/${phone}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ messages: history }),
                    });

                    if (!agentRes.ok) {
                        results.push({ phone, status: 'error', detail: await agentRes.text() });
                    } else {
                        results.push({ phone, status: 'saved', messages: history.length });
                        console.log(`💾 Recovery guardado para LID [${phone}] — ${history.length} mensajes`);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ results }));
            } catch (err) {
                console.error('Error en /recover:', err.message);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    if (req.method !== 'POST' || req.url !== '/alert') {
        res.writeHead(404);
        res.end();
        return;
    }

    console.log('[/alert] POST recibido');
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        try {
            const { message } = JSON.parse(body);
            console.log(`[/alert] NOTIFY_PHONES configurados: ${NOTIFY_PHONES.length} → [${NOTIFY_PHONES.join(', ')}]`);
            console.log(`[/alert] sock conectado: ${!!sock}`);

            if (!sock) {
                console.error('[/alert] ⚠️ WhatsApp no conectado — alerta descartada');
                res.writeHead(503);
                res.end(JSON.stringify({ error: 'WhatsApp no conectado aún' }));
                return;
            }

            if (NOTIFY_PHONES.length === 0) {
                console.error('[/alert] ⚠️ NOTIFY_PHONES vacío — no hay destinatarios');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'no_recipients', recipients: 0 }));
                return;
            }

            // Enviar el mensaje a cada número configurado en NOTIFY_PHONES
            // Resolvemos el JID real (puede ser LID) para evitar que respuestas
            // del asesor lleguen con LID y Baileys las descarte silenciosamente
            for (const phone of NOTIFY_PHONES) {
                const [result] = await sock.onWhatsApp(phone).catch(() => [null]);
                const jid = result?.jid || `${phone}@s.whatsapp.net`;
                await sock.sendMessage(jid, { text: message });
                console.log(`🔔 Alerta enviada a [${phone}] jid=${jid}`);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'sent', recipients: NOTIFY_PHONES.length }));
        } catch (err) {
            console.error('[/alert] Error:', err.message);
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
        }
    });
});

apiServer.listen(API_PORT, () => {
    console.log(`📡 API interna escuchando en puerto ${API_PORT}`);
});

// Cliente de OpenAI — usado exclusivamente para transcribir audios con Whisper
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Transcribe un mensaje de audio de WhatsApp usando Whisper.
 *
 * Flujo:
 *   1. Baileys descarga el audio como Buffer (bytes en memoria, sin guardar en disco)
 *   2. toFile() convierte el Buffer al formato que espera la API de OpenAI
 *   3. Whisper transcribe y devuelve el texto
 *
 * WhatsApp envía los audios en formato OGG con codec Opus.
 * Whisper soporta OGG nativamente y entiende español perfectamente.
 */
async function transcribeAudio(msg) {
    // downloadMediaMessage descarga el binario del audio directamente en memoria
    // como un Buffer de Node.js (equivalente a bytes[] en otros lenguajes)
    const buffer = await downloadMediaMessage(msg, 'buffer', {});

    // toFile() envuelve el Buffer con el nombre y tipo MIME que Whisper necesita
    // para identificar el formato del audio
    const file = await toFile(buffer, 'audio.ogg', { type: 'audio/ogg' });

    const transcription = await openai.audio.transcriptions.create({
        file,
        model: 'whisper-1',
        language: 'es',
        // El prompt ancla a Whisper al dominio correcto y elimina alucinaciones
        // en audios cortos. Whisper lo usa como "contexto previo" de la conversación.
        // Actualizar este texto con el nombre real del negocio y producto.
        prompt: 'Consulta de cliente a una tienda por WhatsApp sobre productos, precios, envíos y pedidos.',
    });

    return transcription.text;
}

/**
 * Envía el mensaje (texto ya procesado) a KlikAgents y devuelve la respuesta.
 * Este contrato no cambia independientemente de si el origen fue texto o audio.
 */
async function callAgent(phone, message) {
    const res = await fetch(`${AGENT_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, message }),
    });

    if (!res.ok) {
        throw new Error(`KlikAgents respondió con status ${res.status}`);
    }

    const data = await res.json();
    return data.reply;
}

// ── MongoDB — conexión única compartida entre reconexiones ───────────────────
let mongoCollection = null;

async function getMongoCollection() {
    if (mongoCollection) return mongoCollection;
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    console.log('🔄 Conectado a MongoDB');
    mongoCollection = client.db('klikbot').collection('baileys_auth_default');
    return mongoCollection;
}

async function connectToWhatsApp() {
    const logger = P({ level: 'silent' });

    // Reutiliza la conexión MongoDB entre reconexiones
    const collection = await getMongoCollection();

    // Cargar estado de autenticación desde MongoDB
    console.log('🔄 Cargando credenciales de MongoDB...');
    const { state, saveCreds } = await useMongoAuthState(collection);

    console.log('🔄 Obteniendo versión de Baileys...');
    const { version } = await fetchLatestBaileysVersion();
    console.log(`🔄 Versión: ${version}. Conectando...`);

    // Asignamos a la variable global para que /alert pueda usarla
    sock = makeWASocket({
        version,
        logger,
        auth: state,
        defaultQueryTimeoutMs: undefined,
        syncFullHistory: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
        lidToPhone.set(lid, pn);
    });

    sock.ev.on('messaging-history.set', ({ messages, syncType, isLatest }) => {
        console.log(`📚 messaging-history.set → ${messages.length} mensajes, syncType=${syncType}, isLatest=${isLatest}`);
        for (const msg of messages) {
            const text = msg.message?.conversation ||
                         msg.message?.extendedTextMessage?.text;
            if (!text || !msg.key.remoteJid) continue;

            const rawId = (msg.key.remoteJidAlt || msg.key.remoteJid).split('@')[0];
            // Resolver LID al número real si existe en el mapa
            const phone = lidToPhone.get(rawId) || rawId;

            if (!messageCache.has(phone)) messageCache.set(phone, []);
            messageCache.get(phone).push({
                fromMe: !!msg.key.fromMe,
                text,
                timestamp: Number(msg.messageTimestamp) || 0,
            });
        }
        console.log(`📚 Cache listo: ${messageCache.size} números en memoria`);

        if (RECOVERY_AUTO_PERSIST) {
            for (const [lid, msgs] of messageCache) {
                const messages = msgs
                    .sort((a, b) => a.timestamp - b.timestamp)
                    .map(m => ({ role: m.fromMe ? 'assistant' : 'user', content: m.text }));
                fetch(`${AGENT_URL}/recovery/${lid}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messages }),
                }).catch(err => console.error(`Error persistiendo recovery [${lid}]:`, err.message));
            }
            console.log(`💾 Persistiendo ${messageCache.size} conversaciones en Redis`);
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            console.log('--- KLIKBOT: ESCANEA EL CÓDIGO QR ---');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;

            console.log('Conexión cerrada. ¿Reconectar?', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ KlikBot: Conectado a WhatsApp.');
        }
    });

    // DEBUG TEMPORAL: interceptar TODOS los eventos de Baileys
    const originalEmit = sock.ev.emit.bind(sock.ev);
    sock.ev.emit = (event, ...args) => {
        const preview = JSON.stringify(args).slice(0, 150);
        console.log(`[debug-ev] ${event} → ${preview}`);
        return originalEmit(event, ...args);
    };

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        const debugPhone = (msg?.key?.remoteJidAlt || msg?.key?.remoteJid || '').split('@')[0];
        console.log(`[debug] messages.upsert type=${m.type} fromMe=${msg?.key?.fromMe} phone=${debugPhone}`);

        if (m.type !== 'notify') return;

        // Mensaje enviado por el asesor humano desde su teléfono al cliente
        if (msg.key.fromMe) {
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
            if (!text) return;

            const phone = (msg.key.remoteJidAlt || msg.key.remoteJid).split('@')[0];

            // Guardar en cache local
            if (!messageCache.has(phone)) messageCache.set(phone, []);
            messageCache.get(phone).push({ fromMe: true, text, timestamp: Date.now() / 1000 });

            // Persistir en Redis para que el agente tenga contexto al reactivarse
            fetch(`${AGENT_URL}/session/${phone}/human-message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, message: text }),
            }).catch(err => console.error(`[human-message] Error guardando mensaje del asesor: ${err.message}`));

            console.log(`👤 [asesor→${phone}]: ${text}`);
            return;
        }

// sendJid → JID que usa Baileys para enrutar el mensaje de respuesta.
        //           Siempre es remoteJid (puede ser @lid o @s.whatsapp.net).
        // phone   → identificador legible del usuario (número real).
        //           remoteJidAlt tiene el número real cuando WhatsApp usa LID.
        const sendJid = msg.key.remoteJid;
        const rawId = msg.key.remoteJid.split('@')[0];
        const phone = (msg.key.remoteJidAlt || msg.key.remoteJid).split('@')[0];

        // Si el rawId es un LID distinto al phone real, intentar migrar el historial
        // guardado en Redis bajo ese LID al número real (una sola vez, getdel lo borra)
        if (rawId !== phone) {
            fetch(`${AGENT_URL}/session/${phone}/restore`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ history: [], lid: rawId }),
            }).catch(() => {}); // silencioso — si no hay recovery tampoco pasa nada
        }

        // ── Extraer el contenido del mensaje ──────────────────────────────────

        // Texto plano o respuesta a otro mensaje
        let text = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text;

        // audioMessage cubre tanto notas de voz (ptt: true) como archivos de audio (ptt: false)
        const isAudio = !!msg.message?.audioMessage;

        if (!text && isAudio) {
            // El usuario envió un audio — transcribir antes de pasar al agente
            console.log(`🎤 Audio recibido de [${phone}], transcribiendo...`);
            try {
                text = await transcribeAudio(msg);
                console.log(`📝 Transcripción: "${text}"`);
            } catch (err) {
                console.error('Error transcribiendo audio:', err.message);
                await sock.sendMessage(sendJid, {
                    text: 'No pude entender el audio 😅 ¿Puedes escribirme tu consulta?'
                });
                return;
            }
        }

        // Si no hay texto ni audio reconocible (imagen, sticker, documento, etc.), ignorar
        if (!text) return;

        // Guardar mensaje del usuario en cache
        if (!messageCache.has(phone)) messageCache.set(phone, []);
        messageCache.get(phone).push({ fromMe: false, text, timestamp: Date.now() / 1000 });

        console.log(`📩 [${phone}][${rawId}]: ${text}`);

        // ── Debounce: acumular mensajes y llamar al agente una sola vez ────────
        if (pendingMessages.has(phone)) {
            const pending = pendingMessages.get(phone);
            clearTimeout(pending.timer);
            pending.messages.push(text);
        } else {
            pendingMessages.set(phone, { timer: null, messages: [text], sendJid });
        }

        const pending = pendingMessages.get(phone);
        pending.timer = setTimeout(async () => {
            pendingMessages.delete(phone);
            const combined = pending.messages.join('\n');
            if (pending.messages.length > 1) {
                console.log(`📦 [${phone}]: ${pending.messages.length} mensajes combinados`);
            }

            try {
                const reply = await callAgent(phone, combined);
                if (reply == '') {
                    console.log(`Usuario en espera`);
                    return;
                }

                // Guardar respuesta del bot en cache
                if (!messageCache.has(phone)) messageCache.set(phone, []);
                messageCache.get(phone).push({ fromMe: true, text: reply, timestamp: Date.now() / 1000 });

                const hasImage = reply.includes('[IMAGEN_PRODUCTO]');
                const cleanReply = reply.replace('[IMAGEN_PRODUCTO]', '').trimStart();

                if (hasImage) {
                    const existingImages = PRODUCT_IMAGES.filter(p => fs.existsSync(p));
                    for (let i = 0; i < existingImages.length; i++) {
                        const isLast = i === existingImages.length - 1;
                        await sock.sendMessage(pending.sendJid, {
                            image: { url: existingImages[i] },
                            ...(isLast && { caption: cleanReply }),
                        });
                    }
                    // Si no había ninguna imagen en disco, manda solo el texto
                    if (existingImages.length === 0) {
                        await sock.sendMessage(pending.sendJid, { text: cleanReply });
                    }
                    console.log(`🖼️ ${existingImages.length} imagen(es) + respuesta enviada a [${phone}]`);
                } else {
                    await sock.sendMessage(pending.sendJid, { text: cleanReply });
                    console.log(`🤖 Respuesta enviada a [${phone}]`);
                }
            } catch (err) {
                console.error('Error llamando a KlikAgents:', err.message);
                await sock.sendMessage(pending.sendJid, {
                    text: 'Lo siento, tuve un problema procesando tu mensaje. Por favor intenta de nuevo. 😅'
                });
            }
        }, DEBOUNCE_MS);
    });
}

connectToWhatsApp().catch((err) => console.error('Error inesperado:', err));
