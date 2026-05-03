"""Tiny image-generation HTTP service. Loads SDXL-Turbo on first request,
keeps it warm in process memory. Listens on :5000.

Routes:
  GET  /health         — liveness; returns whether pipeline is loaded
  POST /generate       — text -> PNG; returns base64

Request body for /generate:
  {
    "prompt": "...",                 # required
    "negative_prompt": "...",        # optional (SDXL-Turbo ignores this at
                                     #   guidance_scale=0 but we accept it
                                     #   for API stability with future
                                     #   non-Turbo backends)
    "width": 1024, "height": 1024,   # default 1024x1024 (SDXL-Turbo native)
    "steps": 4,                      # default 4 (SDXL-Turbo target)
    "seed": null                     # optional int for reproducibility
  }

Response:
  {
    "image_base64": "...",
    "duration_ms": 4321,
    "seed": 42,
    "width": 1024, "height": 1024,
    "steps": 4
  }
"""

from __future__ import annotations
import base64
import io
import logging
import os
import time
from threading import Lock
from typing import Optional

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="[imagegen] %(message)s")
log = logging.getLogger("imagegen")

MODEL_ID = os.environ.get("IMAGEGEN_MODEL", "stabilityai/sdxl-turbo")
HAS_CUDA = torch.cuda.is_available()
DTYPE = torch.float16 if HAS_CUDA else torch.float32
# Approximate VRAM budget for SDXL-Turbo fp16 fully on-device. Used to decide
# whether to fall back to CPU-offload when coexisting with an LLM that has
# eaten most of the card. Empirical: SDXL fp16 weights are ~5.0 GiB; peak
# during inference is a touch more.
SDXL_FP16_BUDGET_BYTES = int(os.environ.get("IMAGEGEN_GPU_BUDGET_BYTES", str(6 * 1024**3)))
# Below this much free VRAM, fall back from model_cpu_offload (which keeps the
# whole submodel resident during its forward) to sequential_cpu_offload
# (paged per-module — peak is ~0.5–1 GiB but ~3-5x slower). Picked at the
# point where model_cpu_offload starts OOMing in practice when an LLM owns
# most of the card.
SDXL_SEQUENTIAL_OFFLOAD_BYTES = int(os.environ.get("IMAGEGEN_SEQUENTIAL_BUDGET_BYTES", str(3 * 1024**3)))

app = FastAPI(title="imagegen", version="1.0.0")
_pipe = None
_pipe_lock = Lock()
# Resolved at load time so /health and /generate can echo back what we picked.
_resolved_device = None
_offload_mode = None  # None | "model" — set when enable_model_cpu_offload was used


def _enable_model_offload(pipe, device_str, free_bytes):
    """Submodel-level CPU offload: each pipeline stage (text encoder, UNet,
    VAE) gets paged onto the GPU when its forward runs, then back to CPU.
    Peak GPU memory ~ size of the largest submodel."""
    global _resolved_device, _offload_mode
    log.warning(
        "free VRAM %.2f GiB on %s; enabling model_cpu_offload",
        free_bytes / 1024**3, device_str,
    )
    try:
        gpu_idx = int(device_str.split(":")[1])
        pipe.enable_model_cpu_offload(gpu_id=gpu_idx)
    except TypeError:
        pipe.enable_model_cpu_offload()
    # VAE slicing decodes images one at a time across the batch dim;
    # tiling splits decoding into spatial tiles so peak VAE memory is
    # bounded regardless of resolution. Both are no-ops for SDXL-Turbo's
    # default 1024² single-image case but cheap insurance against OOM
    # when an LLM is co-resident.
    try: pipe.enable_vae_slicing()
    except Exception: pass
    try: pipe.enable_vae_tiling()
    except Exception: pass
    _resolved_device = device_str
    _offload_mode = "model"


def _enable_sequential_offload(pipe, device_str, free_bytes):
    """Per-module CPU offload: each torch Module (linear, conv, attention)
    moves to the GPU only for its forward call. Peak GPU memory drops to
    the largest single module — typically <1 GiB. Slower than model
    offload (~3-5x), but the only path that fits when an LLM has eaten
    most of the card."""
    global _resolved_device, _offload_mode
    log.warning(
        "free VRAM %.2f GiB on %s — too tight for model_cpu_offload; using sequential_cpu_offload",
        free_bytes / 1024**3, device_str,
    )
    try:
        gpu_idx = int(device_str.split(":")[1])
        pipe.enable_sequential_cpu_offload(gpu_id=gpu_idx)
    except TypeError:
        pipe.enable_sequential_cpu_offload()
    try: pipe.enable_vae_slicing()
    except Exception: pass
    try: pipe.enable_vae_tiling()
    except Exception: pass
    _resolved_device = device_str
    _offload_mode = "sequential"


def _force_sequential_load():
    """Rebuild the pipeline at the sequential-offload tier regardless of
    free-memory heuristics. Used as a fallback after an inference OOM:
    the heuristic was too optimistic, so skip it and use the tightest
    placement that still works."""
    global _pipe
    with _pipe_lock:
        if _pipe is not None:
            return _pipe
        from diffusers import AutoPipelineForText2Image
        picked = _pick_cuda_device()
        device_str, free_bytes = picked if picked else ("cpu", 0)
        log.info("rebuilding %s under forced sequential offload on %s", MODEL_ID, device_str)
        kwargs = {"torch_dtype": DTYPE}
        if device_str.startswith("cuda"):
            kwargs["variant"] = "fp16"
        try:
            pipe = AutoPipelineForText2Image.from_pretrained(MODEL_ID, **kwargs)
        except Exception:
            kwargs.pop("variant", None)
            pipe = AutoPipelineForText2Image.from_pretrained(MODEL_ID, **kwargs)
        if device_str == "cpu":
            pipe.to("cpu")
            global _resolved_device, _offload_mode
            _resolved_device = "cpu"
            _offload_mode = None
        else:
            _enable_sequential_offload(pipe, device_str, free_bytes)
        if hasattr(pipe, "safety_checker") and pipe.safety_checker is not None \
                and os.environ.get("IMAGEGEN_SAFETY_CHECKER") != "1":
            pipe.safety_checker = None
        _pipe = pipe
        return _pipe


def _pick_cuda_device():
    """Pick the CUDA device with the most free memory. Returns a torch.device
    string like "cuda:1", or None if no CUDA. With multi-GPU boxes that also
    run an LLM, this matters: diffusers defaults to cuda:0, which is often
    the GPU that's already full."""
    if not HAS_CUDA:
        return None
    n = torch.cuda.device_count()
    if n == 0:
        return None
    best_idx, best_free = 0, -1
    for i in range(n):
        try:
            free, _total = torch.cuda.mem_get_info(i)
        except Exception:
            free = 0
        if free > best_free:
            best_idx, best_free = i, free
    log.info("picked cuda:%d with %.2f GiB free", best_idx, best_free / 1024**3)
    return f"cuda:{best_idx}", best_free


def _load_pipeline():
    """Lazy-load on first /generate. Holds _pipe_lock so two concurrent
    cold requests don't double-load the model and OOM the GPU.

    On multi-GPU boxes the freest device is selected (diffusers' default of
    cuda:0 fails when an LLM owns it). If even the freest device has less
    free VRAM than the SDXL fp16 budget, we use enable_model_cpu_offload —
    slower (~3-5x) but lets imagegen coexist with a loaded LLM."""
    global _pipe, _resolved_device, _offload_mode
    if _pipe is not None:
        return _pipe
    with _pipe_lock:
        if _pipe is not None:
            return _pipe

        picked = _pick_cuda_device() if HAS_CUDA else None
        if picked is None:
            device_str, free_bytes = "cpu", 0
        else:
            device_str, free_bytes = picked

        log.info("loading %s targeting %s (%s)", MODEL_ID, device_str, DTYPE)
        t0 = time.time()
        from diffusers import AutoPipelineForText2Image
        kwargs = {"torch_dtype": DTYPE}
        # SDXL-Turbo ships an fp16 variant; using it cuts download size and
        # avoids fp32-on-load -> fp16-after thrash. Other models may not
        # have an fp16 variant; tolerate the absence.
        if device_str.startswith("cuda"):
            kwargs["variant"] = "fp16"
        try:
            pipe = AutoPipelineForText2Image.from_pretrained(MODEL_ID, **kwargs)
        except Exception as e:
            log.warning("fp16 variant unavailable (%s); retrying without variant", e)
            kwargs.pop("variant", None)
            pipe = AutoPipelineForText2Image.from_pretrained(MODEL_ID, **kwargs)

        # Three placement modes, picked from free VRAM:
        #   - fully on GPU      (free >= 6 GiB)  — fastest
        #   - model_cpu_offload (free >= 3 GiB)  — keeps whole submodel resident
        #   - sequential_cpu_offload (else)      — pages per-module, ~3-5x slower
        # The .to(...) and offload calls are wrapped so a rougher free-mem
        # estimate doesn't hard-fail us.
        if device_str == "cpu":
            pipe.to("cpu")
            _resolved_device = "cpu"
            log.warning("CUDA unavailable; running on CPU (slow)")
        elif free_bytes < SDXL_SEQUENTIAL_OFFLOAD_BYTES:
            _enable_sequential_offload(pipe, device_str, free_bytes)
        elif free_bytes < SDXL_FP16_BUDGET_BYTES:
            _enable_model_offload(pipe, device_str, free_bytes)
        else:
            try:
                pipe.to(device_str)
                _resolved_device = device_str
            except torch.cuda.OutOfMemoryError as oom:
                log.warning("OOM on %s during .to(); retrying with model_cpu_offload (%s)", device_str, oom)
                torch.cuda.empty_cache()
                _enable_model_offload(pipe, device_str, free_bytes)

        # Disable the safety checker if present — SDXL-Turbo doesn't ship
        # one but the AutoPipeline path can wire StableDiffusionSafetyChecker
        # in for some checkpoints, and false positives are common at low
        # step counts. Keep this opt-in via env if anyone wants it back.
        if hasattr(pipe, "safety_checker") and pipe.safety_checker is not None \
                and os.environ.get("IMAGEGEN_SAFETY_CHECKER") != "1":
            pipe.safety_checker = None
        _pipe = pipe
        log.info("loaded in %.1fs (device=%s, offload=%s)", time.time() - t0, _resolved_device, _offload_mode)
        return _pipe


class GenReq(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=4000)
    negative_prompt: Optional[str] = Field(None, max_length=2000)
    width: int = Field(1024, ge=64, le=2048)
    height: int = Field(1024, ge=64, le=2048)
    steps: int = Field(4, ge=1, le=50)
    seed: Optional[int] = None


@app.get("/health")
def health():
    return {
        "ok": True,
        "loaded": _pipe is not None,
        "model": MODEL_ID,
        "device": _resolved_device or ("cuda" if HAS_CUDA else "cpu"),
        "offload": _offload_mode,
        "cuda_available": torch.cuda.is_available(),
        "cuda_devices": torch.cuda.device_count() if torch.cuda.is_available() else 0,
    }


@app.post("/generate")
def generate(req: GenReq):
    global _pipe, _offload_mode
    pipe = _load_pipeline()

    # Round dims to the pipeline's expected multiple of 8 — SDXL silently
    # produces black images otherwise. Same convention as A1111's grid
    # input snapping.
    width = (req.width // 8) * 8
    height = (req.height // 8) * 8

    generator = None
    seed_used = req.seed
    if req.seed is None:
        # Generate a stable random seed so the response can echo it back —
        # users want to be able to reproduce a generation later.
        seed_used = int.from_bytes(os.urandom(4), "big")
    # CPU-offload pipelines move submodules between CPU and GPU at runtime;
    # the generator must live on CPU in that case (creating it on the GPU
    # device works for fully-resident pipelines but not for offloaded ones).
    gen_device = "cpu" if _offload_mode else (_resolved_device or "cpu")
    generator = torch.Generator(device=gen_device).manual_seed(seed_used)

    # SDXL-Turbo: guidance_scale must be 0.0 for the calibrated 4-step
    # path. Other models would need a different default; if you swap
    # MODEL_ID, also adjust GUIDANCE.
    guidance_scale = 0.0 if "turbo" in MODEL_ID.lower() else 7.5

    def _run(p):
        return p(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt,
            num_inference_steps=req.steps,
            guidance_scale=guidance_scale,
            width=width,
            height=height,
            generator=generator,
        )

    t0 = time.time()
    try:
        image = _run(pipe).images[0]
    except torch.cuda.OutOfMemoryError as oom:
        # Coexisting with an LLM that grabs more memory between pipeline
        # load and inference is the common case here. Tear down, rebuild
        # at the most aggressive offload tier, retry once.
        log.warning("OOM during inference (%s); rebuilding pipeline with sequential_cpu_offload", oom)
        torch.cuda.empty_cache()
        with _pipe_lock:
            _pipe = None
            _offload_mode = None
        # Reload at sequential tier explicitly. Re-pick device since the LLM
        # may have rebalanced across cards while we were running.
        _force_sequential_load()
        try:
            image = _run(_pipe).images[0]
        except torch.cuda.OutOfMemoryError as oom2:
            torch.cuda.empty_cache()
            raise HTTPException(
                status_code=507,
                detail=f"GPU OOM even with sequential offload — an LLM is consuming the GPU. Free some VRAM and retry. Last error: {oom2}",
            ) from oom2
    except Exception as e:
        log.exception("generation failed")
        raise HTTPException(status_code=500, detail=str(e)) from e

    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    payload = base64.b64encode(buf.getvalue()).decode("ascii")

    return {
        "image_base64": payload,
        "duration_ms": int((time.time() - t0) * 1000),
        "seed": seed_used,
        "width": width,
        "height": height,
        "steps": req.steps,
        "model": MODEL_ID,
    }
