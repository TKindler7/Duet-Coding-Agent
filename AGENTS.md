# Working on Duet

This is the canonical source checkout for https://github.com/TKindler7/Duet-Coding-Agent.

## Standing owner instruction

The owner requested that this repository stay up to date as we continue developing Duet. For each completed Duet change, validate it, update relevant documentation and CHANGELOG.md, review the exact diff for private data, and commit and push the finished work. Do not stop at changes to the installed app or an extracted beta bundle. This authorizes publishing Duet source changes; it does not authorize publishing chats, account information, generated user projects, or unrelated files.

Before changing or publishing code, inspect local status and the remote branch. Preserve unrelated work and never force-push over others' commits. Honor branch protection and use a pull request when required. If shell Git authentication is unavailable, use the connected GitHub tools to publish the reviewed files, then fetch and reconcile this checkout with that commit. Report the published commit and checks honestly; if pushing is blocked, retain the local work and explain the blocker.

## Development

- Requires Node.js 22 or newer; application code uses Node built-ins and has no npm dependencies.
- Run `npm test` before publishing. It includes isolated process/server tests and browser logic regression checks; it does not prove real provider or physical-device behavior.
- Use fake providers and temporary directories for tests. Do not spend model credits or change accounts as part of automated checks.
- Keep Build and Ask flows, separate chat histories, parallel project protection, cancellation, and saved work recovery intact.
- Keep provider secrets out of logs, browser responses, source, and screenshots used in public documentation.
- A live installation resides outside this checkout. Never restart an active build or install over it without authorization; prefer waiting until idle. Publishing source does not require restarting Duet.
- Mac beta packaging lives in `distribution/`. Generated archives and bundled runtimes are release artifacts, not Git source files.

## Files that stay local

Never commit `data/`, `.duet/`, `.env*` secrets, `.claude/`, `.codex/`, provider credentials, private projects, model responses, local logs, downloaded runtimes, or beta archives. Stage named source files and inspect the staged diff instead of adding the workspace wholesale. Keep `.gitignore` current.
