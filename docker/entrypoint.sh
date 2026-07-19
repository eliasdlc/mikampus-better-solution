#!/bin/sh
set -eu

mkdir -p "$(dirname "$MIKAMPUS_DB")"

# Litestream necesita que SQLite exista antes de empezar a observar su WAL.
# Importar db.js inicializa el esquema idempotente sin abrir Playwright.
if [ ! -f "$MIKAMPUS_DB" ]; then
  node --input-type=module -e "await import('./src/db.js')"
fi

if [ "${LITESTREAM_ENABLED:-false}" = "true" ]; then
  : "${LITESTREAM_BUCKET:?Falta LITESTREAM_BUCKET}"
  : "${LITESTREAM_ENDPOINT:?Falta LITESTREAM_ENDPOINT}"
  : "${LITESTREAM_ACCESS_KEY_ID:?Falta LITESTREAM_ACCESS_KEY_ID}"
  : "${LITESTREAM_SECRET_ACCESS_KEY:?Falta LITESTREAM_SECRET_ACCESS_KEY}"
  : "${LITESTREAM_AGE_RECIPIENT:?Falta LITESTREAM_AGE_RECIPIENT}"
  exec litestream replicate -config /etc/litestream.yml -exec "node src/server.js"
fi

exec node src/server.js
