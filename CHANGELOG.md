# Changelog

This file summarizes application behavior and repository maintenance. It does not claim that a tagged release or installer has been published.

## Unreleased repository maintenance

- Added fresh-clone setup and development instructions for this repository.
- Documented portable Mac packaging, runtime requirements, and the separate browser and legacy CLI launchers.
- Added contribution guidance for isolated tests, reviewed commits, and keeping the remote repository current without publishing local data.
- Added macOS/Node 22 CI and included the browser regression fixtures in the standard test command.
- Mac packaging now stages files in the system temporary directory, independent of the original workspace layout.
- Added repository instructions and ignore rules for keeping future source updates published while local data stays private.

## 0.9.0

- Build and Ask helper steps have a 60-minute hard limit and a separate 10-minute inactivity limit. Active stdout or stderr renews the inactivity timer.
- Claude output is streamed and normalized into the existing result format. Browser activity shows elapsed time and the last observed helper activity without exposing raw streamed output.
- Quiet helpers show a waiting state. Timed-out turns show a paused or needs-attention state even when their initial verification record is incomplete.
- Timeout recovery preserves project edits, completed handoffs, and available partial-response records. It does not automatically repeat an editing step or start another model call.
- Account checks run in parallel, and preparation respects cancellation.
- Browser state and account refresh requests allow 60 seconds; message acceptance allows 90 seconds; checkpoint writes allow 120 seconds. A local request deadline no longer marks an otherwise connected workspace offline.
- Lost send responses are reconciled against saved message IDs. Accepted unchanged drafts clear, newer edits remain, and uncertain submissions keep their idempotency key for a deliberate retry.

## Earlier beta capabilities retained

- Independent chats, saved drafts, project context, and follow-up requests.
- Up to three simultaneous turns in separate projects, with per-chat stop controls and protection against overlapping project edits.
- Browser-guided installation and provider sign-in, automatic connection detection, cancellation, and temporary Claude code entry when required.
- A persistent local Mac service, stable browser address, and a packaged runtime for Apple Silicon and Intel Macs.
- Best quality, Balanced, and Save usage coordination modes with bounded steps, reported usage, independent review, and focused repairs.
- Source checkpoints, recovery backups, requirement evidence, independent sandboxed project checks, static previews, project notes, and local feedback.
- A controlled comparison kit for collecting evidence across Claude, Codex, and Duet; no comparative quality or credit-savings claim is implied.
