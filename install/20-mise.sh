#!/usr/bin/env bash
# mise — per-project language version manager
# Projects that declare .mise.toml or .tool-versions will have their
# runtimes (Python, Ruby, Go, Java, etc.) automatically installed by pi.
set -euo pipefail

curl -fsSL https://mise.jdx.dev/install.sh \
    | MISE_INSTALL_PATH=/usr/local/bin/mise sh

# Activate mise for all login shells system-wide
echo 'eval "$(mise activate bash)"' >> /etc/bash.bashrc
echo 'eval "$(mise activate bash)"' >> /etc/profile
