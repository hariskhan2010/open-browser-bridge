# Chrome Web Store listing (copy into the developer dashboard)

**Name:** Open Browser Bridge

**Summary (132 chars max):**
Let any AI agent (Claude Code, Codex, Gemini CLI, Cursor, any MCP client) use your browser safely in its own tab group. Open source.

**Category:** Developer Tools

**Description:**

Open Browser Bridge connects AI agents to your real browser, with your logged-in sessions, so they can test web apps, read pages, fill forms and automate repetitive work. It's open source and works with any AI that supports the Model Context Protocol (MCP): Claude Code, Codex CLI, Gemini CLI, Cursor, VS Code, Windsurf, Cline and more.

• Same tool set as Claude in Chrome: navigate, click, type, screenshots, accessibility tree with element refs, find, form filling, page text, JavaScript, console and network logs, file uploads, GIF recording and batched actions
• Each agent session works in its own tab group and can't touch your other tabs
• You approve each site, either in your agent's terminal or in the browser, with a Stop button and an activity log
• Optional side panel chat: bring your own API key for Anthropic, OpenAI, OpenRouter, Groq, or a local model via Ollama or LM Studio
• No accounts, no telemetry, no servers. Everything runs on your computer.

Setup needs the free companion helper (Node.js) from the GitHub project. Run `node install.js` and add the MCP server to your agent.

Not affiliated with Anthropic, OpenAI or Google.

**Single purpose description:**
Lets AI agents chosen by the user operate the user's browser through a dedicated tab group, with per-site user permission.

**Permission justifications:**

- **debugger**: Required to send real mouse and keyboard input, capture screenshots, and read console and network events for the tabs an AI agent controls. It is attached only to tabs in the agent's dedicated tab group, after the user allowed the site.
- **tabs**: Create, list and close the agent's tabs and read their URLs and titles to report them to the agent.
- **tabGroups**: Keep each agent session in its own labelled tab group, isolated from the user's other tabs.
- **scripting**: Read the page's accessibility structure, find elements and fill forms in the agent's tabs.
- **Host permission <all_urls>**: The user decides which sites agents may use. Each site requires the user's approval unless the user changes this in settings.
- **nativeMessaging**: Communicate with the locally installed helper program through which AI agents on the user's computer connect.
- **storage**: Save settings, per-site permissions, shortcuts and the action log locally.
- **downloads**: Save GIF recordings of agent sessions when requested.
- **alarms**: Periodically check the connection to the local helper and reconnect if needed.
- **sidePanel**: Show the optional chat interface.

**Remote code:** No. All code is included in the package. The side panel sends prompts to the AI provider API the user configures, and it never executes code from it.

**Data usage disclosures:** Website content is handled only to provide the feature the user asked for. It is not sold, not used for advertising and not transferred to the developer. Privacy policy: PRIVACY.md in the repository (host it, e.g. via GitHub Pages, and paste its URL).

**Screenshots to upload (1280×800):** the side panel chat doing a task, the per-site permission prompt, the tab group in use, and the settings page.
