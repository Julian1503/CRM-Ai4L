#!/bin/sh
# Selects the process role: `api` (default) or `worker`. Anything else is executed as-is.
set -eu

case "${1:-api}" in
  api)
    export ENGINE_ROLE=api
    exec uvicorn app.main:create_app --factory --host 0.0.0.0 --port "${PORT:-8000}" --no-access-log
    ;;
  worker)
    export ENGINE_ROLE=worker
    exec python -m app.worker
    ;;
  *)
    exec "$@"
    ;;
esac
