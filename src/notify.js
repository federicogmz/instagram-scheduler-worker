// Optional Telegram notifications. Without TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID this is a no-op.
// To use Slack, Discord or e-mail instead, replace the body of notify(): nothing else calls Telegram.

export async function notify(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 3800) }),
    });
  } catch (e) {
    console.error('notify failed', String(e));
  }
}
