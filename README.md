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
