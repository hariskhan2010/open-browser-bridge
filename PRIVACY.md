# Privacy Policy: Open Browser Bridge

_Last updated: 6 October 2026_

Open Browser Bridge is an open-source browser extension that lets AI agents you choose operate your browser. This policy explains what data it handles.

## Summary

- **We collect nothing.** The project has no servers, accounts, analytics or telemetry. The developers never receive your data.
- Data moves only between your browser, programs on **your own computer**, and the AI provider **you** configure.

## What the extension accesses, and where it goes

| Data | When | Where it goes |
|---|---|---|
| Page content (text, accessibility tree, screenshots, console messages, network request URLs) | Only when an agent you connected calls a tool on a tab in its own tab group, after you allowed that site | To the local agent program on your computer (via the native messaging host), or, for the side panel chat, to the AI provider you configured |
| Files you ask an agent to upload | Only when an agent calls `file_upload` | Read by the local program and set on the page's file input, as if you had chosen them |
| Side panel API key | When you enter it in the side panel settings | Stored in the extension's local storage in your browser profile; sent only to the provider's API endpoint you configured |
| Settings, site permissions, action log, shortcuts | When you change them or an agent acts | Stored locally in your browser profile |

The AI provider you choose (for example Anthropic, OpenAI, OpenRouter, or a local model such as Ollama) processes the content you send to it under **its own** privacy policy.

## Permissions

- **debugger**: performs real mouse and keyboard input, takes screenshots and reads console and network events in the agent's own tabs. It is attached only to tabs in an agent's tab group.
- **tabs, tabGroups**: create and manage each agent session's dedicated tab group.
- **scripting, host access (all sites)**: read the page structure and fill forms on sites you allow. Sites need your permission per site (or a setting you choose) before an agent can act.
- **nativeMessaging**: talk to the local helper program that connects AI agents on your computer.
- **storage**: keep your settings, site permissions, shortcuts and action log locally.
- **downloads**: save GIF recordings you ask for.
- **alarms**: keep the local connection alive.
- **sidePanel**: show the optional chat panel.

## Your control

- Per-site prompts (once / session / always / deny), editable allow, ask and block lists.
- A **Stop all agent actions** button that pauses every agent immediately.
- An activity log of every click, keystroke and form fill.
- Remove everything by uninstalling the extension and running `node uninstall.js`.

## Contact

Open an issue in the project's GitHub repository.
