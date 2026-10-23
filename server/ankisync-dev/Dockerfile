# Official Anki sync server (python -m anki.syncserver) at the app's pinned Anki version, for LOCAL TESTS ONLY.
# See docs/tecnico/anki-sync-dev.md. Built by compose.dev.yml (service ankisync-dev).
FROM python:3.12-slim-bookworm

ARG ANKI_VERSION=26.9.3
LABEL org.opencontainers.image.title="leitor-ankisync-dev" \
      org.opencontainers.image.description="Official Anki sync server, local test use only" \
      org.opencontainers.image.version="${ANKI_VERSION}" \
      io.leitor.anki.version="${ANKI_VERSION}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SYNC_BASE=/data \
    SYNC_HOST=0.0.0.0 \
    SYNC_PORT=8080 \
    ANKI_VERSION=${ANKI_VERSION}

RUN pip install --no-cache-dir "anki==${ANKI_VERSION}" \
    && find /usr/local/lib/python3.12 -name '__pycache__' -prune -exec rm -rf {} + \
    && useradd --uid 1000 --create-home --shell /usr/sbin/nologin anki \
    && mkdir -p /data /opt/ankisync \
    && chown anki:anki /data

COPY --chmod=0755 pyclient.py /opt/ankisync/pyclient.py

USER anki
WORKDIR /home/anki
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=2s --timeout=3s --start-period=20s --retries=15 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2).status == 200 else 1)"]

CMD ["python", "-m", "anki.syncserver"]
