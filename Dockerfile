FROM oven/bun:1.3.8

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lockb tsconfig.json .prettierrc.json .gitignore ./
COPY packages ./packages
COPY apps ./apps

RUN bun install --frozen-lockfile

ENV TASK_DIR=/data/tasks
ENV WORKSPACES_DIR=/data/workspaces
ENV ROBOT_ID=runner-1
ENV SLEEP_MS=2000

CMD ["bun", "apps/runner/src/main.ts"]
