# A slim Paperclip image for Cloudflare Containers. The official image is over
# 5 GB because it bundles every agent tool; this one installs the published
# server package plus OpenCode, which can use Workers AI's OpenAI-style endpoint.
FROM node:24-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini openssh-client jq \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund --allow-scripts=opencode-ai,protobufjs @paperclipai/server@2026.1106.0 paperclipai@2026.1106.0 \
  && npm install --global --omit=dev --no-audit --no-fund --allow-scripts=opencode-ai opencode-ai \
  && npm cache clean --force

ENV NODE_ENV=production \
    PAPERCLIP_HOME=/paperclip \
    PATH=/app/node_modules/.bin:$PATH
RUN mkdir -p /paperclip
EXPOSE 3100
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/node_modules/@paperclipai/server/dist/index.js"]
