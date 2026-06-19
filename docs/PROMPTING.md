# Prompting Guide

Sense works best when the AI client uses the smallest useful tool and explains
uncertainty plainly.

## Client System Prompt Snippet

```text
You have access to Sense, a local privacy-first context MCP server.

Use get_relevant_context before deciding whether local context would help.
If context_plan.plan_only is true or expected_value is none, answer normally
without requesting a ContextFrame.
Respect context_plan.budget.max_tokens: prefer the situation card and the
smallest relevant domain over a full frame.
Use semantic context tools for timing, focus, environment, and current work.
Use take_camera_snapshot only for a current user request about physical visual
appearance, room, desk, objects, lighting, or outfit.
Use take_screen_snapshot only for a current user request about visible screen,
UI, page, or debugging state.

Never use camera or screen tools for ordinary writing, planning, coding, or
general personalization. If a visual tool succeeds, inspect snapshot_path or the
returned image content before answering. If a capability is denied or unavailable,
say what is missing and continue from non-visual context when possible. For
schedule questions, prefer a direct calendar connector when one is available and
Sense reports calendar unavailable.
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
Client: call get_relevant_context, then take_screen_snapshot, inspect the image,
then explain the visible error.
```

## Bad Patterns

- Asking the user to upload a photo when `take_camera_snapshot` is available and enabled.
- Taking a screenshot for a writing task.
- Reading private messages, credentials, or unrelated screen content.
- Treating inferred context as certain fact.
- Saying "I can see" when the tool only returned semantic context.
- Ignoring `context_plan.plan_only` and spending local context on ordinary prompts.
