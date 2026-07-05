# Pi extension — Model Server

A [Pi](https://pi.dev) extension that wires the local model-server install into Pi:

- registers an OpenAI-compatible provider named **modelserver** populated from `/v1/models`
- pulls the user's skill catalog from `/api/skills` and exposes every enabled skill as a Pi tool that proxies to `/api/skills/:name/execute`
- registers **interactive shell/SSH session tools** that keep a real terminal open across turns (see below)

The 120+ default skills (web search, URL fetch, code navigation, file ops, OCR, PDF, etc.) become callable from any Pi conversation without further configuration.

## Interactive shell sessions

Pi's built-in `bash` tool is one-shot — every call is a fresh process, so `cd`, environment variables, an SSH connection, or a REPL are all lost between calls. The model works around that by writing throwaway scripts, which is slow and brittle for anything interactive (a remote shell, a password prompt, a live console).

This extension adds tools that hold a **persistent interactive process open across turns** and let the model drive it like a person at a terminal:

| Tool | Purpose |
|---|---|
| `ssh_connect` | Open a persistent SSH session to a remote host (`ssh -tt` + keepalive; one connection reused for the whole task). Use for any "connect to / work on machine X" request. |
| `shell_open` | Same mechanism for any long-lived local process — a login shell (default), `docker exec -it …`, a database/REPL client, a serial console. |
| `shell_exec` | Type a command line into an open session and return its output once it settles. **State persists between calls** — cwd, env, the SSH connection, your place in a REPL. |
| `shell_send` | Send raw keystrokes — password prompts, `y/n` confirmations, REPL input, or control keys (`ctrl-c`, `ctrl-d`, `esc`, `tab`, `enter`, `up`/`down`/`left`/`right`, …). |
| `shell_read` | Poll a long-running or streaming command (build, download, `tail -f`, a live TUI) for new output without sending input. |
| `shell_close` / `shell_list` | Close a session (SIGTERM→SIGKILL) / list open sessions (id, command, status, idle time, unread bytes). |

**Typical flow** — connect, answer the password prompt, then navigate with state preserved:

```
ssh_connect { destination: "user@host" }        → surfaces the password: prompt
shell_send  { text: "<password>" }               → logs in
shell_exec  { command: "cd /var/log && tail -50 syslog" }
shell_exec  { command: "pwd" }                    → still /var/log (cwd persisted)
```

**Live/interactive consoles** — launch, poll frames, interrupt:

```
shell_exec { command: "pihole -t" }   → launches the live DNS query log
shell_read { timeoutMs: 7000 }        → returns new log lines as they stream in
shell_send { key: "ctrl-c" }          → stops it, back at the prompt
```

Notes:

- **No native modules.** On Linux/macOS the process is wrapped in `script`, which allocates a real pty — so remote programs see a terminal, prompts appear, and interactive tools behave. There's no `node-pty`, so the installer never needs a compiler toolchain. On platforms without `script` it falls back to plain pipes (SSH still works because `ssh_connect` always passes `-tt`).
- **Local, not server-side.** These tools run in your Pi process on your machine (like Pi's own `bash`), not inside the webapp container — they're registered even when the model server is unreachable or `MODELSERVER_API_KEY` is unset.
- Output is ANSI-stripped and carriage-return-resolved so the model reads clean text. Sessions are capped (8 concurrent), buffer-capped, and idle sessions are reaped after 30 minutes. `ssh_connect` rejects destinations containing shell metacharacters.
- Every tool takes an optional `session` id; it defaults to the most recently used session, so single-session workflows never need to pass it.

## Quick start

1. Create a bearer-mode API key in the webapp's **API Keys** tab. Pi authenticates via `Authorization: Bearer …` — regular key+secret pairs won't dispatch.

2. Run the auto-installer. The endpoint is auth-gated; pipe straight to bash:

   ```bash
   export MODELSERVER_API_KEY="<bearer-mode-key>"
   curl -fsSk -H "Authorization: Bearer $MODELSERVER_API_KEY" \
     https://<your-host>:3001/api/pi/install | bash
   ```

   `install.sh` self-corrects for: corporate MITM proxies (writes `~/.curlrc`, sets `NODE_TLS_REJECT_UNAUTHORIZED=0`, `npm strict-ssl=false`), missing or too-old Node (installs Node 22 LTS via NodeSource, falls back to nvm), missing Pi, missing curl, broken sudo, root vs non-root. Idempotent — re-run anytime.

3. Run Pi:

   ```bash
   pi
   ```

   The script persists `MODELSERVER_BASE_URL` to your shell rc. Keep `MODELSERVER_API_KEY` in your shell (don't commit it to rc) and you're set.

### Manual install

If you'd rather not pipe to bash, the auto-installer is the same `install.sh` shipped in this directory. Drop it next to `modelserver.ts`/`package.json` and run it. Or do the steps by hand:

```bash
npm install -g @earendil-works/pi-coding-agent
mkdir -p ~/.pi/agent/extensions/modelserver
cp modelserver.ts package.json ~/.pi/agent/extensions/modelserver/
( cd ~/.pi/agent/extensions/modelserver && npm install --omit=dev )
# Then write ~/.pi/agent/settings.json with defaultProvider="modelserver"
```

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `MODELSERVER_BASE_URL` | baked-in at serve time | Webapp HTTPS endpoint |
| `MODELSERVER_API_KEY` | — | Bearer-mode API key (required) |
| `MODELSERVER_INSECURE_TLS` | auto for localhost/RFC-1918 | `1` to accept self-signed certs |
| `MODELSERVER_INCLUDE_LOCAL_SHADOW` | off | `1` to also register file/git/code-nav/shell skills (default off — they execute inside the webapp container's `/workspace`, not your local `$PWD`, which surprises most users) |

## Notes

- By default the extension skips skills that shadow Pi's built-in local tools (`read`, `bash`, `edit`, `write`, search). Pi handles your local files via its built-ins; the extension contributes server-side specialty work (`web_search`, `playwright_*`, `render_chart`, `query_sqlite`, `transcribe_audio`, `transform_image`, `parse_*`, etc.). Set `MODELSERVER_INCLUDE_LOCAL_SHADOW=1` if you actually want server-side filesystem access (e.g. inspecting `/workspace/` artifacts).
- Skill parameters are mapped to Typebox schemas with every field marked optional. The skill execution layer already accepts multiple parameter-name aliases per field, so loose tool calls tend to dispatch correctly.
- Tool results larger than ~12 KB are truncated in the rendered text, but the full JSON payload is attached as `details` for inspection.
- Disabling a skill in the webapp removes it from the tool catalog after the next `pi` restart.
