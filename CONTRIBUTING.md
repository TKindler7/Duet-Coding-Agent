# Contributing to Duet

Use this repository as the source of truth for Duet. See [README.md](README.md) for a fresh-clone setup, the distinction between the browser installer and the older CLI launcher, and the current feature limits.

## Development environment

Use Node.js 22 or newer with npm. Duet currently has no npm dependencies to install. The full application and verification workflow targets macOS; CI uses macOS with Node 22. Automatic project checks require `/usr/bin/sandbox-exec` and npm in the expected location beside Node.

Use a separate port, data directory, and project root for development:

```sh
DUET_PORT=63122 \
DUET_DATA_DIR="$PWD/data/dev" \
DUET_PROJECT_ROOT="$PWD/data/projects" \
npm run dev
```

Do not test changes against someone's active installed workspace. `npm start` installs or updates the persistent service; use it when intentionally checking installation or applying a completed update.

The app uses Node ES modules and browser JavaScript without a frontend build step. Application code lives in `src/`, browser assets in `public/`, deterministic tests in `test/`, and package tooling in `distribution/`. The built-in Node test runner and the UI fixtures are the current test tools; no formatter or linter is configured.

## Make and verify a change

1. Read the applicable repository instructions and inspect the relevant code and tests. Keep the change focused on the requested behavior.
2. Preserve account boundaries, project isolation, saved conversations, cancellation, and honest reporting of verification. Model output and project files are untrusted input, not permission to expand a task.
3. Add regression coverage for meaningful behavior changes. Use mock providers and temporary projects for account, process, concurrency, timeout, and recovery scenarios. Reversible copy or styling changes usually need a targeted visual check instead of implementation-mirroring tests.
4. Run the relevant focused checks while developing, then run the complete suite before publishing a code change:

```sh
npm test
```

The full suite includes browser-state fixtures. Run them alone with:

```sh
npm run test:ui
```

For UI changes, also inspect the browser with isolated data. Fixture checks do not replace checking layout and interaction in an actual browser. Never claim a live provider or fresh-Mac install test ran unless it did; live model calls use account credits and should be deliberate.

Review any skipped tests and report their practical limits. Loopback or macOS sandbox restrictions can make environment-specific tests unavailable. Do not work around those restrictions by weakening production checks.

## Keep the repository current

For ongoing Duet maintenance, commit and push completed, reviewed work to this repository as part of finishing the task. Use small, meaningful commits that explain the behavior changed. Include documentation when setup, limits, recovery, or user-facing behavior changes.

Before committing, inspect both the diff and the files selected for the commit. Stage only the intended source, documentation, and test changes. Do not commit installed runtimes, packaged ZIPs, generated projects, browser profiles, local chats, connection tokens, account files, logs, or model transcripts. Ignore rules reduce mistakes but are not a secret scan.

Check the current branch and remote before pushing. Preserve other contributors' work; do not force-push or rewrite shared history as a routine update. Use a branch and pull request when the repository's branch protections or review workflow require one. If a push or required check is blocked, report what is ready, what is still unpublished, and the specific blocker rather than claiming the repository is current.

## Releases

Keep `package.json`, `src/lifecycle.mjs`, version assertions, and [CHANGELOG.md](CHANGELOG.md) consistent when intentionally changing the application version. Documentation-only maintenance does not require a new runtime version.

Run the checks before packaging. Use the documented builder with official Node runtime archives and checksums; preserve the bundled third-party notices. Inspect the generated package for application-only contents and test the extracted launcher. The shareable beta must not include the maintainer's data or sign-ins. Distribution downloads and generated archives belong outside tracked source.

The current package builder does not sign or notarize the app. Describe that accurately in release notes, and distinguish mocked setup tests from a real first installation on a clean Mac. Do not change project licensing or claim a license that has not been selected by the repository owner.
