# Contributing to sense-mcp

Thanks for helping make local AI context safer and more useful.

`sense-mcp` has a simple contribution rule: new capability is welcome only when
it preserves the privacy model. Prefer semantic local state over raw content.

## Setup

```bash
npm install
npm run build
npm test
```

Run the full local check before opening a pull request:

```bash
npm run check
```

If package metadata, docs packaging, or release files changed, also run:

```bash
npm run release:dry-run
```

## Sensor Contract

Sensors should be small modules in `src/sensors/` that return observations.

Good sensor output:

```json
{
  "domain": "environment",
  "fields": { "noise_class": "quiet" }
}
```

Bad sensor output:

```json
{
  "domain": "environment",
  "fields": { "transcript": "raw microphone content" }
}
```

Rules:

1. Emit semantic states, never raw private content.
2. Do not make network calls from sensors.
3. Do not write raw sensor data to persistent storage.
4. Fail closed or return no observations on permission errors.
5. Keep opt-in capabilities disabled by default.
6. Add tests for privacy behavior and failure paths.

## Code Style

- TypeScript strict mode is on.
- Keep modules focused and boring.
- Prefer explicit allowlists over stringly dynamic permissions.
- Treat OS permissions as optional; every sensor must degrade gracefully.
- Use `zod` schemas for MCP tool input validation.

## Pull Request Checklist

- [ ] `npm run build` passes.
- [ ] `npm test` passes.
- [ ] `npm run eval:routing` passes.
- [ ] `npm run audit:prod` passes.
- [ ] New sensors or tools are documented in `README.md`.
- [ ] Privacy changes are documented in `docs/PRIVACY.md`.
- [ ] The change does not expose raw screen text, audio content, camera images,
      file contents, calendar titles, Wi-Fi names, or message contents by
      default.

## Public API Changes

If you change the ContextFrame shape, update:

- `SPEC.md`
- relevant tests in `tests/`
- README tool/sensor tables
- eval prompts if routing behavior changes

The spec should remain backwards-conscious while the project is pre-1.0.
