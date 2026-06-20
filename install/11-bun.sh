#!/usr/bin/env bash
# Install Bun runtime to a shared location accessible by all users
set -euo pipefail

export BUN_INSTALL=/usr/local
curl -fsSL https://bun.sh/install | bash

# Verify installation
bun --version
