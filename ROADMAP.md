# Roadmap

Sense is a local presence layer for AI clients. The north star is simple:
make AI feel aware of the user's moment without turning the machine into a
surveillance device.

## Current Focus

- Make setup obvious for Codex, Claude Desktop, and other MCP clients.
- Keep routing behavior predictable with fixtures and prompt evals.
- Improve panel diagnostics without storing private history.
- Preserve the ContextFrame contract as sensors expand.

## Near-Term

- Better client-specific setup detection in `sense-mcp doctor`.
- Screenshot and camera permission diagnostics that name the exact macOS pane.
- More routing fixtures for privacy boundaries, visual requests, and workspace use.
- Optional generated demo assets for README and release pages.
- NPM publishing once the first public tag is stable.

## Later

- Linux and Windows sensor adapters.
- A stable `context-frame` schema package.
- Optional local-only attention classifiers that emit enum states, not images or embeddings.
- Community sensor packs with a stricter privacy review checklist.
- A lightweight benchmark harness for latency, routing accuracy, and privacy behavior.

## Non-Goals

- Background camera monitoring.
- Raw microphone transcription.
- Reading private messages or credentials from the screen.
- Cloud sync of context frames.
- Persistent behavioral profiling.

