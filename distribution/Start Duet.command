#!/bin/bash
set -u
bundle_dir="$(cd "$(dirname "$0")" && pwd)"
fail() {
  printf '\nDuet could not start: %s\n' "$1"
  printf '\nNo administrator access is needed. Your chats and projects have not been removed.\n'
  read -r -p 'Press Return to close. ' duet_reply
  exit 1
}
[[ "$(/usr/bin/uname -s)" == Darwin ]] || fail 'This beta is for macOS.'
mac_version="$(/usr/bin/sw_vers -productVersion)"
mac_major="${mac_version%%.*}"
[[ "$mac_major" =~ ^[0-9]+$ ]] && [[ "$mac_major" -ge 13 ]] || fail 'macOS 13 or newer is required.'
if [[ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]]; then
  runtime_arch=arm64
elif [[ "$(/usr/bin/uname -m)" == x86_64 ]]; then
  runtime_arch=x64
else
  fail 'This Mac processor is not supported.'
fi
bundled_node="$bundle_dir/runtimes/darwin-$runtime_arch/bin/node"
node_hash_file="$bundle_dir/runtimes/darwin-$runtime_arch/node.sha256"
[[ -x "$bundled_node" && -f "$node_hash_file" ]] || fail 'The download is incomplete. Extract the entire ZIP and keep its files together.'
expected_node_hash="$(/bin/cat "$node_hash_file")"
[[ "$expected_node_hash" =~ ^[0-9a-f]{64}$ ]] || fail 'The runtime integrity file is invalid. Download a fresh copy.'
actual_node_hash="$(/usr/bin/shasum -a 256 "$bundled_node")" || fail 'Could not check the included runtime.'
actual_node_hash="${actual_node_hash%% *}"
[[ "$actual_node_hash" == "$expected_node_hash" ]] || fail 'The included runtime is damaged. Download a fresh copy.'
printf 'Duet Mac Beta\n\nStarting your private app-building workspace…\n'
printf 'On first launch, Duet installs its files in your Library/Application Support folder.\n'
printf 'It will open your browser when ready. Sign in with your own accounts there.\n\n'
"$bundled_node" "$bundle_dir/app/src/bootstrap-mac.mjs" --bundle "$bundle_dir" --arch "$runtime_arch"
duet_exit=$?
if [[ "$duet_exit" -ne 0 ]]; then
  printf '\nSee START HERE.txt for help. macOS privacy or security messages must be approved by you.\n'
  read -r -p 'Press Return to close. ' duet_reply
  exit "$duet_exit"
fi
printf '\nDuet is ready. You may close this Terminal window; Duet will keep running.\n'
printf 'Continue setup and sign-in in your browser. Bookmark Duet to open it next time.\n'
