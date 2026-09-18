# Prompting Guide

Sense works best when the AI client uses the smallest useful tool and explains
uncertainty plainly.

## Server Instructions

Sense sends this to the client in the initialize result, so a client that reads
MCP instructions has the routing discipline before its first call. It is exported
as `SENSE_SERVER_INSTRUCTIONS` from `src/instructions.ts`, and a test asserts this
block matches that constant verbatim so the doc and the wire cannot drift.

```text
Sense is a local-first context broker for the user's current situation.
Call get_relevant_context first: it classifies the request, returns the minimum
context plan, and usually embeds the context you need in one call. When
context_satisfied is true, every requested domain that has data is present, so do
not call another Sense context getter for the same request. When
context_plan.plan_only is true or expected_value is none, answer normally without
requesting a ContextFrame. A short response is not a failure: ok stays true,
context_satisfied goes false, and context_omitted names the domains left out and,
as suggested_max_tokens, a budget that returns the whole response; retry on that
number only when the omitted domains matter for this request. max_tokens accepts
320 to 8192 and bounds the complete response; max_bytes is the enforced ceiling
and estimated_tokens is an approximation. A missing field means unknown, not
false, and inferred context is never certain fact. Snapshot tools are explicit
one-shot captures that require local human consent immediately before capture;
never use them for ordinary writing, planning, coding, or general personalization.
```

## Client System Prompt Snippet

```text
You have access to Sense, a local privacy-first context MCP server.

Use get_relevant_context before deciding whether local context would help.
If context_plan.plan_only is true or expected_value is none, answer normally
without requesting a ContextFrame.
Respect context_plan.budget.max_tokens: prefer the situation card and the
smallest relevant domain over a full frame.
When context_satisfied is true, do not call another Sense context getter for
the same request. When it is false, the response is partial rather than failed:
read context_omitted, and only retry at its suggested_max_tokens if the omitted
domains matter. Treat the returned max_bytes as the enforced response ceiling
and estimated_tokens as an approximation; max_tokens accepts 320 to 8192.
Use semantic context tools for timing, focus, environment, and current work.
Use take_camera_snapshot only for a current user request about physical visual
appearance, room, desk, objects, lighting, or outfit.
For local Mac app visual QA, prefer non-interrupting CoreGraphics window-id
capture with `screencapture -x -l <window_id> /tmp/<app>.png` outside Sense.
When Sense capture is needed, use take_window_snapshot for one app window.
take_screen_snapshot is a deprecated window-only alias; it never captures the
full screen. Use take_full_screen_snapshot only when the user explicitly asks
for the main display and confirm_full_screen is true.

Never use camera or screen tools for ordinary writing, planning, coding, or
general personalization. If a visual tool succeeds, inspect snapshot_path or the
returned image content before answering. Each media call requires local
allow-once consent immediately before capture. If a capability is denied or
unavailable, say what is missing and continue from non-visual context when
possible. For schedule questions, prefer a direct calendar connector when one
is available and Sense reports calendar unavailable.
```

## Good Patterns

```text
User: how much can I get done before my next meeting?
Client: call get_relevant_context. If it recommends calendar_connector, use a
direct calendar connector for account timing when available; otherwise use
get_schedule_context and get_user_state.
```

```text
User: how do I look right now?
Client: call get_relevant_context, then take_camera_snapshot, inspect the image,
then answer directly.
```

```text
User: what is this error?
Client: call get_relevant_context, then take_window_snapshot, inspect the image,
then explain the visible error.
```

```text
User: verify the running app visually.
Client: list windows by app/owner name, capture the target window id with
screencapture -x -l, inspect the image, and avoid full-screen capture unless the
user specifically needs the main display.
```

## Bad Patterns

- Asking the user to upload a photo before trying an enabled
  `take_camera_snapshot` and its local consent flow.
- Taking a screenshot for a writing task.
- Reading private messages, credentials, or unrelated screen content.
- Treating inferred context as certain fact.
- Saying "I can see" when the tool only returned semantic context.
- Ignoring `context_plan.plan_only` and spending local context on ordinary prompts.
