/**
 * The routing discipline Sense's whole design rests on, sent to the client in
 * the initialize result. docs/PROMPTING.md quotes this constant verbatim so the
 * documented contract and the wire contract cannot drift, and a test in
 * tests/server-protocol.test.ts asserts both halves of that.
 *
 * It describes the contract the server actually implements. A budget shortfall
 * is a partial response, not an error, so the old "retry on
 * context_budget_too_small" instruction described a path a client now almost
 * never reaches; a client that waited for that error would read a partial
 * answer as a complete one.
 */
export const SENSE_SERVER_INSTRUCTIONS = [
  "Sense is a local-first context broker for the user's current situation.",
  "Call get_relevant_context first: it classifies the request, returns the minimum",
  "context plan, and usually embeds the context you need in one call. When",
  "context_satisfied is true, every requested domain that has data is present, so do",
  "not call another Sense context getter for the same request. When",
  "context_plan.plan_only is true or expected_value is none, answer normally without",
  "requesting a ContextFrame. A short response is not a failure: ok stays true,",
  "context_satisfied goes false, and context_omitted names the domains left out and,",
  "as suggested_max_tokens, a budget that returns the whole response; retry on that",
  "number only when the omitted domains matter for this request. max_tokens accepts",
  "320 to 8192 and bounds the complete response; max_bytes is the enforced ceiling",
  "and estimated_tokens is an approximation. A missing field means unknown, not",
  "false, and inferred context is never certain fact. Snapshot tools are explicit",
  "one-shot captures that require local human consent immediately before capture;",
  "never use them for ordinary writing, planning, coding, or general personalization.",
].join("\n");
