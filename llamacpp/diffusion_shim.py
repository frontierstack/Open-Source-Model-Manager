#!/usr/bin/env python3
"""OpenAI-compatible HTTP shim for DiffusionGemma (llama-diffusion-cli).

The diffusion-gemma architecture (llama.cpp PR #24423, unmerged upstream) has no
llama-server. This shim launches the patched llama-diffusion-cli once in resident
"serve-stdio" mode (model stays loaded) and exposes the same OpenAI HTTP surface the
webapp health-checks and proxies to:

  GET  /health                 -> {"status":"ok"|"loading"}
  GET  /v1/models              -> model list (the webapp's readiness probe)
  POST /v1/chat/completions    -> chat (stream + non-stream)
  POST /v1/completions         -> raw completion (stream + non-stream)

stdlib only (no pip). Requests are serialized through the single engine process.
"""
import json
import os
import re
import select
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_PATH = os.environ.get("LLAMA_MODEL_PATH", "/models/default.gguf")
PORT       = int(os.environ.get("LLAMA_PORT", "8000"))
NGL        = os.environ.get("LLAMA_N_GPU_LAYERS", "-1")
if NGL in ("-1", ""):
    NGL = "99"  # llama-diffusion-cli: 99 == offload all layers
N_PREDICT  = os.environ.get("LLAMA_DIFFUSION_N_PREDICT", "2048")
TEMP       = os.environ.get("LLAMA_TEMP", "0.7")
CTX_SIZE   = os.environ.get("LLAMA_CTX_SIZE", "")
MODEL_ID   = os.environ.get("LLAMA_MODEL_ID") or os.path.basename(MODEL_PATH)
BIN        = os.environ.get("LLAMA_DIFFUSION_BIN", "llama-diffusion-cli")
# Hard ceiling on how long a single generation may take before the engine is
# considered wedged and respawned. Generous (diffusion is slow) but finite, so a
# stalled/desynced CLI or an aborted request can NEVER block the model forever.
GEN_TIMEOUT = float(os.environ.get("LLAMA_DIFFUSION_TIMEOUT", "300"))
# Physical per-turn batch capacity: block-diffusion holds the WHOLE [prompt|canvas]
# in one compute batch (n_ubatch). The CLI derives only n_predict+2048 (=4096) from
# -n, which is too small for real tool results (a fetched article). The CLI keeps
# the LARGER of the derived value and an explicit -ub, so raise it here. Must stay
# in sync with the webapp's LLAMA_DIFFUSION_UBATCH budget default.
UBATCH = os.environ.get("LLAMA_DIFFUSION_UBATCH", "6144")
# Thinking OFF by default: the channel-thought reasoning is the dominant latency cost, so
# skip it for responsiveness. Enabled by either the diffusion-specific override
# (LLAMA_DIFFUSION_THINKING) or the UI's general reasoning toggle (LLAMA_REASONING=on);
# 'auto'/'off'/unset -> off, so the UI "reasoning" switch controls this model too.
def _thinking_enabled():
    d = os.environ.get("LLAMA_DIFFUSION_THINKING", "").strip().lower()
    if d in ("1", "on", "true", "yes"):
        return True
    if d in ("0", "off", "false", "no"):
        return False
    return os.environ.get("LLAMA_REASONING", "").strip().lower() in ("1", "on", "true", "yes")
THINKING   = _thinking_enabled()
# Optional latency knob: fewer denoising steps = faster, lower quality (default is the model's 48).
EB_MAX_STEPS = os.environ.get("LLAMA_DIFFUSION_EB_MAX_STEPS", "")

_proc = None
_lock = threading.Lock()   # serialize engine transactions
_ready = False


def _log(msg):
    sys.stderr.write("[diffusion-shim] %s\n" % msg)
    sys.stderr.flush()


def start_engine():
    """Spawn the resident engine and block until it prints READY (model loaded)."""
    global _proc, _ready
    cmd = [BIN, "-m", MODEL_PATH, "-ngl", str(NGL), "-n", str(N_PREDICT), "--temp", str(TEMP),
           "-ub", str(UBATCH), "-b", str(UBATCH)]
    if CTX_SIZE:
        cmd += ["-c", str(CTX_SIZE)]
    if EB_MAX_STEPS:
        cmd += ["--diffusion-eb-max-steps", str(EB_MAX_STEPS)]
    env = dict(os.environ)
    env["DIFFUSION_SERVE_STDIO"] = "1"
    if THINKING:
        env["DIFFUSION_ENABLE_THINKING"] = "1"
    _log("launching: %s" % " ".join(cmd))
    # stderr=None -> engine's load/timing logs stream straight to container logs.
    _proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=None, bufsize=0, env=env)
    while True:
        line = _proc.stdout.readline()
        if not line:
            raise RuntimeError("diffusion engine exited during model load")
        if line.strip() == b"READY":
            _ready = True
            _log("engine READY — serving on port %d" % PORT)
            return


def _flatten_content(content):
    """OpenAI content may be a string or a list of parts (vision). Keep text only."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict):
                if p.get("type") == "text" and isinstance(p.get("text"), str):
                    parts.append(p["text"])
            elif isinstance(p, str):
                parts.append(p)
        return "\n".join(parts)
    if content is None:
        return ""
    return str(content)


def _respawn(reason):
    """Kill and reload the engine so the next request starts from a clean, in-sync
    stream. Called under _lock after a stall/error. Reloads the model (~30s)."""
    global _proc, _ready
    _log("respawning engine (%s)" % reason)
    _ready = False
    try:
        if _proc:
            _proc.kill()
            _proc.wait(timeout=10)
    except Exception:
        pass
    _proc = None
    start_engine()   # blocks until READY


def _read_until_deadline(stream, n, deadline):
    """Read exactly n bytes from stream, or raise TimeoutError past the deadline."""
    buf = bytearray()
    while len(buf) < n:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("read timeout")
        r, _, _ = select.select([stream], [], [], remaining)
        if not r:
            raise TimeoutError("read timeout")
        chunk = stream.read(n - len(buf))
        if not chunk:
            raise RuntimeError("engine closed the stream")
        buf += chunk
    return bytes(buf)


def _readline_until_deadline(stream, deadline):
    """Read one line, or raise TimeoutError past the deadline. (Unbuffered stdout,
    so byte-at-a-time; the RESP header is short.)"""
    buf = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("read timeout")
        r, _, _ = select.select([stream], [], [], remaining)
        if not r:
            raise TimeoutError("read timeout")
        ch = stream.read(1)
        if not ch:
            raise RuntimeError("engine closed the stream")
        buf += ch
        if ch == b"\n":
            return bytes(buf)


def _clean_messages(messages):
    """Rebuild the message list in strict OpenAI shape for the CLI's
    common_chat_msgs_parse_oaicompat: PRESERVE assistant tool_calls and
    role:'tool' results (the chat template needs them to render the native
    <|tool_call>/<|tool_response> blocks — without them the model never sees
    that it already called a tool, and re-issues the same call every round).
    Flatten content-part arrays to text; DROP reasoning_content from history
    (per DiffusionGemma guidance: never include prior hidden thoughts)."""
    clean = []
    call_names = {}   # tool_call id -> function name (to label tool results)
    for m in (messages or []):
        role = str(m.get("role", "user"))
        cm = {"role": role}
        c = m.get("content", None)
        if c is None or isinstance(c, str):
            cm["content"] = c
        else:
            cm["content"] = _flatten_content(c)
        tcs = m.get("tool_calls")
        if role == "assistant" and isinstance(tcs, list) and tcs:
            out = []
            for t in tcs:
                fn = (t or {}).get("function") or {}
                args = fn.get("arguments")
                if not isinstance(args, str):
                    try:
                        args = json.dumps(args or {})
                    except Exception:
                        args = "{}"
                tc = {"id": str(t.get("id") or "call_%d" % len(call_names)),
                      "type": "function",
                      "function": {"name": str(fn.get("name") or ""), "arguments": args}}
                out.append(tc)
                call_names[tc["id"]] = tc["function"]["name"]
            cm["tool_calls"] = out
        if role == "tool":
            tcid = m.get("tool_call_id")
            if tcid:
                cm["tool_call_id"] = str(tcid)
            name = m.get("name") or call_names.get(tcid)
            if name:
                cm["name"] = str(name)
            if cm["content"] is None:
                cm["content"] = ""
        clean.append(cm)
    return clean


def generate(messages, tools=None):
    """Run one stateless turn through the resident engine. Thread-safe.
    Messages go over as FULL OpenAI-shape JSON (tool_calls / tool results
    preserved) so the CLI's chat template renders the model's native tool
    blocks; `tools` (already compacted by the server-side tool router) are
    declared to the template so the model can emit tool calls.

    Robust against a wedged/desynced engine: the request is built as ONE buffer
    and written atomically (no partial write can desync the length-prefixed
    protocol), and the response read is bounded by GEN_TIMEOUT — on any
    timeout/IO error the engine is respawned so a stalled or user-aborted request
    can NEVER permanently block the model."""
    msgs_bytes = json.dumps(_clean_messages(messages)).encode("utf-8")
    tools_bytes = b""
    if tools:
        try:
            tools_bytes = json.dumps(tools).encode("utf-8")
        except Exception:
            tools_bytes = b""
    # Build the whole request up-front so the write is a single, atomic flush.
    parts = [b"REQJ %d %d\n" % (len(msgs_bytes), len(tools_bytes))]
    parts.append(msgs_bytes)
    parts.append(b"\n")
    if tools_bytes:
        parts.append(tools_bytes)
        parts.append(b"\n")
    request = b"".join(parts)

    with _lock:
        if _proc is None or _proc.poll() is not None:
            _respawn("engine not running")
        deadline = time.monotonic() + GEN_TIMEOUT
        try:
            _proc.stdin.write(request)
            _proc.stdin.flush()
            # Read stdout until the RESP header (tolerate stray noise before it).
            while True:
                line = _readline_until_deadline(_proc.stdout, deadline)
                if line.startswith(b"RESP "):
                    n = int(line[5:].strip())
                    data = _read_until_deadline(_proc.stdout, n, deadline) if n > 0 else b""
                    _readline_until_deadline(_proc.stdout, deadline)  # trailing newline
                    return data.decode("utf-8", "replace")
        except (TimeoutError, RuntimeError, BrokenPipeError, OSError, ValueError) as e:
            _respawn("generate failed: %s" % e)
            raise RuntimeError("diffusion engine stalled and was restarted; please retry")


def _approx_tokens(text):
    return max(1, len(text) // 4)


# DiffusionGemma wraps its reasoning in a channel block: "<|channel>thought ...<channel|>answer".
# Split it so the answer lands in the chat bubble and the reasoning goes to the Thinking dropdown.
_THOUGHT_OPEN = "<|channel>thought"
_THOUGHT_OPEN_ALT = "<|channel>"
_THOUGHT_CLOSE = "<channel|>"


def _split_channels(text):
    """Return (content, reasoning). Defensive: unrecognized formats pass through as content."""
    if _THOUGHT_CLOSE in text:
        head, _, tail = text.rpartition(_THOUGHT_CLOSE)
        reasoning = head
        for mark in (_THOUGHT_OPEN, _THOUGHT_OPEN_ALT):
            if reasoning.lstrip().startswith(mark):
                reasoning = reasoning.lstrip()[len(mark):]
                break
        content = tail.strip()
        # If splitting somehow left the answer empty, fall back to the raw text.
        if not content:
            return text.replace(_THOUGHT_OPEN, "").replace(_THOUGHT_CLOSE, "").strip(), ""
        return content, reasoning.strip()
    # No closing marker: strip any stray opener and treat the rest as the answer.
    if text.lstrip().startswith(_THOUGHT_OPEN_ALT):
        return text, ""  # incomplete thought block — surface as-is rather than blanking the reply
    return text, ""


# DiffusionGemma tool-call format (from the GGUF chat template):
#   <|tool_call>call:<name>{key:value,...}<tool_call|>
# with string values wrapped in <|"|>...<|"|>, booleans/numbers bare, nested {}/[] supported.
_STR_TOK = '<|"|>'
_RE_TOOLCALL = re.compile(r'<\|tool_call>call:([A-Za-z0-9_.\-]+)\{(.*?)\}<tool_call\|>', re.DOTALL)
# Strip residual special markers: the pipe-bearing family (real HTML like <div> is untouched
# because it has no '|'), plus the known Gemma/EOS tokens that don't carry a pipe.
_RE_STRIP_SPECIAL = re.compile(r'<\|[^<>]*>|<[^<>]*\|>')
_KNOWN_SPECIALS = ('<end_of_turn>', '<start_of_turn>', '<eos>', '<bos>', '<pad>',
                   '<unk>', '</s>', '<s>')


def _strip_specials(s):
    s = _RE_STRIP_SPECIAL.sub("", s)
    for t in _KNOWN_SPECIALS:
        s = s.replace(t, "")
    return s


def _args_to_json(body):
    """Convert the template's arg encoding to a JSON object string."""
    out = []
    i, n = 0, len(body)
    while i < n:
        if body.startswith(_STR_TOK, i):
            j = body.find(_STR_TOK, i + len(_STR_TOK))
            if j < 0:
                out.append(json.dumps(body[i + len(_STR_TOK):])); i = n
            else:
                out.append(json.dumps(body[i + len(_STR_TOK):j])); i = j + len(_STR_TOK)
        elif body[i] in '{}[]:,':
            out.append(body[i]); i += 1
        elif body[i] == ' ':
            i += 1
        else:
            j = i
            while j < n and body[j] not in '{}[]:, ' and not body.startswith(_STR_TOK, j):
                j += 1
            tok = body[i:j].strip()
            i = j
            k = i
            while k < n and body[k] == ' ':
                k += 1
            if k < n and body[k] == ':':          # bare key
                out.append(json.dumps(tok))
            elif tok in ('true', 'false', 'null'):  # bare literal
                out.append(tok)
            else:
                try:
                    float(tok); out.append(tok)     # number
                except ValueError:
                    out.append(json.dumps(tok) if tok else '""')  # unquoted string
    return '{' + ''.join(out) + '}'


def _parse_tool_calls(text):
    """Extract tool calls -> [{name, arguments(JSON str)}]; return (calls, text_without_calls)."""
    calls = []

    def repl(m):
        name, body = m.group(1), m.group(2)
        try:
            args = _args_to_json(body)
            json.loads(args)  # validate
        except Exception:
            args = json.dumps({"_raw": body})
        calls.append({"name": name, "arguments": args})
        return ""

    return calls, _RE_TOOLCALL.sub(repl, text)


def _parse_output(raw):
    """Split raw serve-mode output into (content, reasoning, tool_calls)."""
    content, reasoning = _split_channels(raw)
    tool_calls, content = _parse_tool_calls(content)
    # a tool call may also appear inside the thought section on some turns — pull those too
    if reasoning:
        r_calls, reasoning = _parse_tool_calls(reasoning)
        tool_calls.extend(r_calls)
    content = _strip_specials(content).strip()
    reasoning = _strip_specials(reasoning).strip()
    return content, reasoning, tool_calls


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass  # quiet; engine logs already go to stderr

    # -- helpers ---------------------------------------------------------------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sse_open(self):
        # CLOSE the connection after streaming (not keep-alive). The SSE body has no
        # Content-Length, so the consumer (the webapp's streamOneRequest) only
        # resolves on the socket 'end' event — which fires when the connection
        # closes. With keep-alive the connection stayed open after [DONE], so a
        # streamed turn (esp. a tool-call turn with no visible content) hung the
        # server forever. close_connection=True makes BaseHTTPRequestHandler drop
        # the socket after this response.
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

    def _sse(self, obj):
        self.wfile.write(b"data: " + json.dumps(obj).encode("utf-8") + b"\n\n")
        self.wfile.flush()

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return {}

    # -- routes ----------------------------------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send_json({"status": "ok" if _ready else "loading"})
        elif path == "/v1/models":
            self._send_json({
                "object": "list",
                "data": [{
                    "id": MODEL_ID,
                    "object": "model",
                    "created": 0,
                    "owned_by": "local-diffusion",
                }],
            })
        else:
            self._send_json({"error": "not found"}, status=404)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/v1/chat/completions":
            self._chat()
        elif path == "/v1/completions":
            self._completion()
        else:
            self._send_json({"error": "not found"}, status=404)

    def _chat(self):
        req = self._read_body()
        messages = req.get("messages", [])
        stream = bool(req.get("stream", False))
        model = req.get("model", MODEL_ID)
        tools = req.get("tools") or None   # compacted by the server-side tool router
        try:
            raw = generate(messages, tools)
        except Exception as e:
            self._send_json({"error": {"message": str(e), "type": "diffusion_engine_error"}}, status=500)
            return
        # Block-diffusion occasionally denoises to an empty canvas (stochastic at
        # temp>0) -> an empty bubble. Retry ONCE on a fully-empty generation.
        if not raw.strip():
            _log("empty generation; retrying once")
            try:
                raw = generate(messages, tools)
            except Exception:
                pass
        text, reasoning, tool_calls = _parse_output(raw)
        if not text and not tool_calls:
            _log("empty content after parse; raw=%r" % (raw[:400],))
        oai_calls = [{"id": "call_diff_%d" % i, "type": "function",
                      "function": {"name": c["name"], "arguments": c["arguments"]}}
                     for i, c in enumerate(tool_calls)]
        finish = "tool_calls" if oai_calls else "stop"
        created = int(time.time())
        cmpl_id = "chatcmpl-diff-%d" % created
        ptoks = sum(_approx_tokens(_flatten_content(m.get("content", ""))) for m in messages)
        ctoks = _approx_tokens(text)
        if not stream:
            msg = {"role": "assistant", "content": text or None}
            if reasoning:
                msg["reasoning_content"] = reasoning
            if oai_calls:
                msg["tool_calls"] = oai_calls
            self._send_json({
                "id": cmpl_id, "object": "chat.completion", "created": created, "model": model,
                "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
                "usage": {"prompt_tokens": ptoks, "completion_tokens": ctoks,
                          "total_tokens": ptoks + ctoks},
            })
            return
        # streaming: the whole answer is produced at once; chunk it for smooth reveal.
        self._sse_open()
        self._sse({"id": cmpl_id, "object": "chat.completion.chunk", "created": created,
                   "model": model,
                   "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})
        step = 24
        # reasoning first -> Thinking dropdown (server forwards reasoning_content -> delta.reasoning)
        for i in range(0, len(reasoning), step):
            self._sse({"id": cmpl_id, "object": "chat.completion.chunk", "created": created,
                       "model": model,
                       "choices": [{"index": 0, "delta": {"reasoning_content": reasoning[i:i + step]},
                                    "finish_reason": None}]})
        for i in range(0, len(text), step):
            self._sse({"id": cmpl_id, "object": "chat.completion.chunk", "created": created,
                       "model": model,
                       "choices": [{"index": 0, "delta": {"content": text[i:i + step]},
                                    "finish_reason": None}]})
        # tool calls -> emit each as a full delta (name + arguments) for the client to dispatch
        for idx, c in enumerate(oai_calls):
            self._sse({"id": cmpl_id, "object": "chat.completion.chunk", "created": created,
                       "model": model,
                       "choices": [{"index": 0, "delta": {"tool_calls": [{
                           "index": idx, "id": c["id"], "type": "function",
                           "function": {"name": c["function"]["name"],
                                        "arguments": c["function"]["arguments"]}}]},
                                    "finish_reason": None}]})
        self._sse({"id": cmpl_id, "object": "chat.completion.chunk", "created": created,
                   "model": model,
                   "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                   "usage": {"prompt_tokens": ptoks, "completion_tokens": ctoks,
                             "total_tokens": ptoks + ctoks}})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _completion(self):
        req = self._read_body()
        prompt = req.get("prompt", "")
        if isinstance(prompt, list):
            prompt = "\n".join(str(p) for p in prompt)
        stream = bool(req.get("stream", False))
        model = req.get("model", MODEL_ID)
        try:
            raw = generate([{"role": "user", "content": prompt}])
        except Exception as e:
            self._send_json({"error": {"message": str(e), "type": "diffusion_engine_error"}}, status=500)
            return
        text, _, _ = _parse_output(raw)
        created = int(time.time())
        cmpl_id = "cmpl-diff-%d" % created
        if not stream:
            self._send_json({
                "id": cmpl_id, "object": "text_completion", "created": created, "model": model,
                "choices": [{"index": 0, "text": text, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": _approx_tokens(prompt),
                          "completion_tokens": _approx_tokens(text),
                          "total_tokens": _approx_tokens(prompt) + _approx_tokens(text)},
            })
            return
        self._sse_open()
        step = 24
        for i in range(0, len(text), step):
            self._sse({"id": cmpl_id, "object": "text_completion", "created": created, "model": model,
                       "choices": [{"index": 0, "text": text[i:i + step], "finish_reason": None}]})
        self._sse({"id": cmpl_id, "object": "text_completion", "created": created, "model": model,
                   "choices": [{"index": 0, "text": "", "finish_reason": "stop"}]})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main():
    start_engine()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    _log("HTTP server listening on 0.0.0.0:%d" % PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if _proc and _proc.poll() is None:
            _proc.terminate()


if __name__ == "__main__":
    main()
