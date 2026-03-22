# Privacy Policy — Groundwork

**Last updated:** March 2026

## Summary

Groundwork stores all data locally on your machine. It does not collect telemetry, track usage, or send data to external servers.

## Data Storage

- All vault data (tasks, notes, reference docs) is stored as plain markdown files on your local filesystem.
- The default global vault location is `~/.groundwork/`. Workspace vaults are stored in `.groundwork/` within your project folder.
- Session logs are stored locally in `.sessions/` directories as JSONL files.
- No data is stored in the cloud, on remote servers, or transmitted off your device by this extension.

## Telemetry

Groundwork does **not** collect any telemetry, analytics, or usage data. There are no tracking pixels, API calls home, or anonymous usage reports.

## AI Features

Groundwork's Daily Briefing can optionally use VS Code's built-in Language Model API (`vscode.lm`) to generate AI-powered summaries. When this feature is used:

- The request is handled entirely by VS Code's own Copilot infrastructure.
- Data handling, retention, and privacy are governed by your VS Code and GitHub Copilot configuration — not by Groundwork.
- Groundwork does not maintain its own AI service, API keys, or model endpoints.
- If you do not have Copilot enabled, the AI summary feature is simply unavailable — no data is sent anywhere.

## Third-Party Services

Groundwork does not integrate with or send data to any third-party services. It is a fully offline, local-first extension.

## Contact

If you have questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/sedimentarian/groundwork).
