require('dotenv').config();

const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,   // Descarga el contenido binario de un mensaje multimedia
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const { OpenAI, toFile } = require('openai');

const http = require('http');
const path = require('path');
const fs   = require('fs');

// Imágenes del producto almacenadas en images/
// La etiqueta [IMAGEN_PRODUCTO] en el reply activa el envío automático.
const PRODUCT_IMAGES = [
    path.join(__dirname, 'images', 'shilajit1.jpg'),
];

const AGENT_URL   = process.env.AGENT_URL   || 'http://127.0.0.1:8000';
const API_PORT    = process.env.API_PORT     || 3000;

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

// ── Servidor HTTP interno ────────────────────────────────────────────────────
// Expone POST /alert para que KlikAgents pueda disparar notificaciones WPP
// sin necesidad de mantener su propia conexión a WhatsApp.
const apiServer = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/alert') {
        res.writeHead(404);
        res.end();
        return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        try {
            const { message } = JSON.parse(body);

            if (!sock) {
                res.writeHead(503);
                res.end(JSON.stringify({ error: 'WhatsApp no conectado aún' }));
                return;
            }

            // Enviar el mensaje a cada número configurado en NOTIFY_PHONES
            for (const phone of NOTIFY_PHONES) {
                await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: message });
                console.log(`🔔 Alerta enviada a [${phone}]`);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'sent', recipients: NOTIFY_PHONES.length }));
        } catch (err) {
            console.error('Error en /alert:', err.message);
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

async function connectToWhatsApp() {
    const logger = P({ level: 'silent' });
    console.log('🔄 Cargando credenciales...');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    console.log('🔄 Obteniendo versión de Baileys...');
    const { version } = await fetchLatestBaileysVersion();
    console.log(`🔄 Versión: ${version}. Conectando...`);

    // Asignamos a la variable global para que /alert pueda usarla
    sock = makeWASocket({
        version,
        logger,
        auth: state,
        defaultQueryTimeoutMs: undefined,
    });

    sock.ev.on('creds.update', saveCreds);

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

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];

        if (msg.key.fromMe || m.type !== 'notify') return;

// sendJid → JID que usa Baileys para enrutar el mensaje de respuesta.
        //           Siempre es remoteJid (puede ser @lid o @s.whatsapp.net).
        // phone   → identificador legible del usuario (número real).
        //           remoteJidAlt tiene el número real cuando WhatsApp usa LID.
        const sendJid = msg.key.remoteJid;
        const phone = (msg.key.remoteJidAlt || msg.key.remoteJid).split('@')[0];

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

        console.log(`📩 [${phone}]: ${text}`);

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
