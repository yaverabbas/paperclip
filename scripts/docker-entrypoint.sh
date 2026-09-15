#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Without root we can neither remap the node user (usermod/groupmod/chown)
# nor switch users (gosu needs CAP_SETUID/CAP_SETGID), so exec directly.
# This covers Kubernetes restricted PodSecurity (runAsNonRoot + runAsUser)
# as well as platforms that assign arbitrary UIDs (e.g. OpenShift); for the
# latter a UID/GID mismatch is unfixable here, so warn instead of letting
# usermod fail cryptically and keep volume-permission issues diagnosable.
if [ "$(id -u)" -ne 0 ]; then
    if [ "$(id -u)" -ne "$PUID" ] || [ "$(id -g)" -ne "$PGID" ]; then
        echo "docker-entrypoint.sh: running unprivileged as $(id -u):$(id -g); cannot remap to requested ${PUID}:${PGID}" >&2
    fi
    exec "$@"
fi

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R node:node /paperclip
fi

# Coolify persists the Paperclip instance under /app, while the shared Codex
# home is recreated with each container. Restore an existing subscription login
# before Paperclip seeds the managed per-company homes.
if [ ! -f /paperclip/.codex/auth.json ]; then
    persisted_codex_auth=$(find /app/.paperclip/instances -path '*/companies/*/codex-home/.codex/auth.json' -type f -print -quit 2>/dev/null || true)
    if [ -n "$persisted_codex_auth" ]; then
        mkdir -p /paperclip/.codex
        cp "$persisted_codex_auth" /paperclip/.codex/auth.json
        chown node:node /paperclip/.codex/auth.json
        chmod 600 /paperclip/.codex/auth.json
    fi
fi

exec gosu node "$@"
