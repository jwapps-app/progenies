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

`docker-compose.prod.yml` runs the published images. Set `SECRET_KEY` and
`POSTGRES_PASSWORD`; `HTTP_PORT` chooses the host port (default 8080).

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
