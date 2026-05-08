# Pi extension — Model Server

A [Pi](https://pi.dev) extension that wires the local model-server install into Pi:

- registers an OpenAI-compatible provider named **modelserver** populated from `/v1/models`
- pulls the user's skill catalog from `/api/skills` and exposes every enabled skill as a Pi tool that proxies to `/api/skills/:name/execute`

The 120+ default skills (web search, URL fetch, code navigation, file ops, OCR, PDF, etc.) become callable from any Pi conversation without further configuration.

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
| `MODELSERVER_BASE_URL` | `https://localhost:3001` | Webapp HTTPS endpoint |
| `MODELSERVER_API_KEY` | — | Bearer-mode API key (required) |
| `MODELSERVER_INSECURE_TLS` | auto for `localhost`/`127.*`/`[::1]` | `1` to accept self-signed certs |

## Notes

- Skill parameters are mapped to Typebox schemas with every field marked optional. The skill execution layer already accepts multiple parameter-name aliases per field, so loose tool calls tend to dispatch correctly.
- Tool results larger than ~12 KB are truncated in the rendered text, but the full JSON payload is attached as `details` for inspection.
- Disabling a skill in the webapp removes it from the tool catalog after the next `pi` restart.
