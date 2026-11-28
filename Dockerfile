# Hosted Accord: Node 22 runs the API, the web app and the access-key gateway; Python 3.12 runs the
# three agents and the contract checks (Slither). Build: docker build -t accord .  See docs/DEPLOY.md.
FROM node:22-bookworm-slim AS node

FROM python:3.12-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Dependencies first, so code changes rebuild quickly.
COPY requirements.lock.txt ./
RUN python -m venv .venv && .venv/bin/pip install --no-cache-dir -r requirements.lock.txt
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci --no-audit --no-fund

COPY . .
RUN cd frontend && npm run build && rm -rf node_modules/.cache

ENV NODE_ENV=production PORT=8080 ACCORD_DATA_DIR=/data
EXPOSE 8080
# Mount a persistent volume at /data (on Railway: a Railway Volume); it keeps projects, drafts,
# the test chain's history and generation records across deploys.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/serve.cjs"]
