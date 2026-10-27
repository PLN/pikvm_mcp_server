# syntax=docker/dockerfile:1
# Modified 2026-10 by PLN: Docker image (GPL-3.0; see NOTICE).
#
# Both stages use the same base digest. A base bump changes both lines.
# Local builds need BuildKit (COPY --chmod): docker buildx build .

FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
# sharp loads its prebuilt @img/sharp-* binaries without an install script.
RUN npm ci --ignore-scripts
COPY src ./src
COPY docker/gen-notices.mjs ./docker/
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && node docker/gen-notices.mjs > THIRD-PARTY-NOTICES.txt

FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS runtime
# npm and corepack are not used at runtime. Their bundled undici and
# brace-expansion are what an image scan flags.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini tesseract-ocr tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 pikvm \
 && useradd -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin pikvm \
 && install -d -o 10001 -g 10001 -m 0750 /data /data/tls /data/secrets /data/images
ENV NODE_ENV=production \
    PIKVM_MCP_NO_DOTENV=1 \
    PIKVM_MCP_HOST=0.0.0.0 \
    PIKVM_OCR_TESSERACT_BIN=/usr/bin/tesseract
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY --from=build /app/THIRD-PARTY-NOTICES.txt /app/
COPY package.json LICENSE NOTICE /app/
COPY --chmod=0755 docker/entrypoint.sh docker/healthcheck.mjs /usr/local/bin/
LABEL org.opencontainers.image.source=https://github.com/PLN/pikvm_mcp_server \
      org.opencontainers.image.licenses=GPL-3.0-only
USER 10001:10001
WORKDIR /app
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "/usr/local/bin/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
