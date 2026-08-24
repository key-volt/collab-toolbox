# collab-toolbox

Self-hosted collaboration toolbox: shared diagrams (draw.io), whiteboards
(Excalidraw) and code projects with an in-browser Python/JS sandbox terminal —
one container, one data folder.

## Install

On a Debian/Ubuntu server with docker compose (and curl) installed, run:

```sh
sudo mkdir -p /opt/collab-toolbox && cd /opt/collab-toolbox \
  && sudo curl -fsSLO https://raw.githubusercontent.com/key-volt/collab-toolbox/main/deploy/setup.sh \
  && sudo chmod +x setup.sh && sudo ./setup.sh
```

This downloads only the installer script, nothing else. It asks for the image
repository and tag, the mode (HTTPS with built-in certificates, your own
certificate, or plain HTTP behind your reverse proxy), ports, the admin
account, and the system account that owns the data; writes
`docker-compose.yml`, `.env` and the secret files; then offers to start the
stack. `sudo ./setup.sh --help` lists the flags for non-interactive use.

When it is up, open the site and sign in as the administrator.

Everything lives in `/opt/collab-toolbox`: `.env` (settings — `IMAGE` is the
image repository and tag you deploy), `secrets/` (admin password, JWT key),
`data/` (all documents — back this folder up), `certs/` (only for a custom
certificate). Re-running the installer reconfigures; it keeps existing data,
secrets and `.env` unless told otherwise.

## Update

```sh
cd /opt/collab-toolbox && sudo ./setup.sh update
```

Stops the container, removes the old image, pulls the tag named in `.env` and
starts fresh. Data and settings are untouched.
