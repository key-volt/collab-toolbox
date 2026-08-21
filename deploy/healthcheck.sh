#!/bin/sh
# Checks the service the way a client reaches it: through the web server, not around it.
set -eu

if [ "${TLS_MODE:-acme}" = "off" ]; then
	exec curl -fsS -o /dev/null "http://127.0.0.1:8080/api/health"
fi

exec curl -fsS -k -o /dev/null \
	--resolve "${DOMAIN}:8443:127.0.0.1" \
	"https://${DOMAIN}:8443/api/health"
