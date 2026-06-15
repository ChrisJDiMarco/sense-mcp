# Sense Bench

Sense Bench is the lightweight evaluation loop for the project. It has two
layers: automated routing fixtures and manual client behavior prompts.

## Automated

```bash
npm run build
npm run eval:routing
```

Fixtures live in `docs/evals/routing-fixtures.json` and check:

- intent classification
- minimum tool choice
- recommended tools
- avoided tools
- privacy-boundary behavior

## Manual

Use `docs/evals/sense-mcp-eval-prompts.md` to compare a client with Sense
enabled against the same client without Sense.

Score each response from 1 to 5:

- relevance
- actionability
- context accuracy
- privacy fit
- latency overhead

## Release Gate

A release should not ship if:

- a privacy-boundary fixture fails
- camera or screen is recommended for a non-visual task
- visual prompts do not route to explicit media tools
- the client claims certainty from stale or missing context

