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
"""

from huggingface_hub import hf_hub_url
import requests
import sys
import os
import re
import time
import json


CHUNK_SIZE = 1 << 20          # 1 MiB network chunk
EMIT_INTERVAL_SEC = 0.5       # Throttle progress emissions
HEAD_TIMEOUT = 30
GET_TIMEOUT = 120


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


def download_file(repo_id, filename, local_dir, file_idx, file_total,
                  total_bytes_all, bytes_before_this, token):
    """Stream a single file to disk, emitting progress events.

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

    # How much is already on disk, and how big is the real thing?
    existing = os.path.getsize(local_path) if os.path.exists(local_path) else 0
    remote_total = head_size(url, headers)

    resume_from = 0
    if existing > 0 and remote_total > 0:
        if existing == remote_total:
            print(f">>> {filename} already complete ({existing} bytes) - skipping",
                  flush=True)
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
        if existing < remote_total:
            resume_from = existing
        else:
            # Longer than the source: not a partial download of THIS file.
            print(f">>> {filename} is larger than the remote file "
                  f"({existing} > {remote_total}) - restarting", flush=True)

    if resume_from:
        headers['Range'] = f'bytes={resume_from}-'
        pct = int(resume_from * 100 / remote_total) if remote_total else 0
        print(f">>> Resuming {filename} at {resume_from} bytes ({pct}% already "
              f"on disk, {remote_total - resume_from} to go)...", flush=True)
    else:
        print(f">>> Downloading {filename}...", flush=True)

    with requests.get(url, headers=headers, stream=True, timeout=GET_TIMEOUT,
                      allow_redirects=True) as r:
        r.raise_for_status()
        # 206 = the range was honoured. Anything else (a 200 from a server or
        # CDN that ignored Range) means we are getting the whole file again, so
        # the local bytes must be overwritten, not appended to.
        resumed = resume_from > 0 and r.status_code == 206
        if resume_from and not resumed:
            print(">>> Server ignored the range request - restarting from 0",
                  flush=True)
        body_len = int(r.headers.get('content-length', 0) or 0)
        total = (resume_from + body_len) if resumed else body_len
        if not total:
            total = remote_total

        # `downloaded` counts bytes of the WHOLE file (not just this request)
        # so progress/ETA stay meaningful across a resume.
        downloaded = resume_from if resumed else 0
        start_time = time.time()
        start_bytes = downloaded
        last_emit = 0.0

        with open(local_path, 'ab' if resumed else 'wb') as f:
            for chunk in r.iter_content(chunk_size=CHUNK_SIZE):
                if not chunk:
                    continue
                f.write(chunk)
                downloaded += len(chunk)

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

    return downloaded, local_path


def main():
    if len(sys.argv) != 4:
        print("Usage: python download_model.py <huggingface-gguf-repo> <gguf-file-name> <local-dir>")
        sys.exit(1)

    repo_id = sys.argv[1]
    filename = sys.argv[2]
    local_dir = sys.argv[3]
    token = get_token()

    print(f">>> Checking for split model files in {repo_id}...", flush=True)
    files_to_download = detect_split_files(filename)
    print(f">>> Downloading {len(files_to_download)} file(s) to {local_dir}...", flush=True)

    os.makedirs(local_dir, exist_ok=True)

    # Probe file sizes up-front so aggregate progress is accurate.
    headers = {'Authorization': f'Bearer {token}'} if token else {}
    total_bytes_all = 0
    for f in files_to_download:
        url = hf_hub_url(repo_id=repo_id, filename=f)
        total_bytes_all += head_size(url, headers)

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
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else '?'
        print(f"Error during download: HTTP {status} - {e}", flush=True)
        sys.exit(1)
    except Exception as e:
        print(f"Error during download: {e}", flush=True)
        sys.exit(1)

    emit('complete', totalBytes=bytes_before)
    print(">>> All downloads complete!", flush=True)


if __name__ == "__main__":
    main()
