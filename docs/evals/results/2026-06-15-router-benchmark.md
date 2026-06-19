# Router Benchmark - 2026-06-15

This is a router benchmark, not a claim that Sense improves final AI responses.
It measures whether `get_relevant_context` selects the expected minimum tool for
the eval prompts.

## Command

```bash
npm run check
```

## Result

| Check | Score |
|---|---:|
| Unit tests | 83/83 |
| Adversarial routing fixtures | 15/15 |
| Prompt-pack routing expectations | 51/51 |
| Production dependency audit | 0 vulnerabilities |

## False Positives Fixed

| Prompt | Expected |
|---|---|
| `write an email about the screen redesign` | no camera/screen tools |
| `quick question about my code` | no time-pressure route |
| `what is the state of the union?` | no focus-state route |
| `write a post about hair trends` | no camera route |
| `what are good screen redesign principles?` | no screenshot route |

## Interpretation

The measurable router score is currently `51/51` on the prompt pack and `15/15`
on adversarial fixtures. The fixtures now also assert selected context broker
policy, including expected value, plan-only behavior, token-budget mode, and
calendar connector recommendations. That proves the routing and broker layers
are behaving against the published expectations.

The harder product bet - whether Sense improves final answers versus a baseline
client - is still pending a paired client run scored on relevance,
actionability, context accuracy, privacy fit, and latency overhead.
