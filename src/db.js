// D1 access. The table is created on first use, so there is no migration step.

let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    media_json TEXT NOT NULL,
    caption TEXT NOT NULL,
    collaborators_json TEXT,
    scheduled_utc TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_utc TEXT,
    lock_until TEXT,
    creation_id TEXT,
    items_json TEXT,
    media_id TEXT,
    permalink TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT)`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_posts_status ON posts (status, scheduled_utc)').run();
  schemaReady = true;
}

/** Test hook: lets each test start from a fresh database. */
export function resetSchemaCache() { schemaReady = false; }

export const nowIso = () => new Date().toISOString();

export function updatePost(env, id, fields) {
  const keys = Object.keys(fields);
  return env.DB.prepare(`UPDATE posts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...keys.map((k) => fields[k] ?? null), nowIso(), id).run();
}
