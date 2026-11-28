#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2329
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export HOME="$work/home"
stubs="$work/stubs"
calls="$stubs/calls.log"
mkdir -p "$HOME" "$stubs/bin" "$stubs/loaded"
: > "$calls"
export PATH="$stubs/bin:/usr/bin:/bin"
export MILL_USER
MILL_USER="$(whoami)"
failures=0

stub() {
  printf '#!/bin/bash\necho "$(basename "$0") $*" >> %q\n%s\n' "$calls" "$2" > "$stubs/bin/$1"
  chmod +x "$stubs/bin/$1"
}

stub uname 'echo Darwin'
stub gh 'exit 0'
stub mise 'exit 0'
stub git 'if [[ $1 == clone ]]; then mkdir -p "${@: -1}/.git" "${@: -1}/agents/skills"; fi'
stub launchctl "label=\${@: -1}; label=\${label##*/}
case \$1 in
  bootstrap) touch \"$stubs/loaded/\$(basename \"\${@: -1}\" .plist)\" ;;
  print) [[ -e \"$stubs/loaded/\$label\" ]] ;;
esac"
stub curl "printf '#!/bin/bash\n'; echo 'printf \"#!/bin/bash\\nexit 0\\n\" > $stubs/bin/claude; chmod +x $stubs/bin/claude'"
stub brew "for formula in \"\${@:2}\"; do printf '#!/bin/bash\nexit 0\n' > $stubs/bin/\$formula; chmod +x $stubs/bin/\$formula; done"

expect() {
  local description="$1"
  shift
  if ! "$@"; then echo "FAIL: $description" >&2; failures=$((failures + 1)); fi
}

calls_count() { [[ "$(grep -c "$2" "$calls" || true)" == "$1" ]]; }
file_mode() { [[ "$(stat -f %Lp "$2" 2>/dev/null || stat -c %a "$2")" == "$1" ]]; }
link_points_to() { [[ "$(readlink "$1")" == "$2" ]]; }
nothing_newer_than() { [[ -z "$(find "$HOME" -newer "$1" -type f)" ]]; }
real_directory() { [[ -d "$1" && ! -L "$1" ]]; }

run_install() { "$repo/install.sh" > "$work/out.log" 2>&1; }
run_install_or_dump() { run_install || { cat "$work/out.log" >&2; exit 1; }; }

plist="$HOME/Library/LaunchAgents/me.kirhgoff.mill.plist"
tunnel_plist="$HOME/Library/LaunchAgents/me.kirhgoff.mill-tunnel.plist"
skills="$HOME/Projects/dotfiles/agents/skills"

run_install_or_dump

expect "installs cloudflared with brew" calls_count 1 "brew install cloudflared"
expect "installs codex with brew" calls_count 1 "brew install codex"
expect "installs claude through the installer script" test -x "$stubs/bin/claude"
expect "clones dotfiles" calls_count 1 "git clone git@github.com:kirhgoff/dotfiles.git"
expect "links claude skills" link_points_to "$HOME/.claude/skills" "$skills"
expect "links codex skills" link_points_to "$HOME/.codex/skills" "$skills"
expect "creates mill.env with mode 600" file_mode 600 "$HOME/.config/mill/mill.env"
expect "tunnel config routes webhooks" grep -q "hostname: hooks.kirhgoff.me" "$HOME/.cloudflared/config.yml"
expect "server agent runs serve" grep -q "<string>serve</string>" "$plist"
expect "tunnel agent runs the tunnel" grep -q "<string>tunnel</string>" "$tunnel_plist"
expect "bootstraps both agents" calls_count 2 "launchctl bootstrap"
expect "reports empty keys" grep -q "fill TELEGRAM_BOT_TOKEN" "$work/out.log"

echo "TELEGRAM_BOT_TOKEN=keep-me" > "$HOME/.config/mill/mill.env"
: > "$calls"
sleep 1
touch "$work/marker"
sleep 1
run_install_or_dump

expect "second run changes no files" nothing_newer_than "$work/marker"
expect "second run bootstraps nothing" calls_count 0 "launchctl bootstrap"
expect "second run installs nothing" calls_count 0 "brew install"
expect "second run pulls dotfiles" calls_count 1 "pull --ff-only"
expect "mill.env is never overwritten" grep -q "^TELEGRAM_BOT_TOKEN=keep-me$" "$HOME/.config/mill/mill.env"

echo "tampered" > "$plist"
: > "$calls"
run_install_or_dump
expect "rewrites a changed plist" grep -q "<string>serve</string>" "$plist"
expect "reloads a changed plist" calls_count 1 "launchctl bootstrap"

rm "$stubs/loaded/me.kirhgoff.mill-tunnel"
: > "$calls"
run_install_or_dump
expect "bootstraps an agent that is not loaded" calls_count 1 "launchctl bootstrap"

rm "$HOME/.codex/skills"
mkdir "$HOME/.codex/skills"
run_install_or_dump
expect "leaves a real skills directory alone" real_directory "$HOME/.codex/skills"
expect "reports a real skills directory" grep -q "real directory" "$work/out.log"

rm -rf "$HOME/Library"
if MILL_USER=somebody-else "$repo/install.sh" > "$work/out.log" 2>&1; then refused=no; else refused=yes; fi
expect "refuses another user" test "$refused" = yes
expect "refusing touches nothing" test ! -e "$HOME/Library"

if (( failures == 0 )); then echo "install tests passed"; fi
exit $(( failures > 0 ))
