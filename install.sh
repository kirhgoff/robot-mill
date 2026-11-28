#!/usr/bin/env bash
set -euo pipefail

fail() { echo "install.sh: $*" >&2; exit 1; }

[[ "$(uname)" == Darwin ]] || fail "macOS only"
mill_user="${MILL_USER:-millwright}"
[[ "$(whoami)" == "$mill_user" ]] || fail "run as $mill_user, not $(whoami)"

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
port="${MILL_PORT:-7600}"
uid="$(id -u)"
agents_dir="$HOME/Library/LaunchAgents"
logs_dir="$HOME/Library/Logs/mill"
dotfiles="$HOME/Projects/dotfiles"
skills_source="$dotfiles/agents/skills"
env_file="$HOME/.config/mill/mill.env"
pending=()
export PATH="$HOME/.local/bin:$PATH"

write_if_changed() {
  local dest="$1" tmp
  mkdir -p "$(dirname "$dest")"
  tmp="$(mktemp)"
  cat > "$tmp"
  if cmp -s "$tmp" "$dest"; then rm -f "$tmp"; return 1; fi
  cat "$tmp" > "$dest"
  rm -f "$tmp"
}

link_skills() {
  local link="$1"
  if [[ -L "$link" && "$(readlink "$link")" == "$skills_source" ]]; then return; fi
  if [[ -e "$link" && ! -L "$link" ]]; then
    pending+=("$link is a real directory; replace it with a link to $skills_source by hand")
    return
  fi
  mkdir -p "$(dirname "$link")"
  ln -sfn "$skills_source" "$link"
}

launch_agent_plist() {
  local label="$1" workdir="$2" arg
  shift 2
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
PLIST
  for arg in "$@"; do echo "    <string>$arg</string>"; done
  cat <<PLIST
  </array>
  <key>WorkingDirectory</key><string>$workdir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$logs_dir/$label.log</string>
  <key>StandardErrorPath</key><string>$logs_dir/$label.log</string>
</dict>
</plist>
PLIST
}

install_agent() {
  local label="$1" changed=0
  shift
  if launch_agent_plist "$label" "$@" | write_if_changed "$agents_dir/$label.plist"; then changed=1; fi
  if (( changed )) || ! launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$uid" "$agents_dir/$label.plist"
  fi
}

for formula in tmux gh cloudflared mise; do
  command -v "$formula" >/dev/null || brew install "$formula"
done
(cd "$repo" && mise install && mise run deps)

command -v claude >/dev/null || { curl -fsSL https://claude.ai/install.sh | bash; }
command -v codex >/dev/null || brew install codex

if [[ -d "$dotfiles/.git" ]]; then
  git -C "$dotfiles" pull --ff-only
else
  mkdir -p "$(dirname "$dotfiles")"
  GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" git clone git@github.com:kirhgoff/dotfiles.git "$dotfiles" \
    || fail "cannot clone kirhgoff/dotfiles: add $mill_user as a read collaborator and accept the invitation"
fi
link_skills "$HOME/.claude/skills"
link_skills "$HOME/.codex/skills"

if [[ ! -e "$env_file" ]]; then
  mkdir -p "$(dirname "$env_file")"
  (umask 077 && cp "$repo/mill/mill.env.example" "$env_file")
fi

write_if_changed "$HOME/.cloudflared/config.yml" <<CONFIG || true
tunnel: mill
ingress:
  - hostname: hooks.kirhgoff.me
    path: ^/(github|linear)\$
    service: http://127.0.0.1:$port
  - service: http_status:404
CONFIG

mkdir -p "$logs_dir" "$agents_dir"
install_agent me.kirhgoff.mill "$repo/mill" "$(command -v mise)" exec -- bun run src/main.ts serve
install_agent me.kirhgoff.mill-tunnel "$HOME" "$(command -v cloudflared)" tunnel run mill

claude auth status >/dev/null 2>&1 || pending+=("log in: run claude")
codex login status >/dev/null 2>&1 || pending+=("log in: run codex login")
gh auth status >/dev/null 2>&1 || pending+=("log in: run gh auth login")
while IFS= read -r key; do
  grep -qE "^$key=.+" "$env_file" || pending+=("fill $key in $env_file")
done < <(grep -oE '^[A-Z_]+=$' "$repo/mill/mill.env.example" | tr -d =)

if (( ${#pending[@]} )); then
  echo "Still to do by hand:"
  printf '  - %s\n' "${pending[@]}"
fi
