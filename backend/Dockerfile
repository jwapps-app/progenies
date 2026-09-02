# Pinned by manifest-list digest (the multi-arch index, so amd64 and arm64
# builds both resolve): a tag can be re-pointed upstream at any time, a digest
# cannot. Dependabot (.github/dependabot.yml) proposes the bumps; the trailing
# comment records what the digest was when pinned.
FROM python:3.11-slim@sha256:9534e5a8e315485d4061ed659af0fd78a284c015f9b73661b41d6bab25604534
# python:3.11-slim as of 2026-09-02

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# requirements.txt is generated from requirements.in with per-file hashes
# (see the header of requirements.in). --require-hashes makes pip refuse any
# artifact whose hash isn't listed — a package index or mirror that serves a
# tampered wheel fails the build instead of shipping.
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

# Run as an unprivileged user, not root — a code-exec bug in the app can't then
# tamper with the image or escalate on the host.
RUN useradd --system --create-home --uid 10001 appuser

# Deliberately root-owned (no --chown): the application directory must not be
# writable by the user the application runs as, so a compromised process can't
# rewrite its own code. Nothing here needs write access — bytecode writing is
# off (PYTHONDONTWRITEBYTECODE) and uploads spool to /tmp, which the compose
# stack mounts as tmpfs.
COPY . .

USER appuser

EXPOSE 8000

# Two workers: one long visualization/export request can no longer block every
# other request (auth, saves) — plenty for a self-hosted single-family instance.
# --limit-concurrency 64: past 64 in-flight connections per worker, new ones
# get an immediate 503 instead of piling up until the container runs out of
# memory or file descriptors. Forwarded headers (X-Forwarded-For/Proto from
# nginx) are only honoured from the sources in $FORWARDED_ALLOW_IPS, which the
# compose file sets to the Docker-side ranges.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--limit-concurrency", "64"]
