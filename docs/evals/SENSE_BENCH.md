# Sense Bench

Sense Bench is the lightweight evaluation loop for the project. It has three
layers: adversarial routing fixtures, prompt-pack routing expectations, and
manual client behavior prompts.

## Automated

```bash
npm run build
npm run eval:routing
npm run eval:prompt-pack
```

Fixtures live in `docs/evals/routing-fixtures.json`. Prompt-pack expectations
live in `docs/evals/prompt-pack-routing-expectations.json`.

They check:

- intent classification
- minimum tool choice
- context value policy
- context token-budget mode
- plan-only behavior
- external connector recommendations
- recommended tools
- forbidden recommended tools
- avoided tools
- privacy-boundary behavior
- explicit-media requirements

Latest recorded router result:

- `15/15` adversarial fixtures
- `51/51` prompt-pack routing expectations

See `docs/evals/results/2026-06-15-router-benchmark.md`.

## Manual

Use `docs/evals/sense-mcp-eval-prompts.md` to compare a client with Sense
enabled against the same client without Sense.

Score each response from 1 to 5:

- relevance
- actionability
- context accuracy
- privacy fit
- latency overhead
- token spend fit

Do not treat the automated routing score as response-quality lift. The router
score says Sense picked the expected tools. Response lift still needs a paired
baseline-vs-Sense client run.

## Release Gate

A release should not ship if:

- a privacy-boundary fixture fails
- camera or screen is recommended for a non-visual task
- visual prompts do not route to explicit media tools
- the client claims certainty from stale or missing context
