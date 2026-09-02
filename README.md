# Progenies — Genealogy & Family Tree PWA

A multi-tree genealogy progressive web app for personal family research and
biblical genealogies. Imports/exports GEDCOM 5.5, handles complex family
structures (multiple spouses, unknown relations), and visualizes lineages with
D3.js.

## Stack

FastAPI (Python 3.11) · React 18 + Vite + TypeScript · PostgreSQL 15 ·
Tailwind CSS · D3.js · Docker Compose

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

| Service  | URL                          |
|----------|------------------------------|
| Frontend | http://localhost:5173        |
| API      | http://localhost:8000        |
| API docs | http://localhost:8000/docs   |

### Accessing from another device (LAN / phone)

Open `http://<your-mac-ip>:5173` (find it with `ipconfig getifaddr en0`). The
frontend auto-detects the API on the same host (port 8000), and CORS already
allows private-LAN origins — no extra config needed. Useful for testing the PWA
on a phone. (Both ports 5173 and 8000 are published by Docker.)

Register an account in the UI, create a tree, then **Import GEDCOM** to load a
`.ged` file. Pick a root person to render the descendant pyramid; click any
person to re-root, scroll to zoom, drag to pan. **Export GEDCOM** downloads a
round-tripped `.ged`.

## Deploying (production)

`docker-compose.prod.yml` runs the images CI publishes to GHCR — nothing is
built on the host. The reference setup is a small Linux Docker host running
the stack from Portainer, with `cloudflared` on another LAN machine (a NAS)
forwarding a Cloudflare Tunnel to the web container's published port. The web container serves the SPA and
proxies `/api`, `/auth` and `/public` to the backend on the same origin, so
the tunnel only ever points at one port; the database is never published.

### Environment

Set these in Portainer's stack editor (or a `.env` next to the compose file).
Everything not marked required has a default that matches the previous
release, so an existing stack keeps working until you opt in.

| Variable | Required | What it does |
|---|---|---|
| `SECRET_KEY` | yes | JWT signing key. `openssl rand -hex 32`. |
| `POSTGRES_PASSWORD` | yes | Database password for this instance. |
| `BOOTSTRAP_TOKEN` | strongly recommended | When set, creating the **first** user account requires this value; without it, whoever reaches the register page first owns the instance. `openssl rand -hex 16`. Only matters until the first account exists — after that it can stay set or be removed. |
| `DATA_PATH` | strongly recommended | **Absolute** host folder for the database files and backups, e.g. `/volume1/docker/progenies`. See *Data and backups*. |
| `HTTP_PORT` | no | Host port for the web app (default `8080`; the reference setup uses `8091`). |
| `HTTP_BIND` | no | Host interface the web port binds to (default `0.0.0.0`). Only set it to `127.0.0.1` when `cloudflared` runs on the same machine AND the tunnel already targets `127.0.0.1` — see *Tunnel and client addresses*. |
| `FORWARDED_ALLOW_IPS` | no | Sources the backend trusts for `X-Forwarded-For` / `X-Forwarded-Proto` (default `172.16.0.0/12,10.0.0.0/8`). See below. |
| `IMAGE_TAG` | no | Image tag to run (default `latest`). CI also tags every image with its git SHA, so a bad deploy rolls back by pinning `IMAGE_TAG` to the last good SHA. |
| `APP_NAME` | no | API display name. The web bundle's name is baked in at build time and is not affected. |

### Tunnel and client addresses

Behind the tunnel every request reaches nginx from `cloudflared`'s address,
so without help the app would see one client — and per-client limits (login
throttling, the share-link rate limit) would throttle everyone together.
nginx therefore recovers the real address from Cloudflare's
`CF-Connecting-IP` header, but **only when the connection came from a
private range** — Docker's (`172.16.0.0/12`, `10.0.0.0/8`), the LAN
(`192.168.0.0/16`), or loopback — i.e. from a machine you control. It then
sets `X-Forwarded-For` / `X-Forwarded-Proto` for the backend (overwriting
anything inbound), and the backend honours those headers only from
`FORWARDED_ALLOW_IPS`, which defaults to the Docker ranges.

Check it is working after deploying: `docker logs --tail 3 <web container>`
should show visitors' public addresses. If every line shows the same LAN
address, that is `cloudflared`'s host and the header is not being trusted.

Where `cloudflared` runs decides one setting:

- **`cloudflared` on a different machine than the app** (for example the
  tunnel on a NAS, the app on a Docker host). The tunnel's service URL is the
  app host's LAN address and port. **Leave `HTTP_BIND` unset.** Binding to
  loopback would make the app unreachable from the tunnel and take the site
  down. To keep other LAN devices off the port, use the app host's firewall
  instead, e.g. `ufw allow from <cloudflared host IP> to any port 8091` and
  `ufw deny 8091`.
- **`cloudflared` on the same machine as the app.** You may bind the port to
  loopback so nothing else on the LAN can reach it: FIRST change the tunnel's
  service URL to `http://127.0.0.1:<HTTP_PORT>`, confirm the site still
  loads, and only THEN set `HTTP_BIND=127.0.0.1` and update the stack. Doing
  it in the other order takes the site down until you revert.

With the port open to the LAN (the first case), a LAN device could send its
own `CF-Connecting-IP` and be treated as that address for the per-IP rate
limits only — the per-account login throttle still applies. On a home
network that is an acceptable trade; the firewall rule above removes it.

`FORWARDED_ALLOW_IPS` trusts the whole stack network, which includes the
`db-backup` sidecar as well as nginx; that sidecar has no route to the
backend in normal operation, so this is a fine default. The stricter option
is to pin the stack's subnet (`networks: default: ipam: config: - subnet:
172.30.0.0/24` in the compose file) and set `FORWARDED_ALLOW_IPS` to that one
subnet.

nginx also throttles `/auth/login` (10/min per client, burst 5) and `/public/`
(2/s per client, burst 20), answering `429` beyond that, and writes its
access log with share tokens redacted.

### Data and backups

`DATA_PATH` must be an **absolute** path. The compose default `./data` is only
right when you run `docker compose` from a checkout; inside a Portainer stack
it resolves into Portainer's own volume — invisible in File Station, outside
Hyper Backup, and orphaned if the stack is ever recreated. Use a real shared
folder, and make it an **encrypted** one: the nightly dumps in
`${DATA_PATH}/backups` contain every user's data (names, dates, notes,
password hashes) in plain SQL. Before first start:

```bash
mkdir -p /volume1/docker/progenies/backups
chmod 700 /volume1/docker/progenies/backups
```

The `db-backup` sidecar runs `pg_dump` at 01:30 every night (gzip; keeps 7
daily, 4 weekly, 6 monthly). Point the NAS backup job at that folder for
off-machine copies. A backup that has never been restored is a guess — run a
restore drill occasionally, into a scratch database so the live one is never
touched (`<db>` is the stack's database container, e.g. `progenies-db-1`;
`docker ps` shows it):

```bash
docker exec -i <db> psql -U progenies -d postgres -c 'CREATE DATABASE restore_drill;'
zcat /volume1/docker/progenies/backups/last/genealogy-latest.sql.gz \
  | docker exec -i <db> psql -U progenies -d restore_drill -q
docker exec -i <db> psql -U progenies -d restore_drill -c 'SELECT count(*) FROM individuals;'
docker exec -i <db> psql -U progenies -d postgres -c 'DROP DATABASE restore_drill;'
```

A count that matches what the app shows is a good backup. For a real
restore, do the same into the live database name after stopping `backend`.

### Share links

Public share URLs are now `https://<host>/share#<token>` — the token sits in
the URL fragment, which browsers never send to the server, so it stays out of
access logs, referrers and proxy logs. Old `/share/<token>` links keep working:
the app redirects them to the new form on first open, and nginx redacts the
token from its log for that one request.

### Upgrading to this version

1. Set the new environment variables in the stack: `BOOTSTRAP_TOKEN` and
   `DATA_PATH` (absolute). Do NOT set `HTTP_BIND` unless you have read *Tunnel
   and client addresses* — in most setups it stays unset.
   `FORWARDED_ALLOW_IPS` can stay at its default.
2. If you are moving `DATA_PATH` from Portainer's volume to a real folder,
   copy the existing `pgdata` and `backups` directories there first (stack
   stopped), or restore the latest dump into the new location.
3. Update the stack (pull + recreate). `web` now waits for `backend` to be
   healthy, so the first page load may take a few seconds longer.
4. Expect **one re-login on every device**: the auth changes rotate refresh
   tokens, so existing sessions end.
5. On an iPad that shows the wrong theme for an instant on launch, or looks
   stale, the installed PWA is still holding the previous app shell: open the
   site in Safari, reload once, then relaunch the home-screen app. (The theme
   guard moved from inline markup to `/theme.js` so the page can ship a
   `script-src 'self'` Content-Security-Policy; a cached old shell doesn't
   have it yet.)

### ⚠️ Upgrading past 2026-08-03: the web container's port changed

The web image moved to non-root nginx, so it now listens on **8080** inside the
container instead of 80. A stack whose port mapping still ends in `:80` will
start "healthy" but reset every connection — the site goes dark with no error
in the logs.

Update the mapping's **container side** (the number after the colon); the host
port is unchanged:

```yaml
ports:
  - "${HTTP_BIND:-0.0.0.0}:${HTTP_PORT:-8080}:8080"   # was ...:80
```

Any reverse proxy or tunnel keeps pointing at the same host port. To roll back
instead, pin `IMAGE_TAG` to a commit before that date.

## Project layout

## Rebranding

The product name ("Progenies") is **not** hardcoded anywhere user-facing —
to rename the app, set two environment variables (both default to
`Progenies`):

```env
APP_NAME=YourName        # backend: API title + GEDCOM export header
VITE_APP_NAME=YourName    # frontend: page title, login header, PWA manifest
```

Set them in `.env` (Docker Compose passes both through) and restart. The brand
*color* palette is separate — edit the `brand` token in
[`frontend/tailwind.config.js`](frontend/tailwind.config.js) to recolor. The
frontend brand strings live in [`frontend/src/branding.ts`](frontend/src/branding.ts).

## Local development (without Docker)

```bash
# Backend (needs a Postgres on DATABASE_URL)
cd backend && pip install -r requirements.txt && uvicorn main:app --reload

# Frontend
cd frontend && npm install && npm run dev
```

## License

[AGPL-3.0](LICENSE) — you're free to use, modify, and self-host this software;
if you run a modified version as a network service, you must make your source
available to its users.
