FROM node:24-slim

WORKDIR /app/packages

ENV NODE_ENV=production

COPY agent-server/package*.json ./agent-server/
RUN cd agent-server && npm ci --omit=dev

COPY agent-runtime ./agent-runtime
COPY agent-server ./agent-server

RUN mkdir -p /app/agent/data

EXPOSE 8787

CMD ["node", "agent-server/src/cli.mjs"]
