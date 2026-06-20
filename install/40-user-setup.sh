#!/usr/bin/env bash
# Create the 'agent' user with workspace and SSH directory
set -euo pipefail

useradd -m -s /bin/bash agent
echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Shared workspace mounted at runtime
mkdir -p /workspace
chown agent:agent /workspace

# Git identity (overridable via env at runtime)
runuser -u agent -- git config --global user.email "${GIT_USER_EMAIL:-agent@robot-home}"
runuser -u agent -- git config --global user.name "${GIT_USER_NAME:-Pi Agent}"
runuser -u agent -- git config --global init.defaultBranch main

# SSH directory for GitHub key
runuser -u agent -- mkdir -p /home/agent/.ssh
runuser -u agent -- chmod 700 /home/agent/.ssh
