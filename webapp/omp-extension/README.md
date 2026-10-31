# omp extension — Model Server

An [omp](https://omp.sh) (oh-my-pi) extension that wires the local model-server install into omp:

> omp replaces the earlier omp (pi.dev) integration. omp is a fork of omp with a native core, shipped as a single prebuilt binary, so nothing here needs Node or npm. The server keeps the old `/api/pi/*` routes as aliases of `/api/omp/*`; the old one-liners now install omp.

- registers an OpenAI-compatible provider named **modelserver** populated from `/v1/models`
- pulls the user's skill catalog from `/api/skills` and exposes every enabled skill as a omp tool that proxies to `/api/skills/:name/execute`
- keeps the **server sandbox workspace** visible and usable for a whole session, including across compaction (see below)
- registers **interactive shell/SSH session tools** that keep a real terminal open across turns (see below)

The 120+ default skills (web search, URL fetch, code navigation, file ops, OCR, PDF, etc.) become callable from any omp conversation without further configuration.

## The two filesystems

omp runs on **your machine**; the server's skills (`read_pdf`, `create_pdf`, `transform_image`, `query_sqlite`, …) run in a **sandbox container on the model server**, whose files live under `/workspace`. They do not share a filesystem, and confusing them is the most expensive mistake a long session can make — the agent lists files with one tool, gets "no such file" from another, decides the workspace was wiped, and starts reconstructing deliverables from memory.

The extension keeps the two straight:

| Tool | Direction |
|---|---|
| `workspace_list` | Show what the sandbox currently holds. |
| `workspace_get(workspacePath, hostPath)` | Sandbox → your machine. Use it to deliver a generated PDF/chart/image to where the user asked. Accepts a file or a directory; under WSL a `C:\Users\…` destination is translated to `/mnt/c/…`, and the write is verified before it reports success. |
| `workspace_put(hostPath[, workspacePath])` | Your machine → sandbox. Usually unnecessary: passing a host path straight to a server skill uploads it automatically. |

Supporting behavior, all automatic:

- **The sandbox is restated in the system prompt every turn** — bucket name plus a live file listing, refreshed from `/api/agent-workspaces/inventory`. This is what makes workspace knowledge survive `/compact`: compaction summarizes away tool output (results are truncated to 2 KB before the summarizer even reads them), but the system prompt is rebuilt and re-sent on every request. Right after a compaction the block additionally states that the sandbox was *not* touched, so the agent re-reads the real files instead of rebuilding a deliverable from the summary.
- **Sandbox shell skills are renamed.** `run_bash` becomes `sandbox_bash` (likewise `sandbox_python`, `sandbox_powershell`, …) so it can't be mistaken for omp's own `bash`. Every skill that takes a path argument says in its description that it operates on the server, not on your machine.
- **Handing a `/workspace/…` path to one of omp's own tools is intercepted** and answered with the tool that *can* reach it, instead of a bare `ENOENT` that teaches nothing. Real local paths — including devcontainer `/workspaces/<project>` — are untouched. If your host happens to have its own `/workspace` directory, results from it are annotated so the two are never conflated.

## Interactive shell sessions

omp's built-in `bash` tool is one-shot — every call is a fresh process, so `cd`, environment variables, an SSH connection, or a REPL are all lost between calls. The model works around that by writing throwaway scripts, which is slow and brittle for anything interactive (a remote shell, a password prompt, a live console).

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
- **Local, not server-side.** These tools run in your omp process on your machine (like omp's own `bash`), not inside the webapp container — they're registered even when the model server is unreachable or `MODELSERVER_API_KEY` is unset.
- Output is ANSI-stripped and carriage-return-resolved so the model reads clean text. Sessions are capped (8 concurrent), buffer-capped, and idle sessions are reaped after 30 minutes. `ssh_connect` rejects destinations containing shell metacharacters.
- Every tool takes an optional `session` id; it defaults to the most recently used session, so single-session workflows never need to pass it.

## Quick start

1. Create a bearer-mode API key in the webapp's **API Keys** tab (with the `agents` permission). omp authenticates via `Authorization: Bearer …` — regular key+secret pairs won't dispatch.

2. Run the auto-installer. The endpoint is auth-gated; pipe straight to bash:

   ```bash
   export MODELSERVER_API_KEY="<bearer-mode-key>"
   curl -fsSk -H "Authorization: Bearer $MODELSERVER_API_KEY" \
     https://<your-host>:3001/api/omp/install | bash && source ~/.bashrc
   ```

   `install.sh`:
   - checks the server and the key first (a wrong URL/key fails before anything is installed);
   - installs the official **prebuilt `omp` binary** into `~/.local/bin` via omp's own installer with `--binary` (checksum-verified; no Node, npm or Bun) — skipped when omp ≥ 18.14 is already there;
   - drops `modelserver.ts` + `package.json` into `~/.omp/agent/extensions/modelserver/` — omp loads the TypeScript itself and resolves `typebox` to its bundled shim, so there is no `npm install`;
   - writes `~/.omp/agent/config.yml` defaults with `omp config set`: `modelRoles` default/smol → the pair's fast model, slow → the strong model; `disabledProviders: [ollama, llama.cpp, lm-studio]` (omp otherwise probes 127.0.0.1 for local servers at every start). A config that already defaults to a non-modelserver model is left alone;
   - adds `~/.local/bin` to `PATH` and `MODELSERVER_BASE_URL` to your shell rc; handles self-signed / MITM TLS via `~/.curlrc`.

   Idempotent — re-run anytime (it refreshes the extension). `OMP_INSTALL_REF=v18.14.1` pins a release, `OMP_INSTALL_FORCE=1` reinstalls omp, `OMP_INSTALL_REMOVE_PI=1` also removes an old Pi CLI and its extension.

3. Run omp:

   ```bash
   omp                                   # interactive
   omp -p "Reply with OK"                # one-shot check (--mode json for an event stream)
   omp --model modelserver/<model-name>  # or /model inside omp
   ```

   Model ids are the server's model names (llama.cpp's `/models/<name>/<file>.gguf` is registered as `<name>`; sglang models keep their HF repo id; `auto` = whichever loaded model has a free slot). Keep `MODELSERVER_API_KEY` in your shell (don't commit it to rc).

### Windows (native — no WSL)

`install.ps1` (served at `/api/omp/install.ps1`) installs everything natively on Windows, with no WSL and no admin rights. From any PowerShell window (Windows PowerShell 5.1 or PowerShell 7+):

```powershell
$env:MODELSERVER_API_KEY = "<your-bearer-key>"
$installerUrl = "https://<your-host>:3001/api/omp/install.ps1"
$authHeaders = @{ Authorization = "Bearer $($env:MODELSERVER_API_KEY)" }
if ($PSVersionTable.PSVersion.Major -ge 6) {
    Invoke-RestMethod $installerUrl -Headers $authHeaders -SkipCertificateCheck | Invoke-Expression
} elseif (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    (curl.exe -skf -H "Authorization: Bearer $($env:MODELSERVER_API_KEY)" $installerUrl) -join "`n" | Invoke-Expression
} else {
    [Net.ServicePointManager]::ServerCertificateValidationCallback = $null
    if (-not ('TrustAllCertsPolicy' -as [type])) { Add-Type 'using System.Net;using System.Security.Cryptography.X509Certificates;public class TrustAllCertsPolicy:ICertificatePolicy{public bool CheckValidationResult(ServicePoint servicePoint,X509Certificate certificate,WebRequest request,int problem){return true;}}' }
    [Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
    Invoke-RestMethod $installerUrl -Headers $authHeaders | Invoke-Expression
}
```

(Windows PowerShell 5.1 fetches via `curl.exe` — bundled since Windows 10 1803, it talks SChannel directly and sidesteps .NET's TLS layer. Machines without `curl.exe` fall back to a compiled `ICertificatePolicy`; a scriptblock assigned to `ServerCertificateValidationCallback` would fire on a runspace-less thread and fail with "The underlying connection was closed".)

It installs the prebuilt `omp.exe` into `%LOCALAPPDATA%\omp` (on your user PATH) by running omp's own `install.ps1 -Binary` inside the same session — so the TLS workaround covers its downloads too — then the extension into `%USERPROFILE%\.omp\agent\extensions\modelserver`, the same `config.yml` defaults as on Linux, and persists `MODELSERVER_BASE_URL` / `MODELSERVER_API_KEY` to your user environment. omp uses Git Bash when Git for Windows is installed and its own built-in bash-compatible shell otherwise; a `shellPath` that points at `System32\bash.exe` (the WSL launcher shim) is removed. The Pi-era `NODE_TLS_REJECT_UNAUTHORIZED=0` user variable is removed — the extension relaxes TLS itself for a private/localhost server. The file must stay pure ASCII (PS 5.1 reads `curl.exe` output in the OEM codepage).

### Manual install

```bash
curl -fsSL https://omp.sh/install | sh            # prebuilt omp → ~/.local/bin
mkdir -p ~/.omp/agent/extensions/modelserver
curl -fsSk -H "Authorization: Bearer $MODELSERVER_API_KEY" \
  https://<your-host>:3001/api/omp/extension/modelserver.ts -o ~/.omp/agent/extensions/modelserver/modelserver.ts
curl -fsSk -H "Authorization: Bearer $MODELSERVER_API_KEY" \
  https://<your-host>:3001/api/omp/extension/package.json -o ~/.omp/agent/extensions/modelserver/package.json
omp config set modelRoles '{"default":"modelserver/<model-name>"}'
```

The extension directory needs its `package.json`: its `"omp": {"extensions": ["./modelserver.ts"]}` entry is how omp finds the entry point (a bare `modelserver.ts` in the directory is not discovered).

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `MODELSERVER_BASE_URL` | baked-in at serve time | Webapp HTTPS endpoint |
| `MODELSERVER_API_KEY` | — | Bearer-mode API key (required) |
| `MODELSERVER_INSECURE_TLS` | auto for localhost/RFC-1918 | `1` to accept self-signed certs |
| `MODELSERVER_INCLUDE_LOCAL_SHADOW` | off | `1` to also register file/git/code-nav/shell skills (default off — they execute inside the webapp container's `/workspace`, not your local `$PWD`, which surprises most users) |
| `MODELSERVER_TOOL_BUDGET` | `0.18` | Fraction of the smallest model window the skill catalog may use (`0` = no cap) |
| `MODELSERVER_COMPACTION` | on | `0` to leave compaction entirely to omp (see *Compaction* below) |
| `MODELSERVER_PRESUMMARIZE_AT` | `0.5` | Fraction of omp's compaction threshold at which the older part of the session starts being summarized in the background |
| `MODELSERVER_PRESUMMARIZE_MIN_CHARS` | `20000` | Smallest amount of new (serialized) conversation worth a background update |
| `MODELSERVER_LOOP_GUARD` | on | `0` to turn off the identical-tool-call loop guard |
| `PI_CODING_AGENT_DIR` | `~/.omp/agent` | omp's agent directory (config.yml, extensions, sessions) — honoured by the installers too |

## Compaction

omp compacts when its context passes its threshold (`compaction.thresholdTokens`, else `compaction.thresholdPercent` of the window, else the window minus a reserve of max(16384, 15% of the window)). Three things make that rare and fast with the model server:

- **The right window.** With two models paired, omp's default model is the fast one, whose own slot is small. The server tells this extension the window the PAIR can serve (capped by the server's `PI_CONTEXT_WINDOW_MAX`, default 131072) and moves any request that outgrows the fast model to the one that fits.
- **Background summary.** Once the context passes `MODELSERVER_PRESUMMARIZE_AT` of the threshold, the older part of the session is summarized on a model with a free slot — never the one the agent is working on — and kept up to date while the lead keeps working.
- **Compaction itself** (`session_before_compact`) sends only what the background summary has not covered yet to `POST /api/omp/summarize`: fastest free model, thinking off, chunked to its window, the split-turn prefix in parallel. If anything fails, omp's own compaction runs (the server recognises omp's summarizer prompt, moves it to the fast model and turns thinking off).

## Notes

- By default the extension skips skills that shadow omp's built-in local tools (`read`, `bash`, `edit`, `write`, search). omp handles your local files via its built-ins; the extension contributes server-side specialty work (`web_search`, `playwright_*`, `render_chart`, `query_sqlite`, `transcribe_audio`, `transform_image`, `parse_*`, etc.). Set `MODELSERVER_INCLUDE_LOCAL_SHADOW=1` if you actually want server-side filesystem access (e.g. inspecting `/workspace/` artifacts).
- Skill parameters are mapped to TypeBox schemas (omp's bundled shim) with every field marked optional. The skill execution layer already accepts multiple parameter-name aliases per field, so loose tool calls tend to dispatch correctly.
- Tool results larger than ~12 KB are truncated in the rendered text, but the full JSON payload is attached as `details` for inspection.
- Disabling a skill in the webapp removes it from the tool catalog after the next `omp` restart. `/extensions` inside omp shows whether the extension loaded.
