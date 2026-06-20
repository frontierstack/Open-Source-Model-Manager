# Hermes MCP server — Model Server

Wires the local model-server install into [Hermes Agent](https://hermes-agent.nousresearch.com) (Nous Research):

- registers an OpenAI-compatible provider via the **simple custom-provider model form** in `config.yaml` (`model.provider=custom` + `base_url`/`api_key`/`default` from `/v1/models`), plus `OPENAI_BASE_URL`/`OPENAI_API_KEY` in `~/.hermes/.env` (the universal "configured" signal that skips Hermes' first-run wizard)
- exposes every enabled skill from `/api/skills` as a Hermes tool over the **Model Context Protocol** (a local stdio MCP server that proxies to `/api/skills/:name/execute`)

The 120+ default skills (web search, URL fetch, code navigation, file ops, OCR, PDF, etc.) become callable from any Hermes conversation without further configuration. The provider half is pure config (Hermes speaks OpenAI natively); this MCP server is only the tools half.

## Quick start

1. Create a **bearer-mode** API key in the webapp's **API Keys** tab (with the `agents` permission). Hermes authenticates via `Authorization: Bearer …` — regular key+secret pairs won't dispatch.

2. Run the auto-installer. The endpoint is auth-gated; pipe straight to bash:

   ```bash
   export MODELSERVER_API_KEY="<bearer-mode-key>"
   code=$(curl -sSk -w '%{http_code}' -H "Authorization: Bearer $MODELSERVER_API_KEY" \
     -o /tmp/hermes-install.sh https://<your-host>:3001/api/hermes/install)
   [ "$code" = 200 ] && bash /tmp/hermes-install.sh \
     || { echo "Install fetch failed (HTTP $code) — is the key Bearer Only + active?"; cat /tmp/hermes-install.sh; }
   ```

   (Downloading-then-checking the HTTP status surfaces a 401 — a wrong/non-bearer/
   inactive key — instead of silently piping an empty script to `bash`.)

   `install.sh` installs Hermes Agent if missing, installs its optional tool deps
   (**ripgrep + ffmpeg**), drops this MCP server under
   `~/.hermes/mcp-servers/modelserver/`, and merges the provider + MCP config into
   `~/.hermes/config.yaml` (writing `OPENAI_BASE_URL`/`OPENAI_API_KEY` to
   `~/.hermes/.env` so Hermes goes straight to the agent — no first-run wizard).
   It self-corrects for corporate MITM proxies (writes `~/.curlrc`, sets
   `NODE_TLS_REJECT_UNAUTHORIZED=0`, `npm strict-ssl=false`), missing or too-old
   Node (installs Node 22 LTS via NodeSource, falls back to nvm), missing curl,
   broken sudo, root vs non-root, and surfaces auth failures (HTTP status + a
   401/403 hint) instead of failing silently. Progress shows as sectioned steps
   with a spinner. Idempotent — re-run anytime.

3. Run Hermes:

   ```bash
   hermes          # classic CLI
   hermes --tui    # modern TUI (recommended)
   ```

### Manual install

If you'd rather not pipe to bash:

```bash
# 1. Install Hermes Agent
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash

# 2. Drop this MCP server
mkdir -p ~/.hermes/mcp-servers/modelserver
cp modelserver-mcp.mjs configure.mjs package.json ~/.hermes/mcp-servers/modelserver/
( cd ~/.hermes/mcp-servers/modelserver && npm install --omit=dev )

# 3. Merge the provider + MCP config into ~/.hermes/config.yaml
( cd ~/.hermes/mcp-servers/modelserver \
  && MODELSERVER_BASE_URL="https://<your-host>:3001" \
     MODELSERVER_API_KEY="<bearer-key>" node configure.mjs )
```

`configure.mjs` is idempotent and only touches the `model`, `approvals`
(first install only), and `mcp_servers.modelserver` keys — it preserves
everything else in your `config.yaml`.

The resulting `~/.hermes/config.yaml` looks like:

```yaml
model:
  provider: custom
  base_url: https://<your-host>:3001/v1
  api_key: <bearer-key>
  default: <first model id from /v1/models>
approvals:
  mode: "off"                    # frictionless; set to smart/manual for prompts
  mcp_reload_confirm: false
  destructive_slash_confirm: false
mcp_servers:
  modelserver:
    command: node
    args: [~/.hermes/mcp-servers/modelserver/modelserver-mcp.mjs]
    env:
      MODELSERVER_BASE_URL: https://<your-host>:3001
      MODELSERVER_API_KEY: <bearer-key>
```

`~/.hermes/.env` gets three keys: `MODELSERVER_API_KEY` plus `OPENAI_BASE_URL`
and `OPENAI_API_KEY`. The OpenAI pair is the **universal "a provider is
configured" signal** Hermes checks first (`_has_any_provider_configured`), on
every version — including older builds whose check predates the `config.yaml`
`model.provider` branch. Writing them is what reliably makes `hermes` skip its
interactive first-run setup wizard ("How would you like to set up Hermes?") and
go straight to the agent; the `config.yaml` **simple model form**
(`provider: custom` + `base_url` + `api_key` + `default`) supplies the actual
model + routing. `model.default` is auto-detected from `/v1/models` — load a
model in the webapp first (otherwise pick one later with `hermes model`).

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `MODELSERVER_BASE_URL` | baked-in at serve time | Webapp HTTPS endpoint |
| `MODELSERVER_API_KEY` | — | Bearer-mode API key (required) |
| `MODELSERVER_INSECURE_TLS` | auto for localhost/RFC-1918 | `1` to accept self-signed certs |
| `MODELSERVER_INCLUDE_LOCAL_SHADOW` | off | `1` to also register file/git/code-nav/shell skills (default off — they execute inside the webapp container's `/workspace`, not your local `$PWD`, which surprises most users) |

## Notes

- By default the MCP server skips skills that shadow Hermes' built-in local tools (`read`, `bash`, `edit`, `write`, search). Hermes handles your local files via its built-ins; this server contributes server-side specialty work (`web_search`, `playwright_*`, `render_chart`, `query_sqlite`, `transcribe_audio`, `transform_image`, `parse_*`, etc.). Set `MODELSERVER_INCLUDE_LOCAL_SHADOW=1` if you actually want server-side filesystem access (e.g. inspecting `/workspace/` artifacts).
- **Host ⇆ workspace file bridge:** when you pass a real host file path to a server skill (e.g. `read_pdf`, `create_pdf`'s `contentFile`, `transform_image`), the file is uploaded into the server sandbox automatically. To pull an output back, call `workspace_get("artifacts/<name>", "<host-dest>")`.
- Skill parameters are mapped to JSON-Schema with every field optional. The skill execution layer accepts multiple parameter-name aliases per field, so loose tool calls tend to dispatch correctly.
- Tool results larger than ~12 KB are truncated in the rendered text.
- Disabling a skill in the webapp removes it from the tool catalog after the next Hermes restart.
- **Memory/persona:** create the bearer key while signed in to the web UI so it's tied to your account — then Hermes and the web chat share the *same* persona & experience memory (the `/v1` endpoint injects what worked on past tasks and records new experience from Hermes' tool use). Raw OpenAI-SDK clients (key+secret) stay fully transparent.
