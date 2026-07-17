FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Run as an unprivileged user, not root — a code-exec bug in the app can't then
# tamper with the image or escalate on the host. Created BEFORE the source copy
# so COPY can set ownership directly; a post-copy `chown -R` would duplicate
# the whole app layer on every code change.
RUN useradd --system --create-home --uid 10001 appuser

COPY --chown=10001:10001 . .

USER appuser

EXPOSE 8000

# Two workers: one long visualization/export request can no longer block every
# other request (auth, saves) — plenty for a self-hosted single-family instance.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
