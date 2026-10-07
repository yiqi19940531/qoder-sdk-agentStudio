# Qoder Agent Workbench demo: quick start

## Install and sign in

Target platforms: macOS, Linux, Windows x64. Install Node.js **22.12+** (minimum 20.19) and npm. Install [Qoder CLI](https://docs.qoder.com/cli/installation), run `qoder` to sign in, then check `qoder --version` and `qoder --list-models`. The packaging machine was validated with CLI **1.1.65**. This project pins [Qoder SDK](https://docs.qoder.com/cli/sdk/overview) **1.0.50**, which bundles runtime **1.1.64**; you do not need to downgrade your system CLI.

Install Google Chrome for browser MCP. Python 3 and your own Bailian API key are optional for **new** image/video generation; existing media can be viewed without them. On Windows x64, check Python with `py -3 --version`.

## Start in one command

Extract the archive, enter `qoder-agent-workbench-demo`, then run:

```sh
node scripts/quickstart.mjs
```

Alternatively use `sh start.sh` on macOS/Linux or `start.cmd` in Windows Command Prompt. The script checks the environment, runs `npm ci` on first launch, builds, and starts the local server. Open **http://127.0.0.1:8787**. The first installation requires internet access. Press Ctrl+C to stop.

## Explore

The package contains six Agents, three Skills, keyless MCP definitions, 34 conversations with events and flow diagrams, success and failure records, and four generated media files. Old conversations are marked **Demo archive** and are read-only. Asking a question from an archive creates a **new** SDK conversation with your account and only your new question; old SDK context is not automatically carried over. Quote anything you need from the archive in your new prompt.

Suggested tasks without optional keys:

- Repository coordinator: “Read `calculator.ts`, delegate a boundary-case review to the code reviewer, then summarize.”
- Code reviewer Sub-Agent: “Review `calculator.ts` without editing and give one testable improvement.”
- Web exploration Agent: “Use Playwright or Chrome DevTools MCP to inspect a local or public page and describe its structure.” Chrome is required.
- AIGC director: inspect previous artifacts and plan image/video prompts. New generation requires Bailian credentials.
- Image and video Sub-Agents: view prior output; configure Bailian before generating new media.

All Agents start with per-call approval and working-directory-only access. The global always-allow tool list is empty.

## Models and optional services

The public Agent definitions use Qoder built-in `auto` or `efficient`. The model list comes from your signed-in account. No Token Plan is required. If a later saved model is unavailable to your account, a new conversation temporarily uses available built-in `auto` and reports the actual model in its events, without changing the saved Agent. To use your own model, configure it through `/model` in Qoder CLI using the [custom model guide](https://docs.qoder.com/cli/custom-models), then select it in the workbench.

**Apify:** In “Configuration → MCP services,” select the retained `apify` definition, enter your own Bearer Token, save, and check the connection. Once tools are discovered, attach it to the web exploration Agent. The token is stored locally in `data/mcp-secrets.json`; new sessions also create local connection snapshots. Neither is included in this release. Playwright, Chrome DevTools, and repository MCP remain available without Apify.

**Bailian:** Create `api-key.md` in the extracted root with exactly one of your own Bailian `sk-` keys and exactly one HTTPS Beijing workspace URL whose path begins `/compatible-mode/v1`. For example:

```text
Key: <your own Bailian key>
Endpoint: <your full workspace compatible-mode/v1 URL>
```

Restart the service. The app reads this file and invokes Python 3 for generation. On Windows it defaults to `py -3`; set `AIGC_PYTHON` to override the executable. Keep `api-key.md`, `data/mcp-secrets.json`, and `data/mcp-session-config/` private. Existing media and failure records need no key.

## Release checks

`npm run package:public` rebuilds from an allowlist without altering original histories. Staged files and ZIP entries are scanned for known keys, common credential patterns, authorization headers, local home paths, and forbidden files. `DEMO-MANIFEST.json` records inventory. See `VALIDATION.md` for actual platform and test results.
