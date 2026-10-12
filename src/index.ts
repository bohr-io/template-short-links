import { Hono } from 'hono';
import type { AppEnv } from './env';
import { auth, requireAdmin } from './lib/auth';
import { apiGuard, csvResponse, fail, onError, readJson, serveAssets } from './lib/http';
import { boolean, id, integer, text, url } from './lib/validate';

type Link = {
  id: number;
  slug: string;
  url: string;
  title: string;
  active: number;
  clicks: number;
  last_click_at: string | null;
  created_at: string;
};

// Slugs: 1 to 64 letters, digits, "-" or "_", matched ignoring case (the column is COLLATE NOCASE).
const SLUG = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Slugs that would collide with the site's own routes and files in public/ (/admin, /index, /404, /api,
 * /assets...): they can't be created and never redirect. Add here any page you add to public/.
 */
const RESERVED = new Set(['admin', 'api', 'assets', 'index', '404', 'favicon', 'robots', 'sitemap', 'go']);
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const RANDOM_SLUG_LENGTH = 6;

const isReserved = (slug: string) => RESERVED.has(slug.toLowerCase());

/** A random base62 slug (crypto.getRandomValues, without modulo bias). */
function randomSlug(): string {
  let slug = '';
  while (slug.length < RANDOM_SLUG_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 248 = 4 × 62: bytes above it would favour the first characters
      if (byte < 248 && slug.length < RANDOM_SLUG_LENGTH) slug += BASE62[byte % 62];
    }
  }
  return slug;
}

/** The UTC day `offset` days from today, as 'YYYY-MM-DD'. */
function utcDay(offset = 0): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** The destination: an http(s) URL of up to 2048 characters. */
function destination(value: unknown): string {
  const href = url(value, 'url');
  if (href.length > 2048) fail(400, 'invalid_url');
  return href;
}

/** Clicks per day for the last `days` days (oldest first) of each link in `ids`. */
async function dailyClicks(db: D1Database, ids: number[], days: number): Promise<Map<number, number[]>> {
  const series = new Map(ids.map((linkId) => [linkId, new Array<number>(days).fill(0)]));
  if (ids.length === 0) return series;
  const first = utcDay(-(days - 1));
  const { results } = await db
    .prepare(`SELECT link_id, day, count FROM clicks_daily WHERE day >= ? AND link_id IN (${ids.map(() => '?').join(',')})`)
    .bind(first, ...ids)
    .all<{ link_id: number; day: string; count: number }>();
  const start = Date.parse(`${first}T00:00:00Z`);
  for (const row of results) {
    const index = Math.round((Date.parse(`${row.day}T00:00:00Z`) - start) / 86_400_000);
    const values = series.get(row.link_id);
    if (values && index >= 0 && index < days) values[index] = row.count;
  }
  return series;
}

async function homeUrl(db: D1Database): Promise<string> {
  return (await db.prepare("SELECT value FROM settings WHERE key = 'home_url'").first<string>('value')) ?? '';
}

/** A 302 that browsers and proxies don't keep: the link can change or be turned off at any time. */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'private, max-age=0' } });
}

const app = new Hono<AppEnv>();
app.onError(onError);
app.use('/api/*', apiGuard);
app.route('/api/auth', auth);
app.use('/api/admin/*', requireAdmin);

// Admin: the numbers at the top of the admin
app.get('/api/admin/stats', async (c) => {
  const [links, week] = await c.env.DB.batch<{ links: number; clicks: number; week: number }>([
    c.env.DB.prepare('SELECT COUNT(*) AS links, COALESCE(SUM(clicks), 0) AS clicks FROM links'),
    c.env.DB.prepare('SELECT COALESCE(SUM(count), 0) AS week FROM clicks_daily WHERE day >= ?').bind(utcDay(-6)),
  ]);
  const totals = links?.results[0];
  return c.json({ links: totals?.links ?? 0, clicks: totals?.clicks ?? 0, week: week?.results[0]?.week ?? 0 });
});

// Admin: links, newest first, with search, pages and the last 7 days of clicks of each one (oldest first)
app.get('/api/admin/links', async (c) => {
  const query = text(c.req.query('q'), 'q', { max: 100, optional: true });
  const page = integer(c.req.query('page') ?? '1', 'page', 1, 100_000);
  const pageSize = 50;
  const like = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const where = query === '' ? '' : "WHERE slug LIKE ?1 ESCAPE '\\' OR url LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\'";
  const binds = query === '' ? [] : [like];
  const [rows, total] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(`SELECT * FROM links ${where} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`).bind(
      ...binds,
    ),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM links ${where}`).bind(...binds),
  ]);
  const links = (rows?.results ?? []) as Link[];
  const week = await dailyClicks(
    c.env.DB,
    links.map((link) => link.id),
    7,
  );
  return c.json({
    items: links.map((link) => ({ ...link, active: link.active === 1, week: week.get(link.id) ?? [] })),
    total: Number(total?.results[0]?.total ?? 0),
    page,
    pageSize,
  });
});

// Admin: create a link. Without a slug, a random one is chosen.
app.post('/api/admin/links', async (c) => {
  const body = await readJson(c, 8192);
  const target = destination(body.url);
  const title = text(body.title, 'title', { max: 120, optional: true });
  const custom = text(body.slug, 'slug', { max: 64, optional: true });
  if (custom !== '' && (!SLUG.test(custom) || isReserved(custom))) fail(400, 'invalid_slug');
  const insert = c.env.DB.prepare(
    'INSERT INTO links (slug, url, title) VALUES (?, ?, ?) ON CONFLICT (slug) DO NOTHING RETURNING *',
  );
  if (custom !== '') {
    const link = await insert.bind(custom, target, title).first<Link>();
    if (link === null) fail(409, 'slug_taken');
    return c.json({ ...link, active: true }, 201);
  }
  // A random slug rarely collides; try a few times
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = randomSlug();
    if (isReserved(slug)) continue;
    const link = await insert.bind(slug, target, title).first<Link>();
    if (link !== null) return c.json({ ...link, active: true }, 201);
  }
  fail(409, 'slug_taken');
});

// Admin: one link with its clicks per day for the last 30 days (oldest first)
app.get('/api/admin/links/:id', async (c) => {
  const link = await c.env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(id(c.req.param('id'))).first<Link>();
  if (link === null) fail(404, 'not_found');
  const counts = (await dailyClicks(c.env.DB, [link.id], 30)).get(link.id) ?? [];
  const days = counts.map((count, index) => ({ day: utcDay(index - 29), count }));
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return c.json({ ...link, active: link.active === 1, days, last7: sum(counts.slice(-7)), last30: sum(counts) });
});

// Admin: change the destination, the title or turn the link on and off (the slug stays: it may be shared)
app.put('/api/admin/links/:id', async (c) => {
  const linkId = id(c.req.param('id'));
  const body = await readJson(c, 8192);
  const link = await c.env.DB.prepare('UPDATE links SET url = ?, title = ?, active = ? WHERE id = ? RETURNING *')
    .bind(destination(body.url), text(body.title, 'title', { max: 120, optional: true }), boolean(body.active, 'active') ? 1 : 0, linkId)
    .first<Link>();
  if (link === null) fail(404, 'not_found');
  return c.json({ ...link, active: link.active === 1 });
});

// Admin: delete a link and its click history
app.delete('/api/admin/links/:id', async (c) => {
  const linkId = id(c.req.param('id'));
  const [, removed] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM clicks_daily WHERE link_id = ?').bind(linkId),
    c.env.DB.prepare('DELETE FROM links WHERE id = ?').bind(linkId),
  ]);
  if (removed?.meta.changes === 0) fail(404, 'not_found');
  return c.json({ ok: true });
});

app.get('/api/admin/links.csv', async (c) => {
  const origin = new URL(c.req.url).origin;
  const { results } = await c.env.DB.prepare('SELECT * FROM links ORDER BY id').all<Link>();
  const columns = ['id', 'slug', 'short_url', 'url', 'title', 'active', 'clicks', 'last_click_at', 'created_at'];
  return csvResponse(
    'links.csv',
    columns,
    results.map((link) => [
      link.id,
      link.slug,
      `${origin}/${link.slug}`,
      link.url,
      link.title,
      link.active === 1 ? 'yes' : 'no',
      link.clicks,
      link.last_click_at ?? '',
      link.created_at,
    ]),
  );
});

app.get('/api/admin/settings', async (c) => c.json({ home_url: await homeUrl(c.env.DB) }));

app.put('/api/admin/settings', async (c) => {
  const body = await readJson(c);
  const home = url(body.home_url, 'home_url', { optional: true });
  await c.env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('home_url', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(home)
    .run();
  return c.json({ home_url: home });
});

app.all('/api/*', () => fail(404, 'not_found'));

// Public: the home page (public/index.html), or a redirect to the address set in the admin. Like the short
// links below, this works because the Worker runs before the static files (run_worker_first in wrangler.jsonc).
app.get('/', async (c) => {
  const home = await homeUrl(c.env.DB);
  if (home !== '') return redirect(home);
  return c.env.ASSETS.fetch(c.req.raw);
});

// Public: the short links. An active link answers a redirect and counts the click (GET only, after the
// answer is sent); anything else is a static file or the 404 page.
app.get('/:slug', async (c) => {
  const slug = c.req.param('slug') ?? '';
  if (!SLUG.test(slug) || isReserved(slug)) return c.env.ASSETS.fetch(c.req.raw);
  const link = await c.env.DB.prepare('SELECT id, url FROM links WHERE slug = ? AND active = 1')
    .bind(slug)
    .first<{ id: number; url: string }>();
  if (link === null) return c.env.ASSETS.fetch(c.req.raw);
  if (c.req.method === 'GET') {
    c.executionCtx.waitUntil(
      c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE links SET clicks = clicks + 1, last_click_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
        ).bind(link.id),
        c.env.DB.prepare(
          `INSERT INTO clicks_daily (link_id, day, count) VALUES (?, ?, 1)
           ON CONFLICT (link_id, day) DO UPDATE SET count = count + 1`,
        ).bind(link.id, utcDay()),
      ]).catch((error) => console.error('click not counted', error)),
    );
  }
  return redirect(link.url);
});

app.all('*', serveAssets);

export default app;
