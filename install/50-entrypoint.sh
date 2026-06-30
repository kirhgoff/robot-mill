#!/usr/bin/env bash
# Write the container entrypoint to /home/agent/entrypoint.sh
set -euo pipefail

cat <<'ENTRYPOINT' > /home/agent/entrypoint.sh
#!/usr/bin/env bash
set -euo pipefail

# ── SSH key ────────────────────────────────────────────────────────────────────
if [ -f /run/secrets/github_ssh_key ]; then
    cp /run/secrets/github_ssh_key ~/.ssh/id_rsa
    chmod 600 ~/.ssh/id_rsa
    ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null
elif [ -n "${GITHUB_SSH_KEY:-}" ]; then
    echo "$GITHUB_SSH_KEY" > ~/.ssh/id_rsa
    chmod 600 ~/.ssh/id_rsa
    ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null
fi

# ── GitHub token ───────────────────────────────────────────────────────────────
if [ -f /run/secrets/github_token ]; then
    export GITHUB_TOKEN=$(cat /run/secrets/github_token)
fi

# Configure git to use the token for HTTPS GitHub access
if [ -n "${GITHUB_TOKEN:-}" ]; then
    git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

# ── Git identity overrides ─────────────────────────────────────────────────────
[ -n "${GIT_USER_EMAIL:-}" ] && git config --global user.email "$GIT_USER_EMAIL"
[ -n "${GIT_USER_NAME:-}" ]  && git config --global user.name  "$GIT_USER_NAME"

exec "$@"
ENTRYPOINT

chmod +x /home/agent/entrypoint.sh
chown agent:agent /home/agent/entrypoint.sh
