#!/usr/bin/env bash
# System packages: essentials, build tools, locale, sudo
set -euo pipefail

apt-get update
apt-get install -y \
    git git-lfs openssh-client \
    build-essential \
    curl wget unzip zip \
    htop tmux jq nano vim \
    ca-certificates locales sudo
rm -rf /var/lib/apt/lists/*

locale-gen en_US.UTF-8
