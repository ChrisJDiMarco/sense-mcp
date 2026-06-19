# Example Outputs

These examples show the shape of Sense responses. Exact fields depend on the
machine, permissions, and current app state.

## Relevance Router

Request:

```text
how do I look right now?
```

Expected plan:

```json
{
  "intent": "visual_appearance_check",
  "confidence": "high",
  "minimum_tool": "take_camera_snapshot",
  "recommended_tools": ["take_camera_snapshot"],
  "requires_explicit_media": true,
  "snapshot_mode": "appearance_check",
  "context_plan": {
    "expected_value": "high",
    "budget": { "mode": "visual", "max_tokens": 120 },
    "plan_only": false,
    "include_frame": false,
    "included_context": ["camera_snapshot"],
    "reason": "The user asked about current visual appearance; text context cannot answer that directly."
  }
}
```

## Time Pressure

Request:

```text
help me knock this out fast before my next meeting
```

Expected plan:

```json
{
  "intent": "time_pressure",
  "minimum_tool": "get_schedule_context",
  "relevant_domains": ["schedule", "user"],
  "recommended_tools": ["get_schedule_context", "get_user_state"],
  "avoided_tools": ["take_camera_snapshot", "take_screen_snapshot"],
  "context_plan": {
    "expected_value": "high",
    "budget": { "mode": "focused", "max_tokens": 140 },
    "external_context_needed": ["calendar_connector"],
    "reason": "Schedule timing can change the recommendation; account calendar data may need a connector."
  }
}
```

## Privacy Boundary

Request:

```text
read my messages on screen
```

Expected plan:

```json
{
  "intent": "privacy_boundary",
  "minimum_tool": "none",
  "recommended_tools": [],
  "avoided_tools": ["take_camera_snapshot", "take_screen_snapshot"],
  "context_plan": {
    "expected_value": "none",
    "budget": { "mode": "none", "max_tokens": 0 },
    "plan_only": true,
    "include_frame": false,
    "reason": "The request crosses a privacy boundary, so Sense should not collect local context."
  }
}
```

The client should explain the boundary and ask the user to paste selected text
if they want help with specific content.
