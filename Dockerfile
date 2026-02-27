# Robot Mill - Autonomous Task Processing Agent
#
# Build:
#   docker build -t robot-mill .
#
# Run:
#   docker run -it \
#     -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
#     -v $(pwd)/tasks:/app/tasks \
#     -v $(pwd)/repos:/app/repos \
#     robot-mill

FROM oven/bun:1-debian AS base

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (for pi/Claude Code compatibility)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install pi (Claude Code CLI)
# Note: Replace with actual installation method
RUN npm install -g @anthropic-ai/claude-code || true

WORKDIR /app

# Copy package files
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install

# Copy source code
COPY . .

# Make scripts executable
RUN chmod +x run-robot.sh task-cli.sh

# Git config for robot
RUN git config --global user.name "Robot" \
    && git config --global user.email "robot@robot-mill.local" \
    && git config --global init.defaultBranch main

# Create directories
RUN mkdir -p tasks .worktrees repos

# Default environment
ENV ROBOT_PROVIDER=anthropic
ENV ROBOT_MODEL=claude-sonnet-4-20250514

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD test -d /app/tasks || exit 1

# Run robot in autonomous mode by default
ENTRYPOINT ["./run-robot.sh"]
CMD ["--auto"]
