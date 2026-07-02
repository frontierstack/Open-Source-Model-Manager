#!/usr/bin/env python3
"""Knowledge Base embedding/retrieval engine.

A tiny persistent HTTP service (loopback only) that holds a CPU embedding
model resident in memory so retrieval stays fast no matter how big a
knowledge base grows. The webapp (Node) talks to it over 127.0.0.1.

Why a resident process: loading the model costs a few seconds, but once warm
each query embeds in well under a millisecond (the model is a static
embedding table — pure numpy, no transformer forward pass, no GPU). That is
what keeps "the model can reference a large KB" from ever becoming a context
or latency problem: we only ever return the top-k most relevant chunks.

Storage: one SQLite file per knowledge base (`<kbDir>/index.sqlite`) holding
the chunk text + a normalized float32 embedding BLOB per row. Search loads
the KB's vectors into an in-memory numpy matrix once (cached, invalidated by
file mtime) and scores with a single matrix-vector product.

Embedding backend: model2vec (minishlab/potion-retrieval-32M, 512-d). If the
model cannot be loaded (e.g. no download at build time) it transparently
falls back to a sklearn HashingVectorizer so the feature still works
(lexical instead of semantic). The active mode is reported by /health.

Protocol: POST JSON to /ingest /search /delete_doc /stats, GET /health.
Stdlib HTTP only; the sole heavy deps are numpy + the embedding backend.
"""

import json
import os
import sqlite3
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

MODEL_NAME = os.environ.get('KB_EMBED_MODEL', 'minishlab/potion-retrieval-32M')
HOST = os.environ.get('KB_ENGINE_HOST', '127.0.0.1')
# PORT 0 => bind an ephemeral port; main() prints the actual one for the parent.
PORT = int(os.environ.get('KB_ENGINE_PORT') or (sys.argv[1] if len(sys.argv) > 1 else '0'))

# ---------------------------------------------------------------------------
# Embedding backend
# ---------------------------------------------------------------------------

_model = None
_hashing = None
_mode = None
_dim = None


def _init_backend():
    global _model, _hashing, _mode, _dim
    try:
        from model2vec import StaticModel
        _model = StaticModel.from_pretrained(MODEL_NAME)
        _dim = int(_model.dim)
        _mode = 'model2vec:' + MODEL_NAME.split('/')[-1]
        print(f'[kb_engine] embedding backend: {_mode} (dim={_dim})', flush=True)
        return
    except Exception as e:  # pragma: no cover - environment dependent
        print(f'[kb_engine] model2vec unavailable ({e}); falling back to lexical hashing', flush=True)
    # Lexical fallback — fixed-dim, stateless, no model download required.
    from sklearn.feature_extraction.text import HashingVectorizer
    _dim = 512
    _hashing = HashingVectorizer(n_features=_dim, alternate_sign=False, norm=None)
    _mode = 'hashing'
    print(f'[kb_engine] embedding backend: hashing (dim={_dim})', flush=True)


def _embed(texts):
    """Return an (n, dim) float32 array of L2-normalized embeddings."""
    if not texts:
        return np.zeros((0, _dim), dtype=np.float32)
    if _model is not None:
        vecs = np.asarray(_model.encode(list(texts)), dtype=np.float32)
    else:
        vecs = _hashing_embed(texts)
    if vecs.ndim == 1:
        vecs = vecs.reshape(1, -1)
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1e-9
    return (vecs / norms).astype(np.float32)


def _hashing_embed(texts):
    mat = _hashing.transform(list(texts))
    return np.asarray(mat.todense(), dtype=np.float32)


# ---------------------------------------------------------------------------
# Per-KB SQLite + in-memory matrix cache
# ---------------------------------------------------------------------------

_write_lock = threading.Lock()
_cache_lock = threading.Lock()
_cache = {}  # kbDir -> {'mtime': float, 'mat': ndarray, 'rows': [(doc_id, filename, ord, text)]}


def _db_path(kb_dir):
    os.makedirs(kb_dir, exist_ok=True)
    return os.path.join(kb_dir, 'index.sqlite')


def _connect(kb_dir):
    conn = sqlite3.connect(_db_path(kb_dir), timeout=30, check_same_thread=False)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute(
        'CREATE TABLE IF NOT EXISTS chunks ('
        'id INTEGER PRIMARY KEY AUTOINCREMENT, '
        'doc_id TEXT, filename TEXT, ord INTEGER, text TEXT, emb BLOB)'
    )
    conn.execute('CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id)')
    return conn


def _invalidate(kb_dir):
    with _cache_lock:
        _cache.pop(os.path.abspath(kb_dir), None)


def _load_matrix(kb_dir):
    """Load (and cache) the KB's normalized embedding matrix + row metadata."""
    key = os.path.abspath(kb_dir)
    db = _db_path(kb_dir)
    try:
        mtime = os.path.getmtime(db)
    except OSError:
        return np.zeros((0, _dim), dtype=np.float32), []
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit['mtime'] == mtime:
            return hit['mat'], hit['rows']
    conn = _connect(kb_dir)
    try:
        cur = conn.execute('SELECT doc_id, filename, ord, text, emb FROM chunks ORDER BY id')
        rows = []
        vecs = []
        for doc_id, filename, ordn, text, emb in cur:
            rows.append((doc_id, filename, ordn, text))
            vecs.append(np.frombuffer(emb, dtype=np.float32))
        mat = np.vstack(vecs).astype(np.float32) if vecs else np.zeros((0, _dim), dtype=np.float32)
    finally:
        conn.close()
    with _cache_lock:
        _cache[key] = {'mtime': mtime, 'mat': mat, 'rows': rows}
    return mat, rows


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------

def op_ingest(body):
    kb_dir = body['kbDir']
    doc_id = str(body['docId'])
    filename = str(body.get('filename') or '')
    chunks = [c for c in (body.get('chunks') or []) if isinstance(c, str) and c.strip()]
    if not chunks:
        return {'ok': True, 'chunkCount': 0}
    embs = _embed(chunks)
    with _write_lock:
        conn = _connect(kb_dir)
        try:
            conn.executemany(
                'INSERT INTO chunks (doc_id, filename, ord, text, emb) VALUES (?,?,?,?,?)',
                [(doc_id, filename, i, chunks[i], embs[i].tobytes()) for i in range(len(chunks))],
            )
            conn.commit()
        finally:
            conn.close()
    _invalidate(kb_dir)
    return {'ok': True, 'chunkCount': len(chunks)}


def op_ingest_bulk(body):
    """Ingest MANY docs in one call: docs=[{docId, filename?, chunks:[...]}, ...].
    One batched embed + one transaction/commit. Motivation: the tool router's
    index build did 133 individual /ingest calls (per-call HTTP + commit fsync
    under _write_lock) taking ~10s; bulk does the same work in well under 1s.
    Additive op — existing ops unchanged."""
    kb_dir = body['kbDir']
    docs = []
    for d in (body.get('docs') or []):
        chunks = [c for c in (d.get('chunks') or []) if isinstance(c, str) and c.strip()]
        if chunks and d.get('docId') is not None:
            docs.append((str(d['docId']), str(d.get('filename') or ''), chunks))
    if not docs:
        return {'ok': True, 'docCount': 0, 'chunkCount': 0}
    flat = [c for (_d, _f, chunks) in docs for c in chunks]
    embs = _embed(flat)
    rows = []
    k = 0
    for (doc_id, filename, chunks) in docs:
        for i, c in enumerate(chunks):
            rows.append((doc_id, filename, i, c, embs[k].tobytes()))
            k += 1
    with _write_lock:
        conn = _connect(kb_dir)
        try:
            conn.executemany(
                'INSERT INTO chunks (doc_id, filename, ord, text, emb) VALUES (?,?,?,?,?)',
                rows,
            )
            conn.commit()
        finally:
            conn.close()
    _invalidate(kb_dir)
    return {'ok': True, 'docCount': len(docs), 'chunkCount': len(rows)}


def op_search(body):
    kb_dir = body['kbDir']
    query = str(body.get('query') or '').strip()
    k = int(body.get('k') or 6)
    k = max(1, min(k, 50))
    if not query:
        return {'ok': True, 'results': [], 'total': 0}
    mat, rows = _load_matrix(kb_dir)
    if mat.shape[0] == 0:
        return {'ok': True, 'results': [], 'total': 0}
    q = _embed([query])[0]
    scores = mat @ q
    n = scores.shape[0]
    k = min(k, n)
    # argpartition for top-k then sort just those k by score desc.
    idx = np.argpartition(-scores, k - 1)[:k]
    idx = idx[np.argsort(-scores[idx])]
    results = []
    for i in idx:
        doc_id, filename, ordn, text = rows[int(i)]
        results.append({
            'text': text,
            'score': round(float(scores[int(i)]), 4),
            'docId': doc_id,
            'filename': filename,
            'ord': int(ordn),
        })
    return {'ok': True, 'results': results, 'total': int(n)}


def op_delete_doc(body):
    kb_dir = body['kbDir']
    doc_id = str(body['docId'])
    with _write_lock:
        conn = _connect(kb_dir)
        try:
            cur = conn.execute('DELETE FROM chunks WHERE doc_id = ?', (doc_id,))
            conn.commit()
            removed = cur.rowcount
        finally:
            conn.close()
    _invalidate(kb_dir)
    return {'ok': True, 'removed': removed}


def op_stats(body):
    kb_dir = body['kbDir']
    if not os.path.exists(_db_path(kb_dir)):
        return {'ok': True, 'documentCount': 0, 'chunkCount': 0, 'dim': _dim, 'model': _mode, 'mode': _mode}
    conn = _connect(kb_dir)
    try:
        chunk_count = conn.execute('SELECT COUNT(*) FROM chunks').fetchone()[0]
        doc_count = conn.execute('SELECT COUNT(DISTINCT doc_id) FROM chunks').fetchone()[0]
    finally:
        conn.close()
    return {'ok': True, 'documentCount': int(doc_count), 'chunkCount': int(chunk_count),
            'dim': _dim, 'model': _mode, 'mode': _mode}


def op_get_doc(body):
    """Return a single document's chunks reassembled in order (no embedding,
    pure SQLite read). Used to serve a KB file's full text when the model /
    server asks to 'read' it by name. Selects by docId or by exact filename."""
    kb_dir = body['kbDir']
    doc_id = body.get('docId')
    filename = body.get('filename')
    max_chars = int(body.get('maxChars') or 0)
    if not os.path.exists(_db_path(kb_dir)):
        return {'ok': True, 'found': False}
    conn = _connect(kb_dir)
    try:
        if doc_id:
            cur = conn.execute(
                'SELECT filename, ord, text FROM chunks WHERE doc_id = ? ORDER BY ord', (str(doc_id),))
        elif filename:
            cur = conn.execute(
                'SELECT filename, ord, text FROM chunks WHERE filename = ? ORDER BY ord', (str(filename),))
        else:
            return {'ok': False, 'error': 'docId or filename required'}
        rows = cur.fetchall()
    finally:
        conn.close()
    if not rows:
        return {'ok': True, 'found': False}
    fn = rows[0][0]
    text = '\n'.join(r[2] for r in rows)
    truncated = False
    if max_chars and len(text) > max_chars:
        text = text[:max_chars]
        truncated = True
    return {'ok': True, 'found': True, 'filename': fn, 'chunkCount': len(rows),
            'charCount': len(text), 'truncated': truncated, 'text': text}


OPS = {'/ingest': op_ingest, '/ingest_bulk': op_ingest_bulk, '/search': op_search,
       '/delete_doc': op_delete_doc, '/stats': op_stats, '/get_doc': op_get_doc}


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence default request logging
        pass

    def _send(self, code, obj):
        payload = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == '/health':
            return self._send(200, {'ok': True, 'model': _mode, 'mode': _mode, 'dim': _dim})
        self._send(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        op = OPS.get(self.path)
        if not op:
            return self._send(404, {'ok': False, 'error': 'unknown op'})
        try:
            length = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(length) or b'{}')
        except Exception as e:
            return self._send(400, {'ok': False, 'error': f'bad request: {e}'})
        try:
            self._send(200, op(body))
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._send(500, {'ok': False, 'error': str(e)})


def main():
    _init_backend()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    actual = server.server_address[1]
    # The first stdout line tells the Node parent which port we bound.
    print(f'KB_ENGINE_LISTENING {actual}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
