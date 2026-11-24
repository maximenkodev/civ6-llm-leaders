# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.
Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository.
You will get a reply as soon as possible; please allow reasonable time for a fix before disclosing publicly.

## What counts as a security issue

- Anything that could leak a user's **LLM API key**. The key lives in the git-ignored `bridge/config.yaml`
  or the `LLM_API_KEY` environment variable.
- Ways for model output or another program to make the bridge run unintended code. LLM responses are treated
  as untrusted: deals and treaties are validated, and strings sent to the game are escaped. A bypass of that
  is in scope.
- Problems with how the bridge talks to the game. It connects to FireTuner on `127.0.0.1:4318` (localhost only)
  and executes Lua there.

## Good practice for users

- Never commit or share `bridge/config.yaml`, and never paste your API key into issues or screenshots.
  If a key leaks, revoke it at your provider immediately.
- FireTuner gives full scripting access to a running game. Only enable it on machines you trust, and keep the
  default localhost binding.
- Review third-party `personas.yaml` files before using them: they are plain text that goes into prompts.

## Supported versions

Only the latest `main` branch is supported.
