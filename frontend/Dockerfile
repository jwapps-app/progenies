# Dev image (Vite dev server with HMR; source is bind-mounted by compose).
# Same pinned base as Dockerfile.prod's build stage — see the note there.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
# node:22-alpine as of 2026-09-02

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev"]
