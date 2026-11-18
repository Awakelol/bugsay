# Bugsay on Cloudflare Workers

A demo copy of Bugsay that runs free and always on, at
`https://test-site.<your-subdomain>.workers.dev`. The Flask app in the repo root
is still the real one: this folder builds from it.

| Part | Flask version | Cloudflare version |
|---|---|---|
| Pages | Rendered by Flask on every visit | Rendered once by `build.py` with the same templates, served as static files |
| API (`/api/*`) | `app.py` | `worker/index.js` + `worker/logic.js` (a port of the same rules) |
| Booking page | `templates/booking.html` | `worker/booking.js` (a port; keep the two in step) |
| Bookings | SQLite file | D1 (Cloudflare's SQLite), created on first deploy |
| Overbooking guard | `BEGIN IMMEDIATE` lock | One atomic D1 batch ending in a capacity check that rolls it back |

`data.py` stays the single source for ports, sailings, fares and capacities;
`build.py` exports it to `worker/generated/data.js`.

## Commands (run in this folder)

```bash
npm install        # wrangler, first time only
npm test           # build + 36 Worker tests (Node 22.5+, uses node:sqlite as a D1 stand-in)
npm run dev        # build + local preview on http://localhost:8787
npx wrangler login # first time only
npm run deploy     # build + publish to test-site.<your-subdomain>.workers.dev
```

`build.py` needs Flask. It uses `../.venv` automatically if your `python` doesn't have it.

## Swapping the test site

The Worker is named `test-site`. Deploying any other project with
`"name": "test-site"` in its wrangler config (or `npx wrangler deploy --name test-site`)
replaces Bugsay at the same address. Bugsay's bookings stay in the
`bugsay-test-site` D1 database until you delete it in the Cloudflare dashboard.

## Differences from the Flask version

- "Today" is Philippine time (Asia/Manila), since Workers run on UTC.
- The date fields and search forms are filled in the browser from the URL
  (`static/js/site.js`), because the pages are prebuilt.
- The footer year is the year of the last build.
