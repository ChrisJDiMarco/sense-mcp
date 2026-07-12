# Release Process

Use this checklist when cutting a public release.

## Preflight

```bash
npm ci
npm run release:dry-run
npm run ios:build
sense-mcp doctor
```

Check that:

- `CHANGELOG.md` has an entry for the release.
- `package.json` version matches the tag.
- `README.md` quickstart matches the current CLI.
- The package declares Node.js 22 or newer.
- `SPEC.md` reflects any ContextFrame shape changes.
- New capabilities are covered by tests and privacy docs.
- Run `npm run ios:build` when the iOS companion changed and Xcode is available.
- Check `sense-mcp settings --lan --open` before claiming physical iPhone sync.
- Confirm no docs claim that local acquisition guarantees model-local
  processing or provider retention.
- Confirm media docs describe window-only default capture, separate full-screen
  capture, and one-use local consent.
- Confirm `npm run check:package` stays below its packed and unpacked byte caps
  and excludes `apps/`, `docs/assets/`, and `scripts/`.

## Tag

```bash
git status -sb
git tag v0.1.0
git push origin main --tags
```

## GitHub Release

Create a release from the tag and summarize:

- what changed
- who should try it
- setup steps
- known limitations
- validation run

## NPM

NPM publish is intentionally separate from GitHub release.

```bash
npm login
npm publish --access public
```

If publishing fails because the package name is taken or auth requires 2FA,
stop and resolve that outside the release commit.
