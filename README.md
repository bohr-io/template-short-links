# Short links

A URL shortener for your own domain: `your-domain.com/promo` sends visitors to any long address and counts
every click. The admin creates links (with a custom name or a random one like `/aB3x9Z`), copies them, turns
them on and off, changes where they go, shows clicks per day (last 7 days in the list, last 30 days per link)
and exports everything as CSV. The home page can show a small page about the links or send visitors to your
main website.

Runs as one Cloudflare Worker (Hono API + static files in `public/`) with a D1 database. The pages speak
Brazilian Portuguese, English and Spanish, following the visitor's browser.

Slugs are 1 to 64 letters, digits, `-` or `_`, and they ignore case: `/Promo` and `/promo` are the same link.
Names used by the site itself (`admin`, `api`, `assets`, `index`, `404`, `favicon`, `robots`, `sitemap`,
`go`) are reserved; add to `RESERVED` in `src/index.ts` any page you add to `public/`. Clicks are
counted per UTC day; only `GET` requests count (not `HEAD`), and a turned-off link shows the 404 page.

## Admin password

The admin (`/admin`) uses the `ADMIN_PASSWORD` variable. bohr sets it when it creates the project; to change it,
edit the site variable in bohr or run `npx wrangler secret put ADMIN_PASSWORD`. Without it the admin stays
closed and explains how to set it. Only the admin creates links (public creation would invite abuse).

## Routes

| Route | What |
| --- | --- |
| `/` | Home page (`public/index.html`), or a redirect to the address set in the admin |
| `/:slug` | Redirect (302) to the link's destination and count the click; unknown or turned-off links show the 404 page |
| `/admin` | Admin: links, stats, clicks per day, CSV export, home page setting |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session` | Admin session |
| `GET /api/admin/stats` | Links, total clicks, clicks in the last 7 days |
| `GET /api/admin/links?q=&page=` | Links, newest first, each with its last 7 days of clicks |
| `POST /api/admin/links` | Create: `{ url, slug?, title? }` → the link (409 `slug_taken`) |
| `GET /api/admin/links/:id` | One link with its clicks per day for the last 30 days |
| `PUT /api/admin/links/:id` | Change `{ url, title, active }` |
| `DELETE /api/admin/links/:id` | Delete a link and its click history |
| `GET /api/admin/links.csv` | CSV export with clicks |
| `GET/PUT /api/admin/settings` | `{ home_url }`: where `/` redirects (empty shows the home page) |

`wrangler.jsonc` sets `run_worker_first: true` so the Worker sees every request before the static files: without
it, a browser opening `/promo` would get the 404 page straight from `public/` and never reach the redirect.

## Run locally

```sh
npm install
cp .dev.vars.example .dev.vars   # sets ADMIN_PASSWORD for local development
npx wrangler d1 migrations apply DB --local && npx wrangler dev
```

Then open `http://localhost:8787/bohr`: the example link redirects to bohr.io. Schema changes go in a new file in
`migrations/` (for example `0002_add_expires_at.sql`); deploys apply them.

## Ideas to ask the agent

- Show a QR code for each link, ready to download for print.
- Add a UTM builder to the create form (source, medium, campaign).
- Expiring links: an end date after which the link shows a "this link expired" page.
- Password-protected links that ask for a password before redirecting.
- Break clicks down by referrer and country (from `request.cf`) in the details view.
- API tokens so scripts can create links without the admin password.
- Bulk import links from a CSV file.
