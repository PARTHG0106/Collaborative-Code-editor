---
title: SyncScript workspace runtime
emoji: 💻
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
---

# SyncScript workspace runtime

Each private Docker Space runs one workspace. It supplies Bash, Python and virtual
environments, Node/npm/TypeScript, Git, C/C++, and Java. Workspace files live in
`/workspace`; `cd` returns there. This Space must never host multiple workspaces.

The runtime connects **outbound** to the API Socket.IO namespace `/runtime`.
Port 7860 serves health only and has no terminal or execution endpoint. The API
continues to enforce workspace membership for every user request.

Set `SYNCSCRIPT_API_URL`, `SYNCSCRIPT_WORKSPACE_ID`, and the secret
`SYNCSCRIPT_RUNTIME_TOKEN`. The token must authorize only this workspace's runtime
connection. Never set a Hugging Face account token, database URL, JWT signing key,
Cloudflare key, or any other backend secret here. The API uses its Hugging Face
token only against the Hugging Face control plane, never in runtime HTTP headers.

Isolation comes from the dedicated platform container. The broker runs as root
and launches all user commands as uid/gid 1000 with a clean environment, keeping
its scoped connection token out of user processes and unreadable through
`/proc`. The runtime source is root-owned. Treat all runtime messages as untrusted
on the API and bind them to the authenticated workspace. Revoke the scoped token
and rebuild the runtime after suspected compromise. Containers may
sleep or restart; editor files are restored by the API, while terminal-installed
dependencies and files not saved back to the editor are ephemeral.

Commands have a 20 second execution limit and 512 KiB combined output limit.
Interactive terminals have a 60 minute lifetime and a bounded output queue.
The API transports terminal input and resize events, and execution stdin/cancel.
No command allowlist or fake terminal is used.

Run `npm ci && npm test` for the standalone runtime tests. Tests for actual
toolchains and PTY behavior require Linux and the Docker image dependencies.
