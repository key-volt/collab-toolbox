#!/bin/sh
# Runs as root, prepares the mounted volume and the database, then hands off.
# Anything that fails here stops the container rather than letting it serve.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
TLS_MODE="${TLS_MODE:-acme}"
DOMAIN="${DOMAIN:-localhost}"
DATA_DIR="${DATA_DIR:-/data}"

# Caddy reads SITE_ADDRESS. An address carrying an explicit http:// scheme turns off
# certificate management for that site, which is what makes the plain-HTTP mode work.
case "$TLS_MODE" in
acme)
	if [ "$DOMAIN" = "localhost" ]; then
		echo "entrypoint: TLS_MODE=acme needs DOMAIN set to a public hostname" >&2
		exit 1
	fi
	if [ -z "${ACME_EMAIL:-}" ]; then
		echo "entrypoint: TLS_MODE=acme needs ACME_EMAIL set" >&2
		exit 1
	fi
	SITE_ADDRESS="$DOMAIN"
	;;
custom)
	if [ ! -f /certs/cert.pem ] || [ ! -f /certs/key.pem ]; then
		echo "entrypoint: TLS_MODE=custom needs cert.pem and key.pem in the mounted /certs" >&2
		exit 1
	fi
	if [ "$DOMAIN" = "localhost" ]; then
		SITE_ADDRESS="https://:8443"
	else
		SITE_ADDRESS="$DOMAIN"
	fi
	;;
off)
	SITE_ADDRESS="http://:8080"
	;;
*)
	echo "entrypoint: TLS_MODE must be 'acme', 'custom' or 'off', got '$TLS_MODE'" >&2
	exit 1
	;;
esac
export SITE_ADDRESS

# The Caddyfile imports this file; only the custom mode puts a directive in it.
if [ "$TLS_MODE" = "custom" ]; then
	printf 'tls /certs/cert.pem /certs/key.pem\n' >/run/caddy-tls.conf
else
	: >/run/caddy-tls.conf
fi
chmod 644 /run/caddy-tls.conf

# Match the service account to the owner of the mount, so files written inside the
# container are readable and writable on the host.
if [ "$(getent group app | cut -d: -f3)" != "$PGID" ]; then
	groupmod -o -g "$PGID" app
fi
if [ "$(id -u app)" != "$PUID" ]; then
	usermod -o -u "$PUID" app
fi

mkdir -p \
	"$DATA_DIR/docs/.trash" \
	"$DATA_DIR/uploads" \
	"$DATA_DIR/backups" \
	"$DATA_DIR/caddy/data" \
	"$DATA_DIR/caddy/config"

if [ "$(stat -c %u "$DATA_DIR")" != "$PUID" ] || [ "$(stat -c %g "$DATA_DIR")" != "$PGID" ]; then
	# Ownership changed, or this is a first run against a foreign directory.
	chown -R "$PUID:$PGID" "$DATA_DIR"
else
	chown "$PUID:$PGID" \
		"$DATA_DIR/docs" \
		"$DATA_DIR/docs/.trash" \
		"$DATA_DIR/uploads" \
		"$DATA_DIR/backups" \
		"$DATA_DIR/caddy" \
		"$DATA_DIR/caddy/data" \
		"$DATA_DIR/caddy/config"
fi

cd /app/backend
gosu app /app/.venv/bin/python -m app.boot

exec "$@"
