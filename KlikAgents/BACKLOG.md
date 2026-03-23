# Backlog KlikAgents

## Ideas y mejoras futuras

### 🏗️ Plataforma multi-tenant
Evolucionar de un bot para un solo negocio a una plataforma SaaS que sirva miles de negocios.

**Qué implica:**
- Agregar `tenant_id` a todas las tablas (products, customers, orders, shipping_info)
- Nueva tabla `tenants` con nombre, número de WhatsApp y system_prompt por negocio
- Agente dinámico: instanciar el Agent en runtime según el tenant, no al importar
- Prompt generado desde configuración (formulario web → prompt automático)
- Dashboard para que cada negocio configure su bot sin tocar código

**Stack sugerido a futuro:**
- Migrar a LangGraph cuando haya flujos distintos por vertical (e-commerce, restaurantes, servicios)
- API Gateway que enrute por tenant_id
- Un número de WhatsApp Business por negocio

**Cuándo hacerlo:** cuando llegue el segundo cliente.

---

### 🔌 Integración con ERP / POS existentes
Muchos negocios ya tienen sus propios sistemas y no quieren reemplazarlos.

**Tres escenarios según el tamaño del negocio:**

**Pequeño (80% del mercado LATAM):** No tienen ERP. Usan Excel o WhatsApp manual.
KlikAgents ES su sistema. Supabase reemplaza el Excel. Sin fricción de integración. Cliente ideal para empezar.

**Mediano con Shopify/e-commerce:** Integración limpia vía webhooks.
KlikAgents crea la orden en Supabase y simultáneamente la empuja a Shopify. Shopify maneja inventario, envío y factura.

**Con ERP tradicional (Siigo, SAP, World Office, iPos):**
- Corto plazo: Human-in-the-loop. El bot cierra la venta y notifica al operador, quien entra la orden manualmente al POS/ERP. Sin integración, funciona desde el día 1.
- Mediano plazo: API de Siigo (tiene API decente) y iPos para restaurantes.
- Largo plazo: Marketplace de conectores, el negocio conecta su sistema sin dev.

**Realidad del mercado colombiano:**
La mayoría de negocios que pagarían $99/mes no tienen ERP. Para ellos la plataforma es un upgrade enorme sin fricción.

| Sistema | API disponible | Prioridad |
|---|---|---|
| Shopify | Sí, robusta | Alta |
| Siigo | Sí, decente | Media |
| iPos (restaurantes) | Sí | Media |
| World Office | Limitada | Baja |
| SAP | Sí, costosa | Solo enterprise |

---

### 🔗 Integraciones y features de plataforma
Expandir más allá del bot de ventas para convertirse en una plataforma de operaciones D2C por WhatsApp.

| Feature | Descripción |
|---|---|
| **Shopify sync** | Webhook de Shopify sincroniza productos y stock automáticamente |
| **Carga de menú por foto** | GPT-4o Vision lee una foto del menú y crea los productos en BD |
| **Seguimiento de envío** | Webhook de transportadora notifica al cliente cuando sale el pedido |
| **Campañas masivas** | Enviar promociones a todos los clientes de un negocio |
| **Dashboard de pedidos** | Panel web para ver órdenes, clientes y métricas por negocio |
| **Recuperación de carrito abandonado** | Si el cliente no compró, el bot hace seguimiento 24h después |

**Precio objetivo con estas features:** $120–150/mes. Compite con Treble + Whaticket + Shopify juntos ($200–400/mes).

---

### 🍽️ Vertical: Restaurantes con campañas de retención
Flujo completo para restaurantes que operan pedidos por WhatsApp con incentivos de regreso.

**Cómo funciona:**
1. Cliente llega al restaurante y hace su pedido por WhatsApp
2. El mesero confirma la orden desde un panel o comando
3. Unos días después (o el fin de semana), el sistema envía una campaña automática al cliente:
   *"Hola [nombre], este fin de semana tienes un 5% de descuento si vuelves a visitarnos 🍕 Muestra este mensaje al llegar."*
4. El cliente vuelve, presenta el cupón y el mesero lo aplica

**Por qué es poderoso:**
- Convierte una visita única en cliente recurrente
- El restaurante no necesita app propia ni sistema de fidelización
- El bono se entrega por el mismo canal donde ya habla el cliente (WhatsApp)
- Escalable: se puede segmentar por frecuencia, ticket promedio o fecha de última visita

**Qué necesita técnicamente:**
- Tabla `campaigns` con fecha de envío, segmento y mensaje
- Tabla `coupons` con código, descuento y estado (usado/no usado)
- Scheduler para disparar la campaña (cron job o Upstash QStash)
- Rol de "mesero/operador" que confirma órdenes sin acceso al panel completo
- Flujo LangGraph diferente al e-commerce (pedido en mesa, no envío a domicilio)
