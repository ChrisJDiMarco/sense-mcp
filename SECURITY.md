# Security Policy

## Supported Versions

`sense-mcp` is currently pre-1.0. Security fixes are made on `main` and included
in the next release.

## Reporting a Vulnerability

Please do not open a public issue for a vulnerability.

Use GitHub's private vulnerability reporting or open a private security advisory
for the repository. Include:

- affected version or commit
- platform and MCP client
- steps to reproduce
- whether the issue exposes camera, screen, audio, window title, calendar, or
  filesystem data

We will acknowledge valid reports as quickly as possible and prioritize issues
that weaken the local-only, pull-based, opt-in privacy model.

## Security Boundaries

The intended security model is:

- Sensors run locally.
- Context frames contain semantic states, not raw private content.
- Camera and screen snapshots are explicit tools, not background sensors.
- Microphone support samples level only, never audio content.
- Snapshot files are temporary local files with private permissions.
- The control panel binds to `127.0.0.1` and requires an ephemeral token for
  permission changes.
- Known Sense environment keys are allowlisted before config writes.

## Out of Scope

`sense-mcp` does not try to defend against:

- a malicious local administrator
- a compromised MCP client
- malware with access to the same user account
- users explicitly enabling raw-title or snapshot features and sharing outputs

If your threat model includes those cases, do not enable optional media or raw
title capabilities.
