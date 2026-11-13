# A slim Paperclip image for Cloudflare Containers, built from the published
# @paperclipai/server package. The install is split into several layers below
# because Cloudflare's registry times out on a single multi-gigabyte layer.
FROM node:24-trixie-slim AS build
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund @paperclipai/server@2026.1106.0 paperclipai@2026.1106.0 \
  && npm cache clean --force \
  && mkdir -p /big/@openai /big/@paperclipai/server \
  && mv node_modules/@openai/codex-linux-x64 /big/@openai/ \
  && mv node_modules/@openai/codex /big/@openai/ \
  && mv node_modules/@anthropic-ai /big/ \
  && mv node_modules/@paperclipai/server/dist /big/@paperclipai/server/ \
  && mv node_modules/@paperclipai/server/node_modules /big/@paperclipai/server/ \
  && mv node_modules/opencode-linux-x64 /big/ \
  && (mv node_modules/opencode-linux-x64-baseline /big/ || mkdir -p /big/opencode-linux-x64-baseline) \
  && (mv node_modules/@github /big/ || mkdir -p /big/@github)

FROM node:24-trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini openssh-client jq \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
COPY --from=build /big/@paperclipai/server/dist /app/node_modules/@paperclipai/server/dist
COPY --from=build /big/@paperclipai/server/node_modules /app/node_modules/@paperclipai/server/node_modules
COPY --from=build /big/@anthropic-ai /app/node_modules/@anthropic-ai
COPY --from=build /big/@openai/codex /app/node_modules/@openai/codex
COPY --from=build /big/@openai/codex-linux-x64 /app/node_modules/@openai/codex-linux-x64
COPY --from=build /big/opencode-linux-x64 /app/node_modules/opencode-linux-x64
COPY --from=build /big/opencode-linux-x64-baseline /app/node_modules/opencode-linux-x64-baseline
COPY --from=build /big/@github /app/node_modules/@github

ENV NODE_ENV=production \
    PAPERCLIP_HOME=/paperclip \
    PATH=/app/node_modules/.bin:$PATH
RUN mkdir -p /paperclip
EXPOSE 3100
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/node_modules/@paperclipai/server/dist/index.js"]
