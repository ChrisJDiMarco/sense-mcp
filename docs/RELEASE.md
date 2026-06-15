# Release Process

Use this checklist when cutting a public release.

## Preflight

```bash
npm ci
npm run release:dry-run
sense-mcp doctor
```

Check that:

- `CHANGELOG.md` has an entry for the release.
- `package.json` version matches the tag.
- `README.md` quickstart matches the current CLI.
- `SPEC.md` reflects any ContextFrame shape changes.
- New capabilities are covered by tests and privacy docs.

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

