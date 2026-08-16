#!/usr/bin/env python3
"""
Model downloader that emits structured progress to stdout.

Each progress line is a single line beginning with `__PROGRESS__` followed by a
JSON payload, so the Node.js webapp can parse and forward the data over
WebSocket. This replaces the previous implementation that relied on
`hf_hub_download` + tqdm (which writes to stderr using carriage returns and is
not parseable).

Output contract (all lines newline-delimited, UTF-8, flushed):
  __PROGRESS__{"kind": "start",    "fileTotal": int, "totalBytes": int}
  __PROGRESS__{"kind": "progress", "fileIndex": int, "fileTotal": int,
                                    "fileName": str, "filePct": int,
                                    "fileDownloaded": int, "fileSize": int,
                                    "overallPct": int, "overallDownloaded": int,
                                    "overallTotal": int, "speed": int,
                                    "eta": int}
  __PROGRESS__{"kind": "complete", "totalBytes": int}

Additionally a state manifest is maintained at
`<local_dir>/.download-state.json` (written atomically) so the webapp can tell
a live download from a dead one and offer/perform a resume. See STATE_VERSION
below for the schema; `updatedAt` is refreshed at least every ~2s while
downloading, so a `"downloading"` manifest older than ~60s is a dead process.

Resume correctness rules implemented here (a truncated GGUF is silently
indistinguishable from a good one — it lists as "Downloaded (Not Loaded)" and
only fails at load time with "tensor '...' data is not within the file bounds",
so every one of these matters):
  * the ETag of the response we actually streamed is recorded, and a resume
    sends `If-Range: <etag>` — a server honouring it answers 200 (whole body)
    instead of 206 and we restart from 0 instead of appending onto stale
    bytes. `If-Range` is only advisory though: HF's xet CDN was MEASURED to
    return 206 even for a validator that does not match, so the ETag of the
    resume response is ALSO compared client-side and a mismatch restarts the
    file. Both checks are needed;
  * a 206 whose Content-Range start does not match our offset restarts too;
  * 416 (Range Not Satisfiable) is handled explicitly;
  * every completed file is verified byte-exact against the remote size before
    success is reported;
  * transient failures (connection reset, timeout, 5xx, incomplete read) are
    retried with backoff, resuming from whatever is on disk; 401/403/404 fail
    immediately;
  * SIGTERM/SIGINT flush and close the file, write an `interrupted` manifest
    and exit 143 so the partial file stays resumable.
"""

from huggingface_hub import hf_hub_url
import requests
import signal
import sys
import os
import re
import time
import json
import datetime


CHUNK_SIZE = 1 << 20          # 1 MiB network chunk
WRITE_BUFFER = 1 << 20        # 1 MiB file buffer
FLUSH_EVERY = 32 << 20        # flush to the OS every 32 MiB so on-disk size
                              # tracks reality if we are SIGKILLed
EMIT_INTERVAL_SEC = 0.5       # Throttle progress emissions
STATE_INTERVAL_SEC = 2.0      # Throttle manifest writes
HEAD_TIMEOUT = 30
GET_TIMEOUT = 120

MAX_ATTEMPTS = 5
BACKOFF_SEC = [2, 4, 8, 16, 30]
# Retryable HTTP statuses. Everything else in 4xx (401/403/404/410...) is a
# permanent answer: retrying just hammers the hub and delays the error.
RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504, 507, 509}

STATE_VERSION = 1
STATE_FILENAME = '.download-state.json'


class Interrupted(BaseException):
    """Raised from the SIGTERM/SIGINT handler.

    Derives from BaseException on purpose so neither urllib3/requests nor our
    own `except Exception` retry wrapper can swallow it.
    """


class RestartRequired(Exception):
    """The partial bytes on disk cannot be trusted; start this file over.

    Not a transfer failure, so it does not consume a retry attempt.
    """


class FatalHTTPError(Exception):
    """A non-retryable HTTP status."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def utcnow():
    """ISO-8601 UTC with millisecond precision and a literal `Z`."""
    now = datetime.datetime.now(datetime.timezone.utc)
    return now.strftime('%Y-%m-%dT%H:%M:%S.') + f'{now.microsecond // 1000:03d}Z'


# --------------------------------------------------------------------------
# State manifest
# --------------------------------------------------------------------------

STATE = None          # the manifest dict
STATE_DIR = None      # directory it lives in
_last_state_write = 0.0


def state_path(local_dir=None):
    return os.path.join(local_dir or STATE_DIR, STATE_FILENAME)


def load_existing_state(local_dir):
    try:
        with open(state_path(local_dir), 'r', encoding='utf-8') as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return {}


def init_state(local_dir, repo, requested_file, files, sizes):
    """Build (merging with any manifest already in the dir) the run manifest."""
    global STATE, STATE_DIR
    STATE_DIR = local_dir
    prev = load_existing_state(local_dir)
    prev_files = {}
    for entry in (prev.get('files') or []):
        if isinstance(entry, dict) and entry.get('name'):
            prev_files[entry['name']] = entry

    file_entries = []
    for name in files:
        old = prev_files.get(name, {})
        on_disk = 0
        try:
            on_disk = os.path.getsize(os.path.join(local_dir, name))
        except OSError:
            pass
        expected = int(sizes.get(name) or 0)
        file_entries.append({
            'name': name,
            'expectedBytes': expected,
            'downloadedBytes': on_disk,
            # Only keep an ETag we can still trust: it belongs to the bytes on
            # disk, so it is meaningless once the file is gone.
            'etag': old.get('etag') if on_disk > 0 else None,
            'complete': bool(expected and on_disk == expected),
        })

    STATE = {
        'version': STATE_VERSION,
        'repo': repo,
        'requestedFile': requested_file,
        'status': 'downloading',
        'totalBytes': sum(int(sizes.get(n) or 0) for n in files),
        'downloadedBytes': sum(e['downloadedBytes'] for e in file_entries),
        'percent': 0,
        'startedAt': prev.get('startedAt') or utcnow(),
        'updatedAt': utcnow(),
        'pid': os.getpid(),
        'error': None,
        'files': file_entries,
    }
    recompute_state_totals()
    save_state(force=True)
    return STATE


def state_entry(name):
    if not STATE:
        return None
    for entry in STATE['files']:
        if entry['name'] == name:
            return entry
    entry = {'name': name, 'expectedBytes': 0, 'downloadedBytes': 0,
             'etag': None, 'complete': False}
    STATE['files'].append(entry)
    return entry


def recompute_state_totals():
    if not STATE:
        return
    STATE['downloadedBytes'] = sum(int(e.get('downloadedBytes') or 0)
                                   for e in STATE['files'])
    total = int(STATE.get('totalBytes') or 0)
    STATE['percent'] = int(STATE['downloadedBytes'] * 100 / total) if total > 0 else 0


def save_state(force=False, status=None, error=None):
    """Atomically persist the manifest (tmp file + os.replace)."""
    global _last_state_write
    if not STATE or not STATE_DIR:
        return
    now = time.time()
    if not force and (now - _last_state_write) < STATE_INTERVAL_SEC:
        return
    if status is not None:
        STATE['status'] = status
    if error is not None or status in ('failed',):
        STATE['error'] = error
    recompute_state_totals()
    STATE['updatedAt'] = utcnow()
    tmp = state_path() + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump(STATE, fh, separators=(',', ':'))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, state_path())
        _last_state_write = now
    except OSError as e:
        # Never let manifest bookkeeping kill a 20 GB download.
        print(f">>> Warning: could not write download state: {e}", flush=True)


# --------------------------------------------------------------------------
# Signals
# --------------------------------------------------------------------------

def _signal_handler(signum, _frame):
    raise Interrupted(f'signal {signum}')


def install_signal_handlers():
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _signal_handler)
        except (ValueError, OSError):
            pass


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def detect_split_files(filename):
    """Return the list of files to download, expanding split GGUF models."""
    match = re.match(r'(.+)-(\d{5})-of-(\d{5})(\.gguf)$', os.path.basename(filename))
    if not match:
        return [filename]

    base_name, _part_num, total_parts, ext = match.groups()
    total = int(total_parts)
    directory = os.path.dirname(filename)

    split_files = []
    for i in range(1, total + 1):
        split_name = f"{base_name}-{i:05d}-of-{total_parts}{ext}"
        split_files.append(os.path.join(directory, split_name) if directory else split_name)

    print(f">>> Detected split model: {total} parts", flush=True)
    print(f">>> Will download: {', '.join(os.path.basename(f) for f in split_files)}", flush=True)
    return split_files


def get_token():
    return (
        os.environ.get('HUGGING_FACE_HUB_TOKEN')
        or os.environ.get('HF_TOKEN')
        or os.environ.get('HUGGINGFACE_TOKEN')
        or None
    )


def emit(kind, **fields):
    payload = {'kind': kind, **fields}
    sys.stdout.write('__PROGRESS__' + json.dumps(payload, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def head_size(url, headers):
    """Return total size in bytes.

    HEAD alone is not enough: huggingface.co answers HEAD for a non-LFS file
    (README.md, .gitattributes) with a 200 carrying NO content-length, so the
    size came back 0 — which silently disabled both the aggregate progress
    total and resume. Large LFS files (the .gguf we actually care about)
    redirect to a CDN that does send content-length, which is why this went
    unnoticed. Fall back to a 1-byte ranged GET and read the total out of
    Content-Range; that works for every file and simultaneously proves the
    origin honours Range requests.
    """
    try:
        r = requests.head(url, headers=headers, allow_redirects=True, timeout=HEAD_TIMEOUT)
        if r.status_code in (401, 403, 404, 410):
            raise FatalHTTPError(r.status_code, f'HTTP {r.status_code} for {url}')
        if r.status_code == 200:
            size = int(r.headers.get('content-length', 0) or 0)
            if size:
                return size
            # HF exposes the true size of an LFS pointer here.
            linked = r.headers.get('x-linked-size')
            if linked:
                return int(linked)
    except (requests.RequestException, ValueError):
        pass
    try:
        probe = dict(headers)
        probe['Range'] = 'bytes=0-0'
        r = requests.get(url, headers=probe, allow_redirects=True,
                         stream=True, timeout=HEAD_TIMEOUT)
        try:
            if r.status_code in (401, 403, 404, 410):
                raise FatalHTTPError(r.status_code, f'HTTP {r.status_code} for {url}')
            if r.status_code == 206:
                cr = r.headers.get('content-range', '')
                if '/' in cr:
                    total = cr.rsplit('/', 1)[1].strip()
                    if total.isdigit():
                        return int(total)
            elif r.status_code == 200:
                return int(r.headers.get('content-length', 0) or 0)
        finally:
            r.close()
    except (requests.RequestException, ValueError):
        pass
    return 0


# NOTE (measured 2026-08-16): the ETag these CDNs return is NOT the sha256 of
# the file's bytes — HF's xet-backed objects hash differently (a resumed
# 531,068,480-byte download was byte-identical to a fresh one while both
# differed from the ETag). So the ETag is only ever used as a CHANGE DETECTOR
# for resume; never treat it as a content checksum to "verify" a download.
def usable_etag(value):
    """An `If-Range` validator must be a STRONG validator.

    A weak ETag (`W/"..."`) is not usable for range validation, and servers are
    required to ignore it — which would silently give us back the unvalidated
    behaviour we are trying to fix. Treat it as no etag at all.
    """
    if not value:
        return None
    value = value.strip()
    if not value or value.startswith('W/') or value.startswith('w/'):
        return None
    return value


def content_range_start(header):
    """Parse the first byte position out of `bytes 12345-99999/100000`."""
    try:
        spec = header.split(' ', 1)[1].split('/', 1)[0]
        return int(spec.split('-', 1)[0])
    except (AttributeError, IndexError, ValueError):
        return None


def truncate_local(path):
    try:
        with open(path, 'wb'):
            pass
    except OSError:
        pass


# --------------------------------------------------------------------------
# Transfer
# --------------------------------------------------------------------------

def _transfer(url, headers, local_path, filename, remote_total, entry,
              file_idx, file_total, total_bytes_all, bytes_before_this):
    """One attempt at getting `filename` fully onto disk. Returns bytes on disk."""
    existing = os.path.getsize(local_path) if os.path.exists(local_path) else 0

    if remote_total > 0 and existing > remote_total:
        print(f">>> {filename} is larger than the remote file "
              f"({existing} > {remote_total}) - restarting from 0", flush=True)
        truncate_local(local_path)
        existing = 0
        entry['etag'] = None

    req_headers = dict(headers)
    resume_from = existing if existing > 0 else 0
    stored_etag = usable_etag(entry.get('etag'))
    if resume_from:
        req_headers['Range'] = f'bytes={resume_from}-'
        if stored_etag:
            # If the remote file changed, the server answers 200 with the WHOLE
            # body instead of 206 — we then restart instead of appending onto
            # bytes that came from a different file.
            req_headers['If-Range'] = stored_etag
        pct = int(resume_from * 100 / remote_total) if remote_total else 0
        print(f">>> Resuming {filename} at {resume_from} bytes ({pct}% already "
              f"on disk, {max(remote_total - resume_from, 0)} to go)"
              f"{' [If-Range validated]' if stored_etag else ' [no stored etag]'}...",
              flush=True)
    else:
        print(f">>> Downloading {filename}...", flush=True)

    with requests.get(url, headers=req_headers, stream=True, timeout=GET_TIMEOUT,
                      allow_redirects=True) as r:
        status = r.status_code

        if status == 416:
            # The range is past the end of the remote file. Either we already
            # have the whole thing, or the local file is junk from another
            # source. Re-check and decide; never crash with a bare HTTPError.
            r.close()
            fresh_total = head_size(url, headers) or remote_total
            if fresh_total and existing == fresh_total:
                print(f">>> {filename} already complete ({existing} bytes) "
                      f"- server returned 416, treating as done", flush=True)
                entry['expectedBytes'] = fresh_total
                return existing
            print(f">>> Range rejected (416) for {filename}: local {existing} "
                  f"bytes vs remote {fresh_total} - restarting from 0", flush=True)
            truncate_local(local_path)
            entry['etag'] = None
            entry['downloadedBytes'] = 0
            save_state(force=True)
            raise RestartRequired('range rejected (416)')

        if status in (401, 403, 404, 410):
            raise FatalHTTPError(status, f'HTTP {status} for {filename}')
        if status >= 400:
            raise requests.HTTPError(f'HTTP {status} for {filename}', response=r)

        resumed = False
        if resume_from:
            if status == 206:
                start = content_range_start(r.headers.get('content-range', ''))
                if start is None or start == resume_from:
                    resumed = True
                else:
                    print(f">>> Server answered with the wrong range "
                          f"(offset {start}, expected {resume_from}) - restarting from 0",
                          flush=True)
            else:
                # 200 to a conditional range request = the validator did not
                # match, i.e. the remote file changed (or the server ignores
                # Range). Appending here is exactly how a corrupt file is born.
                if stored_etag:
                    print(">>> Remote file changed since the partial download "
                          "- restarting from 0", flush=True)
                else:
                    print(">>> Server ignored the range request - restarting from 0",
                          flush=True)

        if not resumed and resume_from:
            entry['etag'] = None

        # The ETag of the response we are ACTUALLY streaming (the CDN's own
        # etag on the 200/206, not huggingface.co's `x-linked-etag` from the
        # redirect).
        etag = usable_etag(r.headers.get('etag'))

        # `If-Range` is advisory: HF's xet CDN (measured) answers 206 even when
        # the validator does NOT match, so the conditional request alone cannot
        # protect us. Compare the validator ourselves — a mismatch means the
        # bytes on disk came from a different file and appending to them is
        # exactly how a silently-corrupt GGUF is produced.
        if resumed and stored_etag and etag and etag != stored_etag:
            r.close()
            print(">>> Remote file changed since the partial download "
                  f"(etag {stored_etag} -> {etag}) - restarting from 0", flush=True)
            truncate_local(local_path)
            entry['etag'] = None
            entry['downloadedBytes'] = 0
            save_state(force=True)
            raise RestartRequired('etag changed')

        if etag and (not resumed or not entry.get('etag')):
            entry['etag'] = etag
            # Persist it BEFORE streaming: a SIGKILL seconds later would
            # otherwise leave bytes on disk with no validator, and the next
            # resume could not tell whether they came from this same file.
            save_state(force=True)

        body_len = int(r.headers.get('content-length', 0) or 0)
        total = (resume_from + body_len) if resumed else body_len
        if not total:
            total = remote_total
        if total:
            entry['expectedBytes'] = total

        # `downloaded` counts bytes of the WHOLE file (not just this request)
        # so progress/ETA stay meaningful across a resume.
        downloaded = resume_from if resumed else 0
        start_time = time.time()
        start_bytes = downloaded
        last_emit = 0.0
        since_flush = 0

        with open(local_path, 'ab' if resumed else 'wb', buffering=WRITE_BUFFER) as f:
            try:
                for chunk in r.iter_content(chunk_size=CHUNK_SIZE):
                    if not chunk:
                        continue
                    f.write(chunk)
                    downloaded += len(chunk)
                    since_flush += len(chunk)
                    if since_flush >= FLUSH_EVERY:
                        f.flush()
                        since_flush = 0

                    now = time.time()
                    if now - last_emit < EMIT_INTERVAL_SEC:
                        continue

                    elapsed = now - start_time
                    # Rate over bytes fetched THIS run — counting the resumed
                    # prefix would report a fictional multi-GB/s and a zero ETA.
                    speed = (downloaded - start_bytes) / elapsed if elapsed > 0 else 0
                    file_pct = int(downloaded * 100 / total) if total > 0 else 0
                    overall_bytes = bytes_before_this + downloaded
                    if total_bytes_all > 0:
                        overall_pct = int(overall_bytes * 100 / total_bytes_all)
                        eta = int((total_bytes_all - overall_bytes) / speed) if speed > 0 else 0
                    else:
                        overall_pct = file_pct
                        eta = int((total - downloaded) / speed) if (speed > 0 and total > 0) else 0

                    emit('progress',
                         fileIndex=file_idx, fileTotal=file_total,
                         fileName=os.path.basename(filename),
                         filePct=file_pct, fileDownloaded=downloaded, fileSize=total,
                         overallPct=overall_pct, overallDownloaded=overall_bytes,
                         overallTotal=total_bytes_all, speed=int(speed), eta=eta)
                    last_emit = now

                    entry['downloadedBytes'] = downloaded
                    save_state()
            finally:
                # Whatever happens (interrupt, network error), get the bytes we
                # do have out of the Python buffer and into the OS.
                try:
                    f.flush()
                except (OSError, ValueError):
                    pass
                entry['downloadedBytes'] = (
                    os.path.getsize(local_path) if os.path.exists(local_path) else downloaded)

        # An `iter_content` that ends early (dropped connection) is NOT an
        # exception in requests — it just stops. Catch it as a retryable
        # failure rather than letting it look like success.
        on_disk = os.path.getsize(local_path)
        if total and on_disk < total:
            raise requests.ConnectionError(
                f'incomplete read: {on_disk} of {total} bytes')

        # Final per-file emit so UI settles at 100% for this file
        elapsed = time.time() - start_time
        speed = (downloaded - start_bytes) / elapsed if elapsed > 0 else 0
        overall_bytes = bytes_before_this + downloaded
        overall_pct = int(overall_bytes * 100 / total_bytes_all) if total_bytes_all > 0 else 100
        emit('progress',
             fileIndex=file_idx, fileTotal=file_total,
             fileName=os.path.basename(filename),
             filePct=100, fileDownloaded=downloaded,
             fileSize=total or downloaded,
             overallPct=overall_pct, overallDownloaded=overall_bytes,
             overallTotal=total_bytes_all or overall_bytes,
             speed=int(speed), eta=0)

    return on_disk


def download_file(repo_id, filename, local_dir, file_idx, file_total,
                  total_bytes_all, bytes_before_this, token):
    """Get one file fully onto disk, with resume + bounded retries + verification.

    RESUMES a partial file instead of restarting it. These are 10-25 GB
    downloads: anything that interrupts one (a webapp restart — the download is
    a child process of the container, so `docker compose up -d --build webapp`
    kills it — a network drop, a cancel) used to leave a truncated .gguf that
    could never be finished, only re-fetched from byte 0. A truncated GGUF is
    also silently useless: it loads far enough to look real, then llama.cpp
    dies with "tensor '...' data is not within the file bounds, model is
    corrupted or incomplete" and the container exits 1.
    """
    url = hf_hub_url(repo_id=repo_id, filename=filename)
    headers = {}
    if token:
        headers['Authorization'] = f'Bearer {token}'

    local_path = os.path.join(local_dir, filename)
    os.makedirs(os.path.dirname(local_path) or local_dir, exist_ok=True)

    entry = state_entry(filename)
    remote_total = head_size(url, headers)
    if remote_total:
        entry['expectedBytes'] = remote_total

    existing = os.path.getsize(local_path) if os.path.exists(local_path) else 0
    if remote_total > 0 and existing == remote_total:
        print(f">>> {filename} already complete ({existing} bytes) - skipping",
              flush=True)
        entry['downloadedBytes'] = existing
        entry['complete'] = True
        save_state(force=True)
        emit('progress',
             fileIndex=file_idx, fileTotal=file_total,
             fileName=os.path.basename(filename),
             filePct=100, fileDownloaded=existing, fileSize=existing,
             overallPct=int((bytes_before_this + existing) * 100 / total_bytes_all)
             if total_bytes_all > 0 else 100,
             overallDownloaded=bytes_before_this + existing,
             overallTotal=total_bytes_all or (bytes_before_this + existing),
             speed=0, eta=0)
        return existing, local_path

    last_error = None
    restarts = 0
    attempt = 0
    while attempt < MAX_ATTEMPTS:
        attempt += 1
        try:
            on_disk = _transfer(url, headers, local_path, filename, remote_total,
                                entry, file_idx, file_total, total_bytes_all,
                                bytes_before_this)
            break
        except RestartRequired as e:
            # The local bytes were discarded, not a transfer failure: retry
            # immediately without burning an attempt or sleeping. Bounded so a
            # server flapping its etag cannot spin forever.
            restarts += 1
            if restarts > 2:
                raise RuntimeError(f'{filename}: cannot get a consistent copy ({e})')
            attempt -= 1
            continue
        except FatalHTTPError:
            raise
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else None
            if status is not None and status not in RETRYABLE_STATUS:
                raise FatalHTTPError(status, f'HTTP {status} for {filename}')
            last_error = e
        except (requests.RequestException, OSError) as e:
            last_error = e

        entry['downloadedBytes'] = (
            os.path.getsize(local_path) if os.path.exists(local_path) else 0)
        save_state(force=True)
        if attempt >= MAX_ATTEMPTS:
            raise RuntimeError(
                f'{filename}: giving up after {MAX_ATTEMPTS} attempts - {last_error}')
        delay = BACKOFF_SEC[min(attempt - 1, len(BACKOFF_SEC) - 1)]
        print(f">>> Transfer of {filename} failed ({last_error}) - retry "
              f"{attempt}/{MAX_ATTEMPTS - 1} in {delay}s, resuming at "
              f"{entry['downloadedBytes']} bytes", flush=True)
        emit('progress',
             fileIndex=file_idx, fileTotal=file_total,
             fileName=os.path.basename(filename),
             filePct=int(entry['downloadedBytes'] * 100 / remote_total) if remote_total else 0,
             fileDownloaded=entry['downloadedBytes'],
             fileSize=remote_total or entry['downloadedBytes'],
             overallPct=int((bytes_before_this + entry['downloadedBytes']) * 100 / total_bytes_all)
             if total_bytes_all > 0 else 0,
             overallDownloaded=bytes_before_this + entry['downloadedBytes'],
             overallTotal=total_bytes_all, speed=0, eta=0,
             retry=attempt)
        time.sleep(delay)

    # ---- verification: never report success on a file that is not byte-exact.
    expected = remote_total or int(entry.get('expectedBytes') or 0)
    actual = os.path.getsize(local_path) if os.path.exists(local_path) else 0
    entry['downloadedBytes'] = actual
    if expected and actual != expected:
        entry['complete'] = False
        save_state(force=True)
        raise RuntimeError(
            f'{filename}: size mismatch after download - {actual} bytes on disk, '
            f'expected {expected}. The partial file was left in place; run the '
            f'download again to resume it.')

    entry['complete'] = True
    entry['expectedBytes'] = expected or actual
    save_state(force=True)
    print(f">>> Verified {actual} bytes for {filename}", flush=True)
    return actual, local_path


def main():
    if len(sys.argv) != 4:
        print("Usage: python download_model.py <huggingface-gguf-repo> <gguf-file-name> <local-dir>")
        sys.exit(1)

    repo_id = sys.argv[1]
    filename = sys.argv[2]
    local_dir = sys.argv[3]
    token = get_token()

    install_signal_handlers()

    print(f">>> Checking for split model files in {repo_id}...", flush=True)
    files_to_download = detect_split_files(filename)
    print(f">>> Downloading {len(files_to_download)} file(s) to {local_dir}...", flush=True)

    os.makedirs(local_dir, exist_ok=True)

    # Probe file sizes up-front so aggregate progress is accurate.
    headers = {'Authorization': f'Bearer {token}'} if token else {}
    sizes = {}
    total_bytes_all = 0
    try:
        for f in files_to_download:
            url = hf_hub_url(repo_id=repo_id, filename=f)
            sizes[f] = head_size(url, headers)
            total_bytes_all += sizes[f]
    except FatalHTTPError as e:
        init_state(local_dir, repo_id, filename, files_to_download, sizes)
        print(f"Error during download: {e}", flush=True)
        save_state(force=True, status='failed', error=str(e))
        sys.exit(1)
    except Interrupted:
        sys.exit(143)

    init_state(local_dir, repo_id, filename, files_to_download, sizes)
    emit('start', fileTotal=len(files_to_download), totalBytes=total_bytes_all)

    bytes_before = 0
    try:
        for idx, f in enumerate(files_to_download):
            downloaded, path = download_file(
                repo_id, f, local_dir,
                idx + 1, len(files_to_download),
                total_bytes_all, bytes_before, token,
            )
            bytes_before += downloaded
            print(f">>> Downloaded: {path}", flush=True)
    except Interrupted:
        on_disk = sum(int(e.get('downloadedBytes') or 0) for e in STATE['files'])
        save_state(force=True, status='interrupted', error=None)
        print(f">>> Download interrupted - {on_disk} bytes on disk, resumable. "
              f"Re-run the download to continue where it stopped.", flush=True)
        sys.exit(143)
    except FatalHTTPError as e:
        print(f"Error during download: {e}", flush=True)
        save_state(force=True, status='failed', error=str(e))
        sys.exit(1)
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else '?'
        msg = f'HTTP {status} - {e}'
        print(f"Error during download: {msg}", flush=True)
        save_state(force=True, status='failed', error=msg)
        sys.exit(1)
    except Exception as e:
        print(f"Error during download: {e}", flush=True)
        save_state(force=True, status='failed', error=str(e))
        sys.exit(1)

    save_state(force=True, status='complete', error=None)
    emit('complete', totalBytes=bytes_before)
    print(">>> All downloads complete!", flush=True)


if __name__ == "__main__":
    main()
