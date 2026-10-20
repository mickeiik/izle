# syntax=docker/dockerfile:1
# izle-server image, built with the same package a release ships; usage: docs/deploy/self-hosting.md (Docker).

FROM node:26-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY contract/package.json contract/
COPY server/package.json server/
RUN npm ci --no-audit --no-fund
COPY . .
RUN node scripts/pack-server.mjs --out /out

FROM node:26-slim
RUN --mount=from=build,source=/out,target=/out \
    npm install --global --prefix /opt/izle --offline --no-audit --no-fund /out/izle-server-*.tgz \
    && mkdir -p /etc/izle /var/lib/izle \
    && chown node:node /var/lib/izle \
    && chmod 0700 /var/lib/izle
# Default config: the packaged sample catalog, data in the volume. Mount your own file over it.
COPY <<'JSON' /etc/izle/izle.json
{
  "listen": { "host": "0.0.0.0", "port": 8787 },
  "dataDir": "/var/lib/izle"
}
JSON
ENV PATH=/opt/izle/bin:$PATH
USER node
VOLUME /var/lib/izle
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["izle-server"]
CMD ["--config", "/etc/izle/izle.json"]
