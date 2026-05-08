# Pi extension — Model Server

A [Pi](https://pi.dev) extension that wires the local model-server install into Pi:

- registers an OpenAI-compatible provider named **modelserver** populated from `/v1/models`
- pulls the user's skill catalog from `/api/skills` and exposes every enabled skill as a Pi tool that proxies to `/api/skills/:name/execute`

The 120+ default skills (web search, URL fetch, code navigation, file ops, OCR, PDF, etc.) become callable from any Pi conversation without further configuration.

## Quick start

1. Install Pi:

   ```bash
   npm install -g @earendil-works/pi-coding-agent
   ```

2. Drop the extension under Pi's global extensions directory and install its deps:

   ```bash
   mkdir -p ~/.pi/agent/extensions/modelserver
   cp modelserver.ts package.json ~/.pi/agent/extensions/modelserver/
   ( cd ~/.pi/agent/extensions/modelserver && npm install --omit=dev )
   ```

   The webapp's **Docs → Pi setup** tab generates a one-liner that does all of the above.

3. Create a bearer-mode API key in the webapp's **API Keys** tab (the regular key+secret pair won't work — Pi sends `Authorization: Bearer …`).

4. Set the env vars before launching `pi`:

   ```bash
   export MODELSERVER_BASE_URL="https://localhost:3001"
   export MODELSERVER_API_KEY="<bearer-mode-key>"
   pi
   ```

5. Inside Pi, run `/provider modelserver` (or set `defaultProvider: "modelserver"` in `~/.pi/agent/settings.json`) and pick any loaded model.

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `MODELSERVER_BASE_URL` | `https://localhost:3001` | Webapp HTTPS endpoint |
| `MODELSERVER_API_KEY` | — | Bearer-mode API key (required) |
| `MODELSERVER_INSECURE_TLS` | auto for `localhost`/`127.*`/`[::1]` | `1` to accept self-signed certs |

## Notes

- Skill parameters are mapped to Typebox schemas with every field marked optional. The skill execution layer already accepts multiple parameter-name aliases per field, so loose tool calls tend to dispatch correctly.
- Tool results larger than ~12 KB are truncated in the rendered text, but the full JSON payload is attached as `details` for inspection.
- Disabling a skill in the webapp removes it from the tool catalog after the next `pi` restart.
