# AI4L content engine — one image, two entrypoints:
#   docker run IMAGE api      → FastAPI (health + OAuth exchange) on $PORT (default 8000)
#   docker run IMAGE worker   → job worker (claims from the CRM, no inbound port)
#
# Python 3.14: the version the service is developed and tested with (local 3.14.4).
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000

WORKDIR /app

RUN groupadd --system engine && useradd --system --gid engine --home-dir /app --shell /usr/sbin/nologin engine

COPY pyproject.toml ./
COPY app ./app
RUN pip install . && chown -R engine:engine /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

USER engine

EXPOSE 8000

# The api role answers /health. The worker has no HTTP server; it runs as PID 1 (exec),
# so its check passes while PID 1 is the worker, and the container exits — and the
# platform restarts it — when the worker stops.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import os,sys,urllib.request; cmd=open('/proc/1/cmdline','rb').read(); sys.exit(0) if b'app.worker' in cmd else urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','8000'), timeout=4)"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["api"]
