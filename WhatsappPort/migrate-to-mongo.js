/**
 * migrate-to-mongo.js
 *
 * Script que sube los archivos de auth_info_baileys/ a MongoDB una sola vez.
 *
 * Uso:
 *   node migrate-to-mongo.js
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

async function migrate() {
    const MONGO_URI = process.env.MONGODB_URI;
    const DB_NAME = 'klikbot';

    if (!MONGO_URI) {
        console.error('❌ MONGODB_URI no está configurada en .env');
        process.exit(1);
    }

    const client = new MongoClient(MONGO_URI);

    try {
        await client.connect();
        console.log('✅ Conectado a MongoDB');

        const db = client.db(DB_NAME);
        const collection = db.collection('baileys_auth_default');

        // Leer archivos locales
        const authDir = path.join(__dirname, 'auth_info_baileys');
        if (!fs.existsSync(authDir)) {
            console.error(`❌ Carpeta ${authDir} no existe`);
            process.exit(1);
        }

        const files = fs.readdirSync(authDir);
        const docs = [];

        console.log(`📂 Leyendo ${files.length} archivos de ${authDir}...`);

        for (const file of files) {
            const filePath = path.join(authDir, file);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const docId = file.replace('.json', '');

            docs.push({
                _id: docId,
                ...data,
            });
        }

        // Limpiar colección vieja si existe
        await collection.deleteMany({});
        console.log('🗑️  Colección limpiada');

        // Insertar documentos
        if (docs.length > 0) {
            await collection.insertMany(docs, { ordered: false });
            console.log(`✅ Migranos ${docs.length} documentos a MongoDB`);
        }

        console.log('\n✨ Migración completada. Ya puedes eliminar auth_info_baileys/ localmente.');
    } catch (err) {
        console.error('❌ Error durante migración:', err.message);
        process.exit(1);
    } finally {
        await client.close();
    }
}

migrate();
