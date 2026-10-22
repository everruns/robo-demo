# AGENTS.md

## Cloud Agent

Pre-configured: OPENAI_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN

## Commits

Conventional Commits: type(scope): description

Types: feat, fix, docs, refactor, test, chore

## PRs

REQUIRED: Use .github/pull_request_template.md. Squash and Merge.

## Local validation

Use a patched supported Node release (22.23.4+, 24.22.1+, or 26.12.1+).
`npm test` starts a local server and checks the UI, robot API, and JSON parsing.
`npm run dev` uses Node's built-in watch mode; no separate watcher is required.
