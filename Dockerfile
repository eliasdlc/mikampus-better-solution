FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
COPY src ./src
COPY vite.config.ts tsconfig.json ./
RUN npm run build

FROM litestream/litestream:0.3.13 AS litestream

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOST=0.0.0.0 \
    PORT=4173 \
    MIKAMPUS_DB=/data/mikampus.db \
    MIKAMPUS_ACCOUNT=/data/account.json

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npx playwright install --with-deps chromium \
  && npm cache clean --force

COPY src ./src
COPY --from=build /app/public/dist ./public/dist
COPY docker/litestream.yml /etc/litestream.yml
COPY docker/entrypoint.sh /usr/local/bin/mikampus-entrypoint
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
RUN chmod 0555 /usr/local/bin/mikampus-entrypoint \
  && mkdir -p /data

EXPOSE 4173
ENTRYPOINT ["/usr/local/bin/mikampus-entrypoint"]
