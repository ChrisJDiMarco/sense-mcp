# `docs/evals`

Everything the two eval scripts read, plus the fixtures the router's budget
tests measure against. `SENSE_BENCH.md` explains the loop and the gate; this
file says what each artifact is and where it came from.

## Corpora

| file | read by | what it is |
| --- | --- | --- |
| `sense-mcp-eval-prompts.md` | `scripts/eval-prompt-pack.cjs` | The manual prompt pack. Its numbered prompts are parsed out and routed. |
| `prompt-pack-routing-expectations.json` | `scripts/eval-prompt-pack.cjs` | One expectation per pack prompt, asserted field by field. Every one must pass; there is no waiver list. |
| `routing-fixtures.json` | `scripts/eval-routing.cjs` | Curated adversarial fixtures, asserted field by field. Hard gate: every assertion holds or the build fails, and no baseline entry exists for them. |
| `privacy-capture-corpus.json` | `scripts/eval-routing.cjs`, `tests/relevance.test.ts` | The unrequested-capture corpus, generated rather than listed: paraphrase families (opener set x tail set) expanded into every combination, plus the explicit requests that must still capture. Absolute hard gate. |
| `held-out-negatives.json` | `scripts/eval-routing.cjs` | General-knowledge sentences built from the nouns the router keys on. All must route to `no_local_context_needed` with `minimum_tool: none`; any miss fails the build. Hard gate, no baseline entry. |
| `held-out-paraphrases.json` | `scripts/eval-routing.cjs` | Natural paraphrases of the supported situations. Scored; capture is gated. |
| `held-out-situation.json` | `scripts/eval-routing.cjs` | Written from the intent definitions rather than the matcher. Positives avoid the vocabulary the deixis gate leans on; negatives deliberately contain deictic words. Scores low on purpose. |
| `routing-baseline.json` | `scripts/eval-routing.cjs` | The committed score for the two statistical corpora **only**: pass counts plus the exact cases known to miss. Regressions and stale improvements both fail. |

There is deliberately no `prompt-pack-baseline.json`. One existed briefly and
waived eight genuine routing regressions; see the history note in
`SENSE_BENCH.md`.

A baseline is a waiver, so it covers the sampled corpora and nothing else. The
curated fixtures, the capture corpus and the held-out negatives are
specifications: a miss in them is a defect, they have no baseline entry, and
`node scripts/eval-routing.cjs --update-baseline` refuses to write anything
while any of them is failing. That refusal is what stops one command from
turning the whole eval green.

## `real-frame-fixture.json`

Budget assertions in `tests/relevance.test.ts` measure against this file. A
hand-written ContextFrame is an order of magnitude smaller than a real one and
hides every truncation and budget defect, so the advisory-budget tests are only
meaningful against a frame of real size.

**What it is.** The `frame` and `health` of one `get_context_frame` response,
taken on macOS at `projection: "debug"`, `max_tokens: 8192` — debug so that no
field is projected away, 8192 so that nothing is truncated. The response's own
call is recorded in the file's `captured_from` field.

**How it was sanitized.** Workspace name, git branch, active window title and
media app were replaced with same-shaped placeholders (`atlas-core`,
`feature-parser`, ...). The `user` and `schedule` domains were filled in from
the sensor field sets, because calendar and presence were denied on the capture
machine and would otherwise be absent; every capability is reported `granted` so
the privacy and quality blocks are at full size. The numbers (dirty-file counts,
battery, idle seconds, next-event minutes) are the shapes a real frame carries,
not the capture machine's real values.

**How to regenerate it.** On a machine with the Sense capabilities granted,
build this checkout and drive its own server over stdio with an isolated broker
socket, so nothing touches an already-running broker. The recipe below was run
against this checkout on 2026-09-18; it imports `@modelcontextprotocol/client`,
the v2 package this repo actually depends on. The version printed here before
imported `@modelcontextprotocol/sdk`, which the v1-to-v2 migration removed and
`tests/packageManifest.test.ts` asserts is absent, so it could not be run at
all.

```bash
npm run build
export SENSE_BROKER_SOCKET="$(mktemp -d)/broker-v1.sock"
node --input-type=module -e '
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const client = new Client({ name: "frame-capture", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env },
  }),
);
const result = await client.callTool(
  { name: "get_context_frame", arguments: { projection: "debug", max_tokens: 8192 } },
  undefined,
  { timeout: 30_000 },
);
console.log(JSON.stringify(result.structuredContent, null, 2));
await client.close();
'
```

The server writes one line to stderr naming the socket it connected to;
redirect it or ignore it. The response's `context` is the projected frame, so it
becomes the fixture's `frame`, and `health` becomes `health`.

**Sanitize before saving.** A live capture carries this machine's workspace
name, git branch, active window title, media app and any device names the
environment domain reports. Replace each with a same-shaped placeholder, use
`/Users/example` for any home path and `00:00:00:00:00:00` for any hardware
address, and say in the fixture's `description` which fields were replaced and
why. Nothing that identifies the capture machine or its owner belongs in a
public repo. Keep `captured_from` describing the call that was actually made.

**How a reader checks the file is still a real frame.** `tests/relevance.test.ts`
asserts the provenance fields are present and that the fixture is of real size —
every domain populated, every capability reported, and an estimated token count
far above what any hand-written frame reaches. A minimal frame swapped in for
convenience fails those assertions instead of quietly making the budget tests
pass.
