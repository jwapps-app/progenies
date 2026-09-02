# Dev image (Vite dev server with HMR; source is bind-mounted by compose).
# Same pinned base as Dockerfile.prod's build stage — see the note there.
FROM node:26-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3
# node:22-alpine as of 2026-09-02

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev"]
