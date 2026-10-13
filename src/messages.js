// Notification texts. Set NOTIFY_LANG to "es" for Spanish (default "en"). Add a language by adding a key here.

const M = {
  en: {
    published: (t, who, when, link) => `✅ Published "${t}" on ${who} (${when}).\n${link || '(no link)'}`,
    gaveUp: (t, who, when, n, err, id) => `❌ Could not publish "${t}" (${who}, scheduled ${when}) after ${n} attempts.\n${err}\n\nTo retry: POST /queue/${id}/retry`,
    willRetry: (t, who, n, max, when, err) => `⚠️ "${t}" (${who}) failed — attempt ${n}/${max}. Retrying at ${when}.\n${err}`,
    expired: (t, when, id) => `❌ "${t}" expired without being published (scheduled ${when}). To publish it anyway: POST /queue/${id}/retry (optionally with a new scheduled_local).`,
    test: () => '🔔 Test from instagram-scheduler-worker: notifications reach this chat.',
    expiredReason: (hours) => `expired: more than ${hours} h past the scheduled time`,
  },
  es: {
    published: (t, who, when, link) => `✅ Publicado «${t}» en ${who} (${when}).\n${link || '(sin enlace)'}`,
    gaveUp: (t, who, when, n, err, id) => `❌ NO se pudo publicar «${t}» (${who}, programada ${when}) tras ${n} intentos.\n${err}\n\nPara reintentar: POST /queue/${id}/retry`,
    willRetry: (t, who, n, max, when, err) => `⚠️ Falló «${t}» (${who}) — intento ${n}/${max}. Reintento a las ${when}.\n${err}`,
    expired: (t, when, id) => `❌ «${t}» venció sin publicarse (programada ${when}). Para publicarla de todos modos: POST /queue/${id}/retry (opcionalmente con un scheduled_local nuevo).`,
    test: () => '🔔 Prueba del publicador de Instagram: los avisos llegan a este chat.',
    expiredReason: (hours) => `vencida: pasaron más de ${hours} h de la hora programada`,
  },
};

export const msg = (env) => M[env.NOTIFY_LANG] || M.en;
