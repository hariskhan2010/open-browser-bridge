# Open Browser Bridge

Open-source browser control for **any** AI agent. A Chrome/Edge/Brave extension, a native messaging host and an MCP server. The tool surface matches **Claude in Chrome**: same tool names, same parameters, same behaviour. Prompts and skills written for it work unchanged with Claude Code, Codex CLI, Gemini CLI, Cursor, VS Code, Windsurf, Cline or any other MCP client.

> Independent project. Not affiliated with or endorsed by Anthropic. It contains no Anthropic code.

```
Agent ──MCP (stdio or HTTP)──▶ host/mcp-server.js ──authenticated pipe──▶ host/native-host.js ──Native Messaging──▶ extension (MV3)
                                                                                                               ├─ chrome.debugger (CDP): real mouse/keyboard, screenshots, console, network, dialogs
                                                                                                               ├─ content/page.js: accessibility tree, ref_N element IDs, find, forms, text, files
                                                                                                               └─ tab group per agent session, per-site permissions, activity log, Stop button
```

## Install (Windows, macOS, Linux)

Requires Node.js 18+ and Chrome/Edge/Brave/Vivaldi/Chromium 116+. No npm dependencies.

```bash
node install.js
```

1. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked** and pick the `extension` folder. The ID must match the one the installer printed.
2. **Restart the browser once** so it reads the native host registration.
3. Click the toolbar icon. It should say **Connected to the native host**.
4. Add the MCP server to your agent. `node install.js --print` shows the exact lines, for example:
   ```bash
   claude mcp add --scope user open-browser-bridge -- node /path/to/host/mcp-server.js
   ```
   Most other clients use the JSON form: `{"mcpServers":{"open-browser-bridge":{"command":"node","args":["/path/to/host/mcp-server.js"]}}}`.
   HTTP clients: run `node host/mcp-server.js --http` and connect to `http://127.0.0.1:12407/mcp` with the bearer token it prints.

Uninstall: `node uninstall.js`, then remove the extension.

## Tools

| Tool | What it does |
|---|---|
| `tabs_context_mcp` | List this session's tab group (`createIfEmpty` makes a window + group + empty tab). Call first. |
| `tabs_create_mcp` / `tabs_close_mcp` | Open / close tabs in the group |
| `navigate` | Go to a URL, or `back`/`forward`. Without `tabId` it creates the group and uses its first tab |
| `computer` | `left_click`, `right_click`, `double_click`, `triple_click`, `type`, `key`, `screenshot`, `wait`, `scroll`, `left_click_drag`, `zoom`, `scroll_to`, `hover`. Real CDP input; coordinates or `ref`; `modifiers`, `repeat`, `scale`, `save_to_disk`, `action_summary` |
| `read_page` | Accessibility tree with stable `ref_N` IDs (`filter`, `depth`, `ref_id`, `max_chars`) |
| `find` | Natural-language element search, up to 20 refs |
| `form_input` | Set inputs, selects, checkboxes, contenteditable by ref |
| `get_page_text` | Article-first plain text |
| `javascript_tool` | Run JS in the page with REPL semantics (top-level `await`, last expression returned) |
| `read_console_messages` / `read_network_requests` | Per-tab buffers, cleared on cross-domain navigation |
| `file_upload` / `upload_image` | Set files on inputs or drop them on targets (10 MB limit, hard-linked files refused) |
| `gif_creator` | Record actions and export an annotated GIF (click circles, drag arrows, labels, progress bar, watermark) |
| `resize_window` | Resize the window |
| `browser_batch` | Several tool calls in one round trip; stops on the first error |
| `shortcuts_list` / `shortcuts_execute` | Saved prompts from the options page |
| `list_connected_browsers` / `select_browser` / `switch_browser` | Choose among several connected browsers |

## Side panel chat (bring your own model)

Open it with the toolbar popup's **Open side panel chat** button or **Alt+Shift+A**. In ⚙ settings, choose:

- **Anthropic** (Claude): API key and model, e.g. `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5-20251001`
- **OpenAI-compatible**: OpenAI, OpenRouter (`https://openrouter.ai/api/v1`), Groq, Ollama (`http://localhost:11434/v1`, no key needed), LM Studio, or any `/chat/completions` endpoint with tool calling

The agent works in your current tab and uses the same tools. Responses stream as they arrive, each tool call appears as an expandable step with its screenshots, permission questions appear inline in the chat, **Stop** halts it, and `/command` runs a saved shortcut. Your key stays in this browser's extension storage and is sent only to the provider you choose.

## Safety model

- **Tab isolation:** an agent can only act on tabs in its own tab group.
- **Per-site permission prompts appear in the agent's own UI** when the agent app supports MCP elicitation, like Claude Code's "Claude in Chrome wants to…" question in the terminal. The side panel asks inline. Otherwise a browser pop-up asks. The agent model itself can never answer them. The options are *once*, *this session*, *always* or *deny*. You can force browser pop-ups in Settings → *Where to ask*. The host relays an answer only from the session it asked. An "always ask" list (banks, government, sign-in providers by default) can only be approved one action at a time. A blocked list disables sites completely. Restricted pages (`chrome://`, the Web Store) get `navigate` only.
- **Stop all agent actions** in the popup pauses every agent and detaches the debugger.
- **Authenticated IPC:** the native host's pipe/socket requires a random 256-bit token stored in a user-only data folder, and connections without it are dropped. HTTP mode binds to 127.0.0.1, requires a bearer token and rejects non-local `Origin`s.
- Every click, keystroke and form fill is logged with its `action_summary` (options page).
- The server's MCP `instructions` tell agents that page content is data, not instructions, and that they should pause for logins and CAPTCHAs.

## Differences from Claude in Chrome

- `find` uses local relevance ranking over the accessibility tree instead of a hosted model.
- The site-safety list is local and editable rather than served from a vendor API.
- There is no cloud relay (local machine only).
- The side panel uses your own API key or a local model instead of a Claude subscription.
- An MCP agent calling `shortcuts_execute` gets the saved instructions to carry out itself, because a side panel can't be opened without a user click.

## Development

```bash
npm test                       # offline: MCP server, native host relay (auth, chunking), permission prompts, providers + agent loop, GIF encoder
npm run e2e                    # live: every tool against your browser (extension must be loaded)
node test/sidepanel-mock.js    # live: side panel agent driven by a scripted local "model"
npm run package                # dist/open-browser-bridge-<version>.zip for the Chrome Web Store / Edge Add-ons
```

### Publishing to the Chrome Web Store

1. `npm run package` and upload the ZIP in the [developer dashboard](https://chrome.google.com/webstore/devconsole). This requires a one-time registration fee.
2. Copy the listing text and permission justifications from `STORE_LISTING.md`, and host `PRIVACY.md` (e.g. with GitHub Pages) for the privacy-policy URL.
3. Once the store assigns an ID, add it to `store-ids.json` and re-run `node install.js` so the native host accepts the store build.

Logs: `%LOCALAPPDATA%\OpenBrowserBridge\logs` (Windows), `~/Library/Application Support/OpenBrowserBridge/logs` (macOS), `~/.local/share/open-browser-bridge/logs` (Linux).

Licence: Apache-2.0.
