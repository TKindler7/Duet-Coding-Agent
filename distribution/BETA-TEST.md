# Duet Mac beta — quick test

Duet is a local app-building workspace. You describe what you want; Claude Code and Codex work on the project using your own connected accounts. You can keep separate chats and continue a project with follow-up messages.

## First launch

1. Unzip the beta and keep the extracted folder together.
2. Double-click **Start Duet.command** inside it. The launcher opens Terminal, prepares Duet, and opens the workspace in your browser. If macOS shows a warning or the launcher does not open, follow **START HERE.txt** and capture the exact message for your feedback.
3. Follow Duet’s setup screen to install any missing coding tools. Wait for each installation to finish.
4. Choose **Connect Claude** and **Connect ChatGPT**, one at a time, and finish each provider’s sign-in page in your browser. Use your own accounts; there is no separate Duet account. If Claude gives you a one-time code, paste it into the code field in Duet.
5. Duet detects each connection automatically. Check that it says **Both connected**. You can close Terminal after the launcher finishes and bookmark Duet to return later.

If the sign-in page does not open, choose **Continue sign-in**. You can cancel or retry from Duet. Passwords stay on the provider’s website; model usage follows the accounts you connect. Normal macOS permission prompts still need your attention.

## Try a small build

Start a **New chat**, choose **Build**, and send:

> Build a small recipe organizer that runs locally in a browser. Let me add, edit, delete, and search recipes, including ingredients and instructions. Save recipes locally so they survive a refresh. Use a clean, responsive design. No backend, login, or paid API is needed. Both coding partners should contribute, test the main controls, and tell me exactly how to open the finished app.

During the build, check that you can see progress and that the final response explains the result. Open the generated app using its instructions and try its controls.

Then send a follow-up in the **same chat**:

> Add a light/dark theme switch and remember my choice. Keep the recipe features working.

Check that Duet continues the existing project and remembers the earlier request.

## Check the chat experience

- Start another **New chat** and choose **Ask**. Send: “Help me plan a small photo journal. Keep the plan short; do not build it yet.”
- Switch between the recipe and photo-journal chats. Each should show its own messages and draft, with a separate default project folder.
- Ask a follow-up in the photo-journal chat. It should use that chat’s context.
- Close the browser window, reopen your Duet bookmark, and confirm both conversations remain available without opening Terminal.
- Open the plain local address displayed by Duet in a fresh browser tab. You should reach the workspace without copying a secret link.

## Text back your feedback

Use **Share beta feedback** in Duet to rate setup and the build, add your notes, review the diagnostic preview, and choose **Copy feedback**. Paste that into a text to the person who sent you the beta.

If Duet will not open, use this template instead:

```text
Duet beta feedback
Mac model / Apple silicon or Intel:
macOS version:
First installation, or updating an earlier Duet:

Installation and sign-in: worked / got stuck
First build: worked / got stuck
Follow-up changes: worked / got stuck
Separate chats and reopening: worked / got stuck

What I tried:
What I expected:
What actually happened:
Exact error message, if any:
Screenshot attached:

Most confusing part:
One thing I would change:
```

Include screenshots of the relevant screen, but leave out passwords, login codes, API keys, and private project content. Duet does not automatically send this feedback.
