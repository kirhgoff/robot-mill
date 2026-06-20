#!/usr/bin/env bash
# Node.js 22 LTS + pi coding agent (global)
set -euo pipefail

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
rm -rf /var/lib/apt/lists/*

npm install -g @mariozechner/pi-coding-agent
