# Project checkpoints

Duet can save and restore the eligible files in a local project, including files that have never been committed to Git. Each checkpoint records a label, time, file count, byte count, and optional build ID. Snapshots stay in that project's `.duet/checkpoints` folder and are not uploaded.

Before restoring, Duet validates the snapshot and saves the current eligible files as a separate safety checkpoint. Restore replaces changed files, brings back deleted files, and removes eligible files created after the selected checkpoint. You can restore the safety checkpoint to recover the state from before the undo. This is a whole-project file restore; stop manual edits before using it. Empty directories may remain.

A running build blocks restore. Duet refuses symbolic-link targets, special files, conflicting file/folder layouts, damaged snapshots, and unsafe paths before changing project files. Individual replacements are atomic. If an operation fails after some replacements, Duet attempts to roll those replacements back and reports the safety checkpoint; concurrent external edits, permissions, and disk failures can still require manual recovery. Keep independent backups for important projects.

## What is excluded

- Git and Duet's own state: `.git`, `.duet`.
- Dependencies and environments: `node_modules`, `.venv`, `venv`, `target`, `.tox`.
- Generated output and caches: `dist`, `build`, `coverage`, `.next`, `.nuxt`, `.output`, `.cache`, `.turbo`, `.parcel-cache`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`.
- Common local credentials: `.env`, `.env.*`, `.envrc`, `.npmrc`, `.pypirc`, `.netrc`, `.aws`, `.azure`, `.ssh`, `.gnupg`, `.gcloud`, `credentials.json`, `secrets.json`, and files ending in `.pem`, `.key`, `.p12`, `.pfx`, or `.keystore`.
- Symbolic links and `.DS_Store` files.

These exclusions apply at every directory depth, regardless of capitalization. Excluded files are left untouched when restoring. This list is conservative and cannot detect secrets stored under arbitrary filenames. All snapshot storage is private to the current macOS account. Generated directories named above are excluded even when a project uses the name for hand-written source.

Checkpoints allow up to 5,000 files, 20,000 folders, 256 MiB total, and 32 MiB per file. If a project exceeds a limit, checkpoint creation fails clearly rather than silently saving an incomplete snapshot. Remove generated files or move large assets out of the project before retrying. Checkpoints are not automatically deleted, so you control retention.

## Local integration

`createCheckpoint(project, { label, runId, limits } = {})` returns `{ id, createdAt, label, runId?, fileCount, bytes }`. `limits` may lower the defaults; it cannot increase them.

`listCheckpoints(project)` returns valid manifest summaries, newest first. Corrupt or unsafe records are omitted; full object integrity is checked during restoration.

`restoreCheckpoint(project, id)` returns `{ restored, backup }`, both checkpoint summaries. It owns the project's `.duet/active.lock` for the duration of restoration. Do not acquire that same lock before calling restore. Snapshot creation may run inside an existing build lock. Checkpoint operations also use an exclusive checkpoint lock.

Safety failures use the `DUET_CHECKPOINT` error code. A restore failure after its safety checkpoint is created includes `error.backup`; rollback problems are listed in `error.rollbackErrors`. The user can inspect the saved checkpoint without losing the current project's remaining files.
