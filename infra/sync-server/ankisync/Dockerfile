# Official Anki sync server (python -m anki.syncserver) for the H110 (docs/planos/fase-9a.md). Same pinned version
# as the app (spec A.1: 26.9.3) and as compose.dev.yml; changing it is a recorded decision (docs/decisoes.md).
FROM python:3.12-slim-bookworm

ARG ANKI_VERSION=26.9.3
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SYNC_BASE=/data \
    SYNC_HOST=0.0.0.0 \
    SYNC_PORT=8080

RUN pip install --no-cache-dir "anki==${ANKI_VERSION}" \
    && find /usr/local/lib/python3.12 -name '__pycache__' -prune -exec rm -rf {} + \
    && useradd --uid 1000 --create-home --shell /usr/sbin/nologin anki \
    && mkdir -p /data \
    && chown anki:anki /data

USER anki
WORKDIR /home/anki
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=10 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2).status == 200 else 1)"]
CMD ["python", "-m", "anki.syncserver"]
