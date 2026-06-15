FROM node:24-slim

WORKDIR /app/agent

ENV NODE_ENV=production

COPY agent-server/package*.json ./agent-server/
RUN cd agent-server && npm ci --omit=dev

COPY agent-runtime ./agent-runtime
COPY agent-server ./agent-server
COPY config ./config
COPY scripts ./scripts

RUN mkdir -p /app/agent/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.AGENT_GATEWAY_PORT || '8787') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "agent-server/src/cli.mjs"]
