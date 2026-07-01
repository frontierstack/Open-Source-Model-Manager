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

_proc = None
_lock = threading.Lock()   # serialize engine transactions
_ready = False


def _log(msg):
    sys.stderr.write("[diffusion-shim] %s\n" % msg)
    sys.stderr.flush()


def start_engine():
    """Spawn the resident engine and block until it prints READY (model loaded)."""
    global _proc, _ready
    cmd = [BIN, "-m", MODEL_PATH, "-ngl", str(NGL), "-n", str(N_PREDICT), "--temp", str(TEMP)]
    if CTX_SIZE:
        cmd += ["-c", str(CTX_SIZE)]
    env = dict(os.environ)
    env["DIFFUSION_SERVE_STDIO"] = "1"
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


def generate(messages):
    """Run one stateless turn through the resident engine. Thread-safe."""
    if _proc is None or _proc.poll() is not None:
        raise RuntimeError("diffusion engine is not running")
    with _lock:
        stdin = _proc.stdin
        stdin.write(b"REQ %d\n" % len(messages))
        for m in messages:
            role = str(m.get("role", "user"))
            body = _flatten_content(m.get("content", "")).encode("utf-8")
            stdin.write(("%s %d\n" % (role, len(body))).encode("utf-8"))
            stdin.write(body)
            stdin.write(b"\n")
        stdin.flush()
        # Read stdout until the RESP header (tolerate any stray noise before it).
        while True:
            line = _proc.stdout.readline()
            if not line:
                raise RuntimeError("diffusion engine closed the stream")
            if line.startswith(b"RESP "):
                n = int(line[5:].strip())
                buf = bytearray()
                while len(buf) < n:
                    chunk = _proc.stdout.read(n - len(buf))
                    if not chunk:
                        break
                    buf += chunk
                _proc.stdout.readline()  # trailing newline
                return buf.decode("utf-8", "replace")


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
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
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
        try:
            raw = generate(messages)
        except Exception as e:
            self._send_json({"error": {"message": str(e), "type": "diffusion_engine_error"}}, status=500)
            return
        text, reasoning = _split_channels(raw)
        created = int(time.time())
        cmpl_id = "chatcmpl-diff-%d" % created
        ptoks = sum(_approx_tokens(_flatten_content(m.get("content", ""))) for m in messages)
        ctoks = _approx_tokens(text)
        if not stream:
            msg = {"role": "assistant", "content": text}
            if reasoning:
                msg["reasoning_content"] = reasoning
            self._send_json({
                "id": cmpl_id, "object": "chat.completion", "created": created, "model": model,
                "choices": [{"index": 0, "message": msg, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": ptoks, "completion_tokens": ctoks,
                          "total_tokens": ptoks + ctoks},
            })
            return
        # streaming: whole answer is produced at once; chunk it for smooth reveal.
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
        self._sse({"id": cmpl_id, "object": "chat.completion.chunk", "created": created,
                   "model": model,
                   "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
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
        text, _ = _split_channels(raw)
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
