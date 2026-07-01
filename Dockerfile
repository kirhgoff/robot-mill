FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8

# ── Layer 1: System install scripts (rarely change) ───────────────────────────
COPY install/ /opt/install/
RUN chmod +x /opt/install/*.sh \
    && /opt/install/00-base.sh \
    && /opt/install/10-node.sh \
    && /opt/install/11-bun.sh \
    && /opt/install/20-mise.sh \
    && /opt/install/30-github.sh \
    && /opt/install/40-user-setup.sh \
    && /opt/install/50-entrypoint.sh \
    && rm -rf /opt/install

# ── Layer 2: Backend ──────────────────────────────────────────────────────────
COPY --chown=agent:agent robot-fastify-backend/package.json robot-fastify-backend/bun.lock* /home/agent/backend/
RUN cd /home/agent/backend && bun install --production
COPY --chown=agent:agent robot-fastify-backend/src/ /home/agent/backend/src/
COPY --chown=agent:agent robot-fastify-backend/tsconfig.json /home/agent/backend/

# ── Layer 3: Telegram frontend ────────────────────────────────────────────────
COPY --chown=agent:agent telegram-frontend/package.json telegram-frontend/bun.lock* /home/agent/telegram-frontend/
RUN cd /home/agent/telegram-frontend && bun install --production
COPY --chown=agent:agent telegram-frontend/src/ /home/agent/telegram-frontend/src/
COPY --chown=agent:agent telegram-frontend/tsconfig.json /home/agent/telegram-frontend/

# ── Layer 3b: Discord frontend ────────────────────────────────────────────────
COPY --chown=agent:agent discord-frontend/package.json discord-frontend/bun.lock* /home/agent/discord-frontend/
RUN cd /home/agent/discord-frontend && bun install --production
COPY --chown=agent:agent discord-frontend/src/ /home/agent/discord-frontend/src/
COPY --chown=agent:agent discord-frontend/tsconfig.json /home/agent/discord-frontend/

# ── Layer 3c: Web console (static, served by the backend) ─────────────────────
COPY --chown=agent:agent web-console/ /home/agent/web-console/

# ── Layer 4: Session storage directory ────────────────────────────────────────
RUN mkdir -p /data/agent-sessions && chown agent:agent /data/agent-sessions

USER agent
WORKDIR /workspace

ENTRYPOINT ["/home/agent/entrypoint.sh"]
CMD ["/bin/bash"]
