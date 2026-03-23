/**
 * mongo-auth-state.js — Adaptador MongoDB para Baileys
 *
 * Implementa la misma interfaz que useMultiFileAuthState pero usando MongoDB.
 * Baileys espera:
 *   state.creds   → contenido de creds.json
 *   state.keys    → objeto con métodos get(type, ids) y set(data)
 *   saveCreds     → función async que guarda state.creds en MongoDB
 */

const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

async function useMongoAuthState(collection) {
    /**
     * Lee un documento de MongoDB por su _id.
     * Usa BufferJSON.reviver para restaurar Buffers serializados por Baileys.
     */
    async function readData(id) {
        const doc = await collection.findOne({ _id: id });
        if (!doc) return null;
        const { _id, ...data } = doc;
        return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
    }

    /**
     * Escribe un documento en MongoDB.
     * Usa BufferJSON.replacer para serializar Buffers de Baileys.
     */
    async function writeData(id, data) {
        const serialized = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await collection.updateOne(
            { _id: id },
            { $set: serialized },
            { upsert: true }
        );
    }

    /**
     * Elimina un documento de MongoDB.
     */
    async function removeData(id) {
        await collection.deleteOne({ _id: id });
    }

    // Cargar creds o inicializar si no existen
    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                /**
                 * Baileys llama a keys.get(type, ids) para obtener keys de sesión.
                 * type: 'pre-key', 'session', 'sender-key', etc.
                 * ids: array de identificadores
                 */
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const value = await readData(`${type}-${id}`);
                        data[id] = value;
                    }
                    return data;
                },

                /**
                 * Baileys llama a keys.set(data) para guardar keys nuevas o actualizadas.
                 * data: { [type]: { [id]: value | null } }
                 * Si value es null → borrar el documento
                 */
                set: async (data) => {
                    for (const [type, ids] of Object.entries(data)) {
                        for (const [id, value] of Object.entries(ids)) {
                            const key = `${type}-${id}`;
                            if (value) {
                                await writeData(key, value);
                            } else {
                                await removeData(key);
                            }
                        }
                    }
                },
            },
        },

        /**
         * saveCreds: persiste las credenciales actualizadas.
         * Baileys llama a esto cada vez que cambia state.creds.
         */
        saveCreds: async () => {
            await writeData('creds', creds);
        },
    };
}

module.exports = { useMongoAuthState };
