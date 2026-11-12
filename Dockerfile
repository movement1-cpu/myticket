# MyTicket production image. Data (SQLite database, uploads, backups) lives in the /data volume.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/myticket.db \
    UPLOAD_DIR=/data/uploads \
    BACKUP_DIR=/data/backups

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY web ./web

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
