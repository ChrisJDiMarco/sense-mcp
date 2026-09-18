# Sense Bench

Sense Bench is the lightweight evaluation loop for the project. It has seven
layers: curated adversarial routing fixtures, the generated unrequested-capture
corpus, three held-out corpora the router was not written against, prompt-pack
routing expectations, and manual client behavior prompts. (It said "five" while
listing six, before the capture corpus made it seven.)

## Automated

```bash
npm run build
npm run eval:routing
npm run eval:prompt-pack
```

Corpora:

- `routing-fixtures.json` — curated adversarial fixtures, asserted field by field.
- `privacy-capture-corpus.json` — the unrequested-capture corpus, and the only
  generated one here. Each entry is a paraphrase family: an opener set crossed
  with a tail set, expanded into every combination, plus the explicit visual
  requests that must still reach a capture so that "never capture" is not a way
  to pass. 200 prompts at the last count, all hard-gated.
- `held-out-negatives.json` — general-knowledge sentences built around the nouns
  the router keys on. Useful, but derived from the matcher, so it can only
  confirm the gate it came from. It carries a few capture-trigger phrasings too
  ("how do I start recording in zoom", "what is a good height for my desk").
  This file used to claim they were "the general-knowledge phrasing of every
  capture trigger". They were not: "what is a good way to organize the cables on
  my desk", "how do I look up a DNS record", "how do I clone this object in
  JavaScript" and "how do I clean my screen without scratching it" all reached a
  `take_*` tool with nothing in any corpus to catch them. Enumerating the
  families instead of the examples is what the capture corpus above is for.
- `held-out-situation.json` — written from the intent definitions in SPEC.md
  instead, and deliberately avoiding that vocabulary. Its positives are phrased
  the way people type; its negatives are general-knowledge questions that do
  contain deictic words. This is the corpus that can see the deixis gate
  under-firing, and it scores low on purpose.
- `held-out-paraphrases.json` — natural paraphrases of the supported situations.
- `prompt-pack-routing-expectations.json` — expectations for the manual pack.

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

## The gate

A corpus is either a specification or a sample, and only a sample gets a
baseline. Everything in the first three rules below is a specification: a miss
is a defect, it fails the build, and `--update-baseline` cannot record it.

1. **Privacy and robustness, absolutely, in both scripts.** Any capture tool
   reached by a prompt that did not ask for one, any privacy-boundary prompt
   that leaves the boundary, and any routing difference under a curly-apostrophe
   variant. Never scored, never waived, never traded.
2. **The capture corpus and the held-out negatives: every prompt, every time.**
   Every generated paraphrase must reach no `take_*` tool and must not claim
   `requires_explicit_media`; every explicit visual request in the same file
   must still reach the capture it names, so a router that stopped capturing
   altogether fails too. Every negative must reach
   `no_local_context_needed`/`none`. `tests/relevance.test.ts` runs the capture
   corpus as well, so `npm test` alone cannot go green while an unrequested
   capture is reachable.
3. **The curated fixtures and the prompt pack: every assertion, every time.**
   Both are curated specifications — each entry is a routing decision the
   product has committed to — so they fail on a miss and there is no waiver
   list. If an expectation is wrong, the expectation gets changed on purpose,
   with the reason in the commit message. The fixtures briefly shared the
   held-out baseline, which made them waivable; they have their own hard gate
   again.
4. **The two sampled held-out corpora: no regression against the committed
   baseline.** `held-out-paraphrases.json` and `held-out-situation.json` are
   samples of how people phrase things, so a score below 100% is a measurement
   rather than a defect, and the honest number lives in `routing-baseline.json`:
   a pass count plus the exact cases known to miss. A case that starts missing
   fails the build even if another case was fixed in the same change. A case
   that starts passing also fails, as a stale baseline, so improving the number
   is a deliberate act:

```bash
node scripts/eval-routing.cjs --update-baseline
```

That command rewrites the sampled corpora's score and nothing else, and it
refuses to write at all while a hard gate is failing — otherwise it would be a
one-command waiver for the entire eval, which is what it had become.

The routing script prints each corpus on its own line, hard gates first and the
baseline and delta beside every sampled number, so a regression is visible in
the first nine lines of output.

Note on the history of this file, because it has been recorded wrong twice. The
`51/51` prompt-pack result reported before 2026-09-18 was a real measurement of
the router as it shipped, and not a false claim — but the same paragraph used to
add "and not a number the router had been fitted to", which is wrong, and
contradicted its own next sentence. Some of those expectations were matched by
patterns containing the prompts' own wording, and that is what being fitted to a
corpus means. Three such patterns are still in `src/relevance.ts` today
(`/\bactive or away\b/` is prompt 38 verbatim, `/\bminimum sense tool\b/` is
prompt 51, `/\bwhat do you know about me right now\b/` is prompt 43), so part
of the pack score is still fitted and the honest reading of `51/51` is "the pack
holds, and the held-out corpora are where generalization is measured". The rest
of the history stands: for a short period the pack scored `43/51` and a
committed baseline waived the eight misses, which was worse than what it
replaced, because eight genuine routing regressions shipped green. The waiver
file is gone and the pack is a hard gate again.

Current recorded result (2026-09-18, after the unrequested-capture fixes):
`51/51` prompt-pack expectations (gated), `200/200` capture corpus (gated),
`16/16` curated fixtures (gated), `86/86` held-out negatives (gated), `39/40`
held-out paraphrases, `9/22` held-out situation positives and `22/22` its
negatives. The sampled numbers are measurements, not targets: the router is not
tuned until a corpus reads 100%, because a corpus that always reads 100% has
stopped telling anyone anything. The situation positives in particular are still
telling us that the deixis gate under-fires on natural phrasing ("how much
battery is left"), which is the most useful thing on this page. The situation
negatives moved from 18/22 to 22/22 in the same change, because the four misses
were the over-triggering this round fixed, not a target that was tuned for.

See `docs/evals/results/2026-06-15-router-benchmark.md` for the earlier run, and
`docs/evals/README.md` for what each file is and how the captured frame fixture
was made.

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
- any capture-corpus family, curated fixture or held-out negative fails
- either sampled corpus regressed against its committed baseline
- visual prompts do not route to explicit media tools
- the client claims certainty from stale or missing context
