// Thin client for the Instagram Content Publishing API (Graph API). Publishing is always a two-step flow:
//   1. create a media *container*  2. wait until it is FINISHED  3. media_publish the container.

const GRAPH_DEFAULT = 'v21.0';
const graph = (env) => `https://graph.facebook.com/${env.GRAPH_VERSION || GRAPH_DEFAULT}`;

export const sleep = (env, ms) => new Promise((r) => setTimeout(r, env.POLL_DELAY_MS !== undefined ? Number(env.POLL_DELAY_MS) : ms));

/** Account map from the ACCOUNTS variable: { "main": { "page_id": "…", "ig_id": "…", "label": "@handle" } }. */
export function parseAccounts(env) {
  let accounts;
  try { accounts = typeof env.ACCOUNTS === 'string' ? JSON.parse(env.ACCOUNTS) : env.ACCOUNTS; } catch { accounts = null; }
  if (!accounts || typeof accounts !== 'object' || !Object.keys(accounts).length) throw new Error('ACCOUNTS is missing or is not valid JSON (see README)');
  for (const [key, a] of Object.entries(accounts)) {
    if (!a?.page_id || !a?.ig_id) throw new Error(`ACCOUNTS.${key} needs page_id and ig_id`);
  }
  return accounts;
}

/** Instagram publishing goes through the Facebook Page that is linked to the account, so we exchange the system-user token for a page token. */
export async function pageToken(env, pageId) {
  const r = await fetch(`${graph(env)}/${pageId}?fields=access_token&access_token=${env.META_ACCESS_TOKEN}`).then((x) => x.json());
  if (!r.access_token) throw new Error(`page token: ${JSON.stringify(r.error || r).slice(0, 300)}`);
  return r.access_token;
}

export async function graphPost(env, path, params) {
  const r = await fetch(`${graph(env)}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  }).then((x) => x.json());
  if (r.error) throw new Error(`Meta ${path}: ${JSON.stringify(r.error).slice(0, 400)}`);
  return r;
}

export const containerStatus = (env, id, token) => fetch(`${graph(env)}/${id}?fields=status_code,status&access_token=${token}`).then((x) => x.json());

export async function permalinkOf(env, mediaId, token) {
  try { return (await fetch(`${graph(env)}/${mediaId}?fields=permalink&access_token=${token}`).then((x) => x.json())).permalink || null; } catch { return null; }
}

export const recentMedia = (env, igId, token) => fetch(`${graph(env)}/${igId}/media?fields=id,caption&limit=5&access_token=${token}`).then((x) => x.json());

/** Creates the container(s) without publishing. Returns { creation_id, items }. */
export async function createContainer(env, post, igId, token) {
  const media = JSON.parse(post.media_json);
  const collab = post.collaborators_json ? { collaborators: post.collaborators_json } : {};
  if (post.type === 'image') {
    const r = await graphPost(env, `${igId}/media`, { image_url: media[0], caption: post.caption, ...collab, access_token: token });
    return { creation_id: r.id, items: null };
  }
  if (post.type === 'reel') {
    const r = await graphPost(env, `${igId}/media`, { media_type: 'REELS', video_url: media[0], caption: post.caption, share_to_feed: 'true', ...collab, access_token: token });
    return { creation_id: r.id, items: null };
  }
  // carousel: one child container per slide, then a parent container
  const items = [];
  for (const url of media) items.push((await graphPost(env, `${igId}/media`, { image_url: url, is_carousel_item: 'true', access_token: token })).id);
  await sleep(env, 3000);
  const r = await graphPost(env, `${igId}/media`, { media_type: 'CAROUSEL', children: items.join(','), caption: post.caption, ...collab, access_token: token });
  return { creation_id: r.id, items };
}
