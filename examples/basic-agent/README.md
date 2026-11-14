# basic-agent example

Prove Agent Replay Lab in under 10 minutes:

```bash
# from repo root
pnpm install
pnpm --filter @agent-replay-lab/core build
pnpm --filter @agent-replay-lab/example-basic-agent demo
```

What it does:

1. **record** — three tools (`getWeather`, `searchDocs`, `sendSummary`); API key redacted before persist
2. **replay** — offline mock stubs tools from the cassette (no network, no live model)
3. **regress** — intentional arg drift (`Munich` vs `Berlin`) fails offline replay + structural diff

Honest modes: this example never calls a live LLM. Mock replay ≠ model verification.
