# instagram-scheduler-worker (español)

Programa publicaciones de Instagram (imagen, carrusel, reel) desde una cola en **Cloudflare Workers + D1 + R2**.
Sin servidor propio, sin costo mensual para una cuenta pequeña, y **nunca publica lo mismo dos veces**.

Se usa en producción en la [Fundación Utopía Animal](https://utopianimal.org) (Medellín, Colombia), donde publica en las cuentas de Instagram de Utopía Animal Vet y de Elim · Refugio Animal. Cada mejora que se le hace en producción vive en este repositorio.

## Lo esencial

- Imagen, carrusel (2–10 láminas) y reel; hasta 3 colaboradores; varias cuentas desde un solo Worker.
- **Publicación idempotente:** guarda el contenedor de Instagram apenas existe y, antes de publicar, comprueba si ya salió. Si la red
  se corta justo al publicar, el reintento averigua qué pasó en lugar de duplicar la publicación.
- Hasta 4 reintentos (10/20/30 min). Una publicación con más de 6 h de retraso no sale sola.
- Programas en **hora local** (`"2026-10-19 19:00"`) con cualquier zona IANA (`America/Bogota`, …), incluyendo cambios de horario.
- Avisos por Telegram al publicar y en cada fallo. Prueba en seco (`igs test <id>`) sin publicar.

## Puesta en marcha

1. `npm install`, `wrangler d1 create instagram-scheduler`, `wrangler r2 bucket create instagram-scheduler-media`.
2. En `wrangler.jsonc`: `database_id`, `TIMEZONE` (p. ej. `America/Bogota`) y `ACCOUNTS` con el `page_id` y el `ig_id` de cada cuenta.
3. Secretos: `wrangler secret put META_ACCESS_TOKEN`, `PUBLISH_SECRET` (y opcionalmente `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
4. `wrangler deploy`.
5. `export IGS_URL=https://…workers.dev IGS_SECRET=<tu PUBLISH_SECRET>` y usa `node cli/igs.mjs upload | schedule | queue | test`.

Necesitas una cuenta de Instagram **profesional** enlazada a una página de Facebook y un token de Meta con permiso para publicar
(un token de *usuario del sistema* no caduca). El detalle, la API HTTP y las garantías están en el [README en inglés](README.md).

Licencia MIT. Sin afiliación con Meta, Instagram ni Cloudflare.
