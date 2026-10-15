# Duet

Duet is a local browser workspace where Claude Code and Codex build apps together. Describe a project, follow the work in one conversation, then keep improving it with follow-up messages. Up to three chats can run at once, each with its own context, draft, progress, and results.

This repository contains the **0.9.0 source**. Duet is a Mac beta using your own provider accounts. It does not include subscriptions, a hosted service, or a separate Duet account. See [CHANGELOG.md](CHANGELOG.md) for the current changes and [CONTRIBUTING.md](CONTRIBUTING.md) for development and publishing practices.

## Run from a fresh clone

For the supported Mac experience, use macOS 13 or newer and **Node.js 22 or newer with npm**. The repository has no npm package dependencies, so there is no `npm install` step for Duet itself.

```sh
git clone https://github.com/TKindler7/Duet-Coding-Agent.git
cd Duet-Coding-Agent
npm test
```

Start an isolated development workspace:

```sh
DUET_PORT=63122 \
DUET_DATA_DIR="$PWD/data/dev" \
DUET_PROJECT_ROOT="$PWD/data/projects" \
npm run dev
```

This opens the browser and runs Duet in the foreground. Keep that Terminal session open while developing; Ctrl+C stops it. The separate port and data folders avoid reusing an installed Duet workspace. If port 63122 is occupied, choose another unused port between 1024 and 65535.

The browser setup screen can install Claude Code and Codex and connect your accounts. Model requests require internet access and accounts eligible to use those coding tools. The setup code currently installs a pinned Codex version and Claude Code's stable channel; see [src/setup.mjs](src/setup.mjs). Installed tool versions and available models can differ between machines.

For the persistent Mac app, run:

```sh
npm start
```

This copies the application into `~/Library/Application Support/Duet/app`, registers the per-user `local.duet.server` LaunchAgent, and opens the browser. The service starts at login and restarts if the server exits. After setup finishes, you can close Terminal and bookmark the displayed local address. The source installation uses the Node executable that ran `npm start`; keep that runtime available. A packaged beta includes its own Node runtime.

**Launcher names:** the repository-root `Start Duet.command` is the older interactive, single-prompt CLI launcher. It is not the browser installer. Use `npm start` for the browser app from a clone. The `Start Duet.command` inside a generated Mac beta ZIP is a different launcher that installs and opens the browser app.

The Mac service, guided tool installation, native folder picker, and independent project-check sandbox are platform-specific. `node src/web.mjs` can start the foreground server without requesting the Mac browser opener, but this is not a supported full Windows or Linux installer.

## Use the browser workspace

- **New chat** creates a separate conversation and, by default, a new project folder. Follow-ups in that chat include its earlier messages and saved project decisions. Very long conversations use bounded excerpts; the full history stays saved.
- **Ask** discusses an idea or reads project files through Claude's read-only tools. It does not edit files or run project commands.
- **Build** plans, implements, checks, and reviews the request with Claude Code and Codex. **Best quality** is the default; **Balanced** and **Save usage** use different routing policies.
- **Work in parallel** by starting another chat while one is running. There are three working slots. At capacity, you can keep writing a draft and send it when a slot becomes free.
- **Stop** cancels only the selected chat's turn. Other chats keep working. The same chat and overlapping project folders, including aliases and subfolders, cannot run conflicting work simultaneously.
- **Project settings** lets you choose a folder before the first message and save preferences for later turns. After the chat starts, its project stays attached. Choosing the same existing project in another chat shares files, not conversation history.

Choose **Connect Claude** or **Connect ChatGPT** and finish the provider's browser sign-in. Duet detects completion automatically. **Continue sign-in** opens the current provider link, and **Cancel sign-in** ends that attempt without signing out an existing account. If Claude explicitly gives you a one-time code, enter it in Duet's temporary code field. Passwords stay on the provider's page. Installations and sign-in are kept separate from active builds.

Normal account setup, chats, builds, previews, checkpoints, and feedback work in the browser after the initial installation. macOS permission prompts still need your attention. Reopen the packaged launcher, or run `npm start` from the clone, when the service needs starting or updating. Updates defer while work or account setup is active.

## Check and recover the result

Before a build edits files, Duet saves a checkpoint of eligible project source. If it cannot make a safe checkpoint, it stops before editing. **Save checkpoint** keeps another version; **Restore** first saves the current files as a recovery checkpoint. Chats remain intact. Credentials, dependencies, generated outputs, and symlinks are excluded. See [RECOVERY.md](RECOVERY.md) for the exact scope and limits.

Plans include numbered requirements. The builder reports evidence against them, and Duet separately runs declared `npm test` and `npm run build` scripts. These independent checks require macOS's `/usr/bin/sandbox-exec` and npm installed beside the selected Node executable in its expected `lib/node_modules/npm` layout. They have no network access, do not install dependencies, do not inherit provider credentials, and cannot write outside the project and temporary scratch folder or into `.duet`. Each check has a two-minute limit and a 1 MiB output limit. Missing tools, unavailable sandboxing, unsupported platforms, or missing scripts are reported as **Not run**; Duet does not silently retry without the sandbox.

A successful script exit is evidence that the script passed, not proof of every requirement. Assistant-reported passes remain distinct from independent checks. Review the evidence and try the app yourself. **Works for me** and **Needs fixes** save your feedback locally; **Your build results** summarizes those observations by coordinator mode.

**Open app preview** serves built or static HTML from `dist`, `build`, `out`, the project root, or `public`, on a separate loopback origin. It does not start project scripts, backend services, or dependency installation. Uncompiled TypeScript/JSX needs a build first. Remote API calls and form submissions are disabled in this preview. Apps needing a backend require their own launch workflow. A preview is not an automatic browser test.

After restoring a project, earlier checks are marked stale. Old generated pages are not reused as previews of restored source; rebuild or verify the current version.

## Coordinator and usage limits

| Mode | Default workflow | Maximum agent steps by default |
| --- | --- | --- |
| Best quality | Stronger planning, both coding partners, independent review | 16 |
| Balanced | Task-dependent paired work, focused implementation, deeper review for complex work or repairs | 10 |
| Save usage | One implementation pass, bounded planning and review, escalation for harder work | 6 |

The planning model assesses complexity and proposes acceptance criteria. Inspectable rules in [src/coordinator.mjs](src/coordinator.mjs) choose the models, enforce the selected limits, and retain independent review. Repeated findings stop an unproductive repair loop. These are routing policies, not a trained coordinator or a demonstrated quality or cost ranking.

The activity panel records requested models, reasoning effort, routing reasons, agent steps, and available token reports. An agent step is a CLI invocation that may contain multiple model requests. Missing usage is unknown, not zero. The optional token threshold is checked between steps, so a running step may exceed it. Neither limit is a hard spending cap or a view of remaining subscription credits. Duet does not buy credits or switch billing accounts. A recognized unavailable-model error can use one provider-default fallback; ordinary failures, quota limits, and permission restrictions do not trigger that fallback.

## Timeouts and recovery in 0.9

Build and Ask model steps allow up to **60 minutes**, with a separate **10-minute limit without stdout or stderr activity**. Claude streams output, and both providers expose activity timing in the browser. Recent output shows that a helper is still working; a quiet helper shows a waiting state. Activity renews the inactivity timer without removing the one-hour ceiling. Account checks and local verification retain shorter limits.

At a model timeout, Duet preserves project edits, completed handoffs, and available partial-response records, then marks the turn **Paused** or **Needs attention**. Send a follow-up to continue from the current files. Duet does not automatically repeat an editing step, change models, or spend another model call after a timeout. The CLI's `--timeout` option changes the hard model-step limit.

Browser requests have separate deadlines: 60 seconds for state and account refresh, 90 seconds for message acceptance, and 120 seconds for checkpoint writes. A slow request alone does not mark the whole app offline. If a send response is lost, Duet checks the message ID against saved messages, clears only an unchanged accepted draft, and retains the ID for a deliberate retry otherwise. Newer draft edits remain intact.

Stopping a turn cancels its helper and child processes. After a server restart, unfinished turns are marked interrupted and are not automatically rerun. A project `.duet/active.lock` can remain after a forced crash; inspect it and confirm the old helper has ended before removing it.

## Local data and privacy

| Data | Installed service | Foreground development |
| --- | --- | --- |
| Chats and connection configuration | `~/Library/Application Support/Duet/data` | Repository `data/`, or `DUET_DATA_DIR` |
| Default new projects | `~/Library/Application Support/Duet/Projects` | `~/Documents/Duet Projects`, or `DUET_PROJECT_ROOT` |
| Service logs | `~/Library/Application Support/Duet/logs` | Terminal output |
| Detailed build records and checkpoints | Each project's `.duet/` directory | Each project's `.duet/` directory |

Browser drafts are stored locally by chat ID. First-time service installation can import source-folder `data` files without overwriting existing installed chats. Older build history is imported into separate conversations. Keep runtime data, generated projects, logs, and provider credentials out of Git and shared beta archives.

Duet binds to `127.0.0.1`, normally on port 63121. Opening its plain local address establishes an HttpOnly, SameSite=Strict browser session. APIs check the local Host and same-origin request evidence; native clients retain bearer-token support. Do not expose the service through a public tunnel or use it as a multi-user hosted server.

Helpers use fresh CLI sessions supplied with the selected chat context, not private history from another desktop conversation. Prompts and project files read by the helpers go to your model providers under your own accounts. The providers' official tools manage credentials. Sign-in links and one-time codes are not saved in chat history or feedback.

Build records can contain prompts, source content, and model responses. Review generated code and redact sensitive material before sharing logs or screenshots. **Share beta feedback** copies a note for you to send; it does not send anything automatically. Build helpers do not publish, deploy, make purchases, or push project commits automatically.

## Tests and the CLI

```sh
npm test
npm run test:ui
npm run cli -- --help
npm run cli -- --doctor
```

`npm test` includes the subprocess, API, persistence, installer, timeout, and browser-state regression checks. Tests use mock assistants and do not spend model credits. Some tests need permission to open loopback sockets or invoke the Mac sandbox. A skipped platform-specific check is not evidence that the feature works on that platform. CI runs the suite on macOS with Node 22.

The CLI remains available for a single build without the chat interface. Create a separate project folder before running it; this command uses your connected providers and may consume account usage:

```sh
mkdir -p "$PWD/data/example-project"
npm run cli -- --project "$PWD/data/example-project" "Build a small static recipe organizer"
```

For a controlled comparison, `node src/benchmark.mjs init "$PWD/data/comparison"` prepares isolated Claude, Codex, and Duet trials without making provider calls. Use a new destination folder. Run and score the trials separately, then use `node src/benchmark.mjs report "$PWD/data/comparison"`. Missing scores are not passes. The kit is an evaluation tool, not a published benchmark result or proof of credit savings.

## Package a shareable Mac beta

Packaging requires a Mac, Node with npm, `/usr/bin/tar`, and `/usr/bin/ditto`. Runtime downloads require internet access. The builder currently accepts **Node 22.x** archives for both Apple Silicon and Intel, even though development permits Node 22 or newer. It verifies archive hashes against the supplied official checksum file and includes third-party runtime notices. It does not sign or notarize the resulting beta.

The following uses the Node version used by the existing beta. Obtain the checksum file and both archives directly from the corresponding official Node release, and keep them together:

```sh
DUET_NODE_VERSION=v22.23.3
DUET_DOWNLOADS="$PWD/data/node-downloads/$DUET_NODE_VERSION"
mkdir -p "$DUET_DOWNLOADS"
curl --fail --location --output "$DUET_DOWNLOADS/SHASUMS256.txt" "https://nodejs.org/dist/$DUET_NODE_VERSION/SHASUMS256.txt"
curl --fail --location --output "$DUET_DOWNLOADS/node-$DUET_NODE_VERSION-darwin-arm64.tar.gz" "https://nodejs.org/dist/$DUET_NODE_VERSION/node-$DUET_NODE_VERSION-darwin-arm64.tar.gz"
curl --fail --location --output "$DUET_DOWNLOADS/node-$DUET_NODE_VERSION-darwin-x64.tar.gz" "https://nodejs.org/dist/$DUET_NODE_VERSION/node-$DUET_NODE_VERSION-darwin-x64.tar.gz"
node distribution/build-macos.mjs \
  --node-version "$DUET_NODE_VERSION" \
  --checksums "$DUET_DOWNLOADS/SHASUMS256.txt" \
  --node-arm64 "$DUET_DOWNLOADS/node-$DUET_NODE_VERSION-darwin-arm64.tar.gz" \
  --node-x64 "$DUET_DOWNLOADS/node-$DUET_NODE_VERSION-darwin-x64.tar.gz" \
  --out "$PWD/data/releases/Duet-Mac-Beta-0.9.0"
```

The builder produces an extracted folder, a ZIP, and a ZIP SHA256 file. It refuses to overwrite an existing output; use a new destination for another build. The package uses an application-file allowlist and excludes local chats, generated projects, tokens, and creator credentials. Share the generated ZIP, never your installed Application Support directory. Checksums detect corruption; they do not replace signing or notarization.

The recipient extracts the whole ZIP and opens its **Start Duet.command**, then installs tools and signs in through the browser. See [START HERE.txt](distribution/START%20HERE.txt) and [BETA-TEST.md](distribution/BETA-TEST.md). The beta remains unsigned; follow normal macOS security prompts rather than disabling download protections. A fresh-machine installation and sign-in test remains part of release validation.

## Troubleshooting the installed service

If the browser cannot connect, reopen the packaged launcher or run `npm start` from the source checkout. If an already loaded page shows a reconnect banner, reload or choose **Reconnect**. This restores the local browser session without signing you out of the model providers. A port conflict is reported instead of silently changing the address.

Inspect `server.log` and `server-error.log` in the installed log directory. The installed service uses its copied application, so source edits require reopening the launcher or running `npm start` while idle. `npm run dev` is the foreground workflow for source changes.

To stop the installed background service after active work finishes:

```sh
launchctl bootout "gui/$(id -u)/local.duet.server"
```

Its registration remains at `~/Library/LaunchAgents/local.duet.server.plist`. Removing that registration after stopping the service prevents startup at the next login; it does not remove chats or projects. Running `npm start` or the packaged launcher registers it again. Preserve data before removing or migrating an installation.
