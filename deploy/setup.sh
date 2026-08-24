#!/bin/sh
# collab-toolbox installer. Writes docker-compose.yml, .env and the secret files
# beside itself, prepares the data folders and the service account, then offers
# to start the stack. Safe to re-run: existing data, secrets and settings are
# kept unless explicitly replaced, and ./data is never touched.
#
#   setup.sh                  interactive install/reconfigure (flags optional)
#   setup.sh update           replace the container with a freshly pulled image
#   setup.sh print-compose    print the docker-compose.yml this script installs
set -eu

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
trap 'stty echo 2>/dev/null || true' EXIT INT TERM

usage() {
	cat <<'USAGE'
Usage: setup.sh [options]
       setup.sh update [--yes]
       setup.sh print-compose

Options (anything omitted is asked interactively):
  --image REF          image repository and tag to deploy
  --mode MODE          https: built-in certificates (default)
                       custom: your own certificate
                       http: plain HTTP behind your own reverse proxy
  --domain NAME        public hostname (required for https, optional for custom)
  --email ADDRESS      certificate contact address (https mode)
  --cert FILE          certificate for custom mode (copied to certs/cert.pem)
  --key FILE           private key for custom mode (copied to certs/key.pem)
  --bind ADDRESS       publish address (default 0.0.0.0; http mode 127.0.0.1)
  --http-port N        published HTTP port (default 80; http mode 8080)
  --https-port N       published HTTPS port (default 443)
  --admin-user NAME    administrator login (default admin)
  --admin-password PW  administrator password (asked hidden when omitted)
  --user NAME          system account that owns the data (created if missing,
                       without a home directory or a login shell)
  --uid N --gid N      use an existing uid/gid instead of an account name
  --yes                accept defaults, keep existing files, start without asking
USAGE
}

fail() {
	printf 'setup: %s\n' "$1" >&2
	exit 1
}

need2() {
	[ "$1" -ge 2 ] || fail "$2 needs a value"
}

confirm() {
	# confirm "question" default(y|n); with --yes the default is taken silently.
	if [ "$ASSUME_YES" = 1 ]; then
		[ "$2" = y ]
		return
	fi
	if [ "$2" = y ]; then hint='[Y/n]'; else hint='[y/N]'; fi
	printf '%s %s ' "$1" "$hint"
	read -r answer || answer=''
	case "$answer" in
	'') [ "$2" = y ] ;;
	y | Y | yes | YES) true ;;
	*) false ;;
	esac
}

ask() {
	# ask "question" "default" -> REPLY
	if [ "$ASSUME_YES" = 1 ]; then
		[ -n "$2" ] || fail 'a required answer is missing - pass it as a flag when using --yes'
		REPLY=$2
		return
	fi
	if [ -n "$2" ]; then
		printf '%s [%s] ' "$1" "$2"
	else
		printf '%s ' "$1"
	fi
	read -r REPLY || REPLY=''
	[ -n "$REPLY" ] || REPLY=$2
}

ask_secret() {
	# ask_secret "prompt" -> REPLY, input hidden and asked twice.
	[ "$ASSUME_YES" = 0 ] || fail '--yes needs --admin-password'
	while :; do
		printf '%s ' "$1"
		stty -echo
		read -r first || first=''
		stty echo
		printf '\n%s (again) ' "$1"
		stty -echo
		read -r second || second=''
		stty echo
		printf '\n'
		if [ -z "$first" ]; then
			printf 'setup: empty input, try again\n' >&2
		elif [ "$first" = "$second" ]; then
			REPLY=$first
			return
		else
			printf 'setup: inputs differ, try again\n' >&2
		fi
	done
}

numeric() {
	case "$2" in '' | *[!0-9]*) fail "$1 must be a number, got '$2'" ;; esac
}

random_hex() {
	if command -v openssl >/dev/null 2>&1; then
		openssl rand -hex 32
	else
		od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
		printf '\n'
	fi
}

print_compose() {
	cat <<'COMPOSE'
name: collab-toolbox

services:
  app:
    image: ${IMAGE}
    container_name: collab_tools
    restart: unless-stopped
    ports:
      # Host side comes from .env; the container side is fixed. Loopback by default, so
      # nothing is reachable from outside this machine until .env opens it up.
      - "${BIND_ADDR:-127.0.0.1}:${HTTP_PORT:-8080}:8080"
      # HTTPS, only when this container terminates TLS itself (TLS_MODE=acme or custom):
      # uncomment and set BIND_ADDR=0.0.0.0, HTTP_PORT=80, HTTPS_PORT=443. Behind a proxy
      # that terminates TLS, nothing listens on 8443 and this line stays commented.
      # - "${BIND_ADDR:-127.0.0.1}:${HTTPS_PORT:-8443}:8443"
    env_file: [.env]
    volumes:
      - ./data:/data
      # Read only in TLS_MODE=custom (cert.pem + key.pem); keep the folder present.
      - ./certs:/certs:ro
    secrets:
      - admin_password
      - jwt_secret

secrets:
  admin_password:
    file: ./secrets/admin_password
  jwt_secret:
    file: ./secrets/jwt_secret
COMPOSE
}

ensure_account() {
	case "$1" in
	'' | *[!a-zA-Z0-9_-]*) fail "account name '$1' has characters useradd refuses" ;;
	esac
	if id "$1" >/dev/null 2>&1; then
		printf 'setup: using existing account %s\n' "$1"
	else
		shell=/usr/sbin/nologin
		[ -x "$shell" ] || shell=/sbin/nologin
		[ -x "$shell" ] || shell=/bin/false
		useradd --system --no-create-home --shell "$shell" "$1" 2>/dev/null ||
			adduser -S -H -s "$shell" "$1" 2>/dev/null ||
			fail "could not create account '$1'"
		printf 'setup: created system account %s (no home directory, no login)\n' "$1"
	fi
	PUID=$(id -u "$1")
	PGID=$(id -g "$1")
}

write_compose() {
	# $1 is 'tls' when the container terminates TLS itself and needs the HTTPS
	# port published.
	print_compose >compose.tmp
	if [ "$1" = tls ]; then
		sed 's/^      # - "/      - "/' compose.tmp >compose.tmp2
		mv compose.tmp2 compose.tmp
	fi
	if [ -f docker-compose.yml ] && ! cmp -s compose.tmp docker-compose.yml; then
		if ! confirm 'docker-compose.yml differs from what this run writes - replace it?' y; then
			rm -f compose.tmp
			printf 'setup: kept the existing docker-compose.yml\n'
			return
		fi
	fi
	mv compose.tmp docker-compose.yml
}

run_update() {
	cd "$SELF_DIR"
	[ -f .env ] && [ -f docker-compose.yml ] || fail 'no deployment here - run setup.sh first'
	image_ref=$(sed -n 's/^IMAGE=//p' .env)
	[ -n "$image_ref" ] || fail 'IMAGE is not set in .env'
	confirm "Stop the service, remove the old image, pull $image_ref and start it again? Open sessions reconnect." y ||
		exit 0
	docker compose down
	docker image rm "$image_ref" 2>/dev/null || true
	docker compose pull
	docker compose up -d
	printf 'setup: updated and started; data and settings untouched\n'
}

run_install() {
	[ "$(id -u)" -eq 0 ] || fail 'run as root (it creates the service account and sets ownership)'
	command -v docker >/dev/null 2>&1 || fail 'docker is not installed'
	docker compose version >/dev/null 2>&1 || fail 'the docker compose plugin is not installed'
	cd "$SELF_DIR"
	umask 077

	use_existing_env=0
	if [ -f .env ]; then
		if confirm 'Found an existing .env - keep it? (answering n rewrites it from your answers)' y; then
			use_existing_env=1
			printf 'setup: keeping .env\n'
		fi
	fi

	if [ "$use_existing_env" = 1 ]; then
		PUID=$(sed -n 's/^PUID=//p' .env)
		PGID=$(sed -n 's/^PGID=//p' .env)
		[ -n "$PUID" ] && [ -n "$PGID" ] || fail '.env has no PUID/PGID'
		tls_mode=$(sed -n 's/^TLS_MODE=//p' .env)
		case "$tls_mode" in acme | custom) compose_kind=tls ;; *) compose_kind=plain ;; esac
		[ -z "$RUN_USER$RUN_UID$RUN_GID" ] ||
			printf 'setup: keeping .env, so the account flags are ignored\n'
	else
		while [ -z "$IMAGE_REF" ]; do
			ask 'Image repository and tag to deploy (from your registry):' ''
			IMAGE_REF=$REPLY
		done

		if [ -z "$MODE" ]; then
			ask 'Mode - https (built-in certificates), custom (your certificate), http (behind your proxy):' https
			MODE=$REPLY
		fi
		case "$MODE" in
		https)
			tls_mode=acme
			compose_kind=tls
			[ -n "$DOMAIN" ] || { ask 'Public hostname (certificates are issued for it):' ''; DOMAIN=$REPLY; }
			[ -n "$DOMAIN" ] || fail 'https mode needs a hostname'
			[ -n "$ACME_EMAIL" ] || { ask 'Contact address for the certificate authority:' ''; ACME_EMAIL=$REPLY; }
			[ -n "$ACME_EMAIL" ] || fail 'https mode needs a contact address'
			;;
		custom)
			tls_mode=custom
			compose_kind=tls
			[ -n "$CERT_FILE" ] || { ask 'Path to the certificate file:' ''; CERT_FILE=$REPLY; }
			[ -f "$CERT_FILE" ] || fail "certificate not found: '$CERT_FILE'"
			[ -n "$KEY_FILE" ] || { ask 'Path to the private key file:' ''; KEY_FILE=$REPLY; }
			[ -f "$KEY_FILE" ] || fail "key not found: '$KEY_FILE'"
			# The hostname is optional here (empty serves any name), so it is only
			# ever asked interactively.
			if [ -z "$DOMAIN" ] && [ "$ASSUME_YES" = 0 ]; then
				ask 'Hostname to serve (empty serves any name):' ''
				DOMAIN=$REPLY
			fi
			;;
		http)
			tls_mode=off
			compose_kind=plain
			;;
		*)
			fail "mode must be https, custom or http, got '$MODE'"
			;;
		esac

		if [ "$MODE" = http ]; then
			default_bind=127.0.0.1 default_http=8080
		else
			default_bind=0.0.0.0 default_http=80
		fi
		[ -n "$BIND_ADDR" ] || { ask 'Publish address:' "$default_bind"; BIND_ADDR=$REPLY; }
		[ -n "$HTTP_PORT" ] || { ask 'HTTP port:' "$default_http"; HTTP_PORT=$REPLY; }
		numeric 'the HTTP port' "$HTTP_PORT"
		if [ "$MODE" = http ]; then
			HTTPS_PORT=${HTTPS_PORT:-8443}
		else
			[ -n "$HTTPS_PORT" ] || { ask 'HTTPS port:' 443; HTTPS_PORT=$REPLY; }
		fi
		numeric 'the HTTPS port' "$HTTPS_PORT"

		[ -n "$ADMIN_USER" ] || { ask 'Administrator login name:' admin; ADMIN_USER=$REPLY; }

		if [ -n "$RUN_UID" ] || [ -n "$RUN_GID" ]; then
			[ -n "$RUN_UID" ] && [ -n "$RUN_GID" ] || fail '--uid and --gid go together'
			PUID=$RUN_UID
			PGID=$RUN_GID
		elif [ -n "$RUN_USER" ]; then
			ensure_account "$RUN_USER"
		else
			ask 'Data owner - 1: create/use a system account, 2: an existing uid/gid:' 1
			if [ "$REPLY" = 2 ]; then
				ask 'uid:' ''
				PUID=$REPLY
				ask 'gid:' ''
				PGID=$REPLY
			else
				ask 'Account name:' collab-toolbox
				ensure_account "$REPLY"
			fi
		fi
		numeric 'the uid' "$PUID"
		numeric 'the gid' "$PGID"

		cat >.env <<ENV
# Written by setup.sh. Edit and restart the container, or run setup.sh again.
IMAGE=$IMAGE_REF
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
TLS_MODE=$tls_mode
BIND_ADDR=$BIND_ADDR
HTTP_PORT=$HTTP_PORT
HTTPS_PORT=$HTTPS_PORT
ADMIN_USERNAME=$ADMIN_USER
AUTOSAVE_SECONDS=10
ACCESS_TTL=600
REFRESH_TTL=2592000
VERSIONS_KEEP=50
VERSIONS_DAYS=30
TRASH_DAYS=30
BACKUP_INTERVAL_HOURS=24
BACKUP_KEEP=14
UPLOAD_MAX_MB=25
REGISTRATION_ENABLED=true
REGISTRATION_PENDING_MAX=20
CODE_MAX_FILES=200
CODE_MAX_FILE_KB=512
CODE_MAX_PROJECT_MB=20
PUID=$PUID
PGID=$PGID
TZ=UTC
ENV
		printf 'setup: wrote .env\n'
	fi

	mkdir -p secrets certs
	if [ -f secrets/jwt_secret ]; then
		printf 'setup: keeping the existing JWT secret (replacing it would end every session)\n'
	else
		random_hex >secrets/jwt_secret
		printf 'setup: created secrets/jwt_secret\n'
	fi
	if [ -f secrets/admin_password ]; then
		if [ -n "$ADMIN_PASSWORD" ] || confirm 'An administrator password already exists - replace it?' n; then
			[ -n "$ADMIN_PASSWORD" ] || { ask_secret 'New administrator password:'; ADMIN_PASSWORD=$REPLY; }
			printf '%s\n' "$ADMIN_PASSWORD" >secrets/admin_password
			printf 'setup: replaced secrets/admin_password\n'
		fi
	else
		[ -n "$ADMIN_PASSWORD" ] || { ask_secret 'Administrator password:'; ADMIN_PASSWORD=$REPLY; }
		printf '%s\n' "$ADMIN_PASSWORD" >secrets/admin_password
		printf 'setup: created secrets/admin_password\n'
	fi
	chown "$PUID:$PGID" secrets secrets/jwt_secret secrets/admin_password certs
	chmod 700 secrets certs
	chmod 600 secrets/jwt_secret secrets/admin_password

	if [ "$use_existing_env" = 0 ] && [ "$MODE" = custom ]; then
		cp "$CERT_FILE" certs/cert.pem
		cp "$KEY_FILE" certs/key.pem
		chown "$PUID:$PGID" certs/cert.pem certs/key.pem
		chmod 600 certs/cert.pem certs/key.pem
		printf 'setup: copied the certificate pair into certs/\n'
	fi

	if [ ! -d data ]; then
		mkdir data
		chown "$PUID:$PGID" data
		chmod 700 data
	elif [ "$(stat -c %u data)" != "$PUID" ]; then
		printf 'setup: ./data exists with another owner - the container adopts it on first start\n'
	fi

	write_compose "$compose_kind"

	if confirm 'Pull the image and start now?' y; then
		docker compose pull
		docker compose up -d
		printf 'setup: started - open the site and sign in as the administrator\n'
	else
		printf 'setup: ready - start later with: docker compose up -d\n'
	fi
}

CMD=install
IMAGE_REF='' MODE='' DOMAIN='' ACME_EMAIL='' CERT_FILE='' KEY_FILE=''
BIND_ADDR='' HTTP_PORT='' HTTPS_PORT='' ADMIN_USER='' ADMIN_PASSWORD=''
RUN_USER='' RUN_UID='' RUN_GID='' ASSUME_YES=0

while [ $# -gt 0 ]; do
	case "$1" in
	update | print-compose) CMD=$1 ;;
	--image) need2 $# "$1"; IMAGE_REF=$2; shift ;;
	--mode) need2 $# "$1"; MODE=$2; shift ;;
	--domain) need2 $# "$1"; DOMAIN=$2; shift ;;
	--email) need2 $# "$1"; ACME_EMAIL=$2; shift ;;
	--cert) need2 $# "$1"; CERT_FILE=$2; shift ;;
	--key) need2 $# "$1"; KEY_FILE=$2; shift ;;
	--bind) need2 $# "$1"; BIND_ADDR=$2; shift ;;
	--http-port) need2 $# "$1"; HTTP_PORT=$2; shift ;;
	--https-port) need2 $# "$1"; HTTPS_PORT=$2; shift ;;
	--admin-user) need2 $# "$1"; ADMIN_USER=$2; shift ;;
	--admin-password) need2 $# "$1"; ADMIN_PASSWORD=$2; shift ;;
	--user) need2 $# "$1"; RUN_USER=$2; shift ;;
	--uid) need2 $# "$1"; RUN_UID=$2; shift ;;
	--gid) need2 $# "$1"; RUN_GID=$2; shift ;;
	--yes) ASSUME_YES=1 ;;
	-h | --help | help)
		usage
		exit 0
		;;
	*)
		usage >&2
		fail "unknown argument '$1'"
		;;
	esac
	shift
done

case "$CMD" in
update) run_update ;;
print-compose) print_compose ;;
install) run_install ;;
esac
