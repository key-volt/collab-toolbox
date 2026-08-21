# syntax=docker/dockerfile:1

FROM node:22-slim AS web
WORKDIR /build
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# Used only as a source of static assets; nothing from it runs.
FROM jgraph/drawio:29.7.9 AS drawio

FROM python:3.12-slim-bookworm AS final

COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /usr/local/bin/uv

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/app/.venv/bin:$PATH \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends supervisor gosu curl ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --gid 1000 app; \
    useradd --uid 1000 --gid 1000 --home-dir /app --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app/backend
COPY backend/pyproject.toml ./
RUN uv venv /app/.venv && uv pip install --python /app/.venv/bin/python -r pyproject.toml
COPY backend/app ./app
COPY backend/alembic.ini ./alembic.ini
COPY backend/alembic ./alembic

COPY --from=caddy:2.11.4 /usr/bin/caddy                /usr/bin/caddy
COPY --from=web          /build/dist                   /app/web
COPY --from=drawio       /usr/local/tomcat/webapps/draw /app/vendor/drawio

# The editor page is served from /drawio/ so its relative asset paths resolve against
# the pinned draw.io files beside it; its own bundle loads from the web root.
COPY --from=web /build/dist/editor.html /app/vendor/drawio/editor.html

COPY deploy/Caddyfile        /etc/caddy/Caddyfile
COPY deploy/supervisord.conf /etc/supervisord.conf
COPY deploy/entrypoint.sh    /usr/local/bin/entrypoint.sh
COPY deploy/healthcheck.sh   /usr/local/bin/healthcheck.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

EXPOSE 8080 8443

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD ["/usr/local/bin/healthcheck.sh"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]
