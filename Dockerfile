FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3210 \
    DATABASE_PATH=/app/data/whatscrm.db

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node src ./src
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3210/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
