"""
db.py — Capa de acceso a Supabase (PostgreSQL)

Usamos asyncpg, el driver PostgreSQL más rápido para Python async.
A diferencia de ORMs como SQLAlchemy, asyncpg trabaja directamente con
queries SQL y es mucho más ligero.

POOL de conexiones:
  En lugar de abrir una conexión nueva por cada request (lento),
  asyncpg mantiene un pool de conexiones reutilizables.
  'acquire()' toma una conexión libre del pool y la devuelve al terminar.
"""

import os
import asyncpg

# Variable global para el pool. Se inicializa una sola vez al arrancar FastAPI.
_pool: asyncpg.Pool | None = None


async def init():
    """
    Crea el pool de conexiones. Se llama una vez al arrancar la app (desde main.py lifespan).
    ssl='require' es obligatorio para Supabase (rechaza conexiones sin SSL).
    min_size/max_size controla cuántas conexiones se mantienen abiertas simultáneamente.
    """
    global _pool
    _pool = await asyncpg.create_pool(
        os.getenv("SUPABASE_DB_URL"),
        ssl="require",
        min_size=1,
        max_size=5,
    )


async def close():
    """Cierra el pool limpiamente al apagar la app. Sin esto, las conexiones quedan colgadas."""
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


async def fetch(query: str, *args) -> list[asyncpg.Record]:
    """
    Ejecuta un SELECT y devuelve todas las filas.
    asyncpg.Record se comporta como un dict: row["columna"]
    Los parámetros van como $1, $2... en el query para evitar SQL injection.
    Ejemplo: await db.fetch("SELECT * FROM products WHERE is_active = $1", True)
    """
    async with _pool.acquire() as conn:
        return await conn.fetch(query, *args)


async def fetchrow(query: str, *args) -> asyncpg.Record | None:
    """
    Igual que fetch() pero devuelve solo la primera fila (o None si no hay resultados).
    Ideal para búsquedas por ID o campos únicos.
    """
    async with _pool.acquire() as conn:
        return await conn.fetchrow(query, *args)


async def execute(query: str, *args) -> str:
    """
    Ejecuta un INSERT, UPDATE o DELETE sin retornar filas.
    Devuelve el comando SQL ejecutado (ej: "UPDATE 1").
    """
    async with _pool.acquire() as conn:
        return await conn.execute(query, *args)
