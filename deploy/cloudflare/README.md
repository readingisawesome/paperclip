# Paperclip and Hermes on Cloudflare

Two Workers, each fronting one Cloudflare Container. Both sit behind Cloudflare Access.

- `paperclip/` serves https://paperclip.sitkamediagroup.com from a slim image built on the published `@paperclipai/server` package (the official image is too large for Cloudflare builds). Its database is a Supabase Postgres (`DATABASE_URL` secret on the Worker). Files go to the private R2 bucket `paperclip-storage` when the R2 keys are set.
- `hermes/` serves https://hermes-agent.sitkamediagroup.com. Its own files reset when it sleeps.
- `shared/` holds the Access check, the container start-and-sleep helper and the Workers AI endpoint.

Both containers sleep after 15 quiet minutes. Paperclip also wakes once an hour.

Models come from Workers AI through the `agents` AI Gateway, which caps requests per hour. The containers call `http://workers-ai.internal/v1`, which the Worker answers with its AI binding, so no API key is stored in either container.

Deploys run on Cloudflare Workers Builds from the `cloudflare-deploy` branch, one build per folder.
