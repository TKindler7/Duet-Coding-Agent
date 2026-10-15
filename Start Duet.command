#!/bin/bash
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "Duet — one prompt; Claude and Codex code together."
echo
if ! node src/cli.mjs --doctor; then
  echo
  echo "Complete the sign-in command shown above in Terminal, then reopen Duet."
  read -r -p "Press Return to close. " reply
  exit 1
fi
read -r -p "Project folder (absolute path): " project
if [[ "$project" != /* ]]; then
  echo "Enter an absolute folder path, such as /Users/yourname/Documents/my-app."
  read -r -p "Press Return to close. " reply
  exit 1
fi
if [[ ! -d "$project" ]]; then
  read -r -p "That folder does not exist. Create it? [Y/n] " create_folder
  case "$create_folder" in
    ""|y|Y|yes|YES)
      if ! mkdir -p -- "$project"; then
        echo "Could not create that folder. Check the path and folder permissions."
        read -r -p "Press Return to close. " reply
        exit 1
      fi
      ;;
    *) exit 0 ;;
  esac
fi
read -r -p "What would you like them to build? " prompt
node src/cli.mjs --project "$project" -- "$prompt" || result=$?
echo
read -r -p "Press Return to close. " reply
exit "${result:-0}"
