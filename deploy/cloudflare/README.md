# Paperclip and Hermes on Cloudflare

Two Workers, each fronting one Cloudflare Container. Both sit behind Cloudflare Access.

- `paperclip/` serves https://paperclip.sitkamediagroup.com from a slim image built on the published `@paperclipai/server` package (the official image is too large for Cloudflare builds). Its database is a Supabase Postgres (`DATABASE_URL` secret on the Worker). Files go to the private R2 bucket `paperclip-storage` when the R2 keys are set.
- `hermes/` serves https://hermes-agent.sitkamediagroup.com. Its own files reset when it sleeps.
- `shared/` holds the Access check, the container start-and-sleep helper and the Workers AI endpoint.

Both containers sleep after 15 quiet minutes. Paperclip also wakes once an hour.

Every model call goes through the `agents` AI Gateway, which logs it and holds the hourly request cap and the spend limit. The containers call `http://workers-ai.internal/v1`, an OpenAI-style endpoint the Worker answers with its AI binding, so no API key is stored in either container.

- `@cf/...` model names run on Workers AI (Llama, Qwen, DeepSeek, Kimi, GLM, Gemma, Mistral).
- `author/model` names from the AI Gateway catalog (for example `openai/gpt-5.5`, `anthropic/claude-sonnet-5`, `google/gemini-3.8-flash`, `xai/grok-4.6`, `alibaba/qwen3.8-max`) are billed to the account's AI Gateway credits through Unified Billing. No provider keys are needed.
- `GET /v1/models` lists the suggested models. Add more with the `EXTRA_MODELS` variable (comma-separated).

Deploys run on Cloudflare Workers Builds from the `cloudflare-deploy` branch, one build per folder.
