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
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32

app = FastAPI(title="imagegen", version="1.0.0")
_pipe = None
_pipe_lock = Lock()


def _load_pipeline():
    """Lazy-load on first /generate. Holds _pipe_lock so two concurrent
    cold requests don't double-load the model and OOM the GPU."""
    global _pipe
    if _pipe is not None:
        return _pipe
    with _pipe_lock:
        if _pipe is not None:
            return _pipe
        log.info("loading %s on %s (%s)", MODEL_ID, DEVICE, DTYPE)
        t0 = time.time()
        from diffusers import AutoPipelineForText2Image
        kwargs = {"torch_dtype": DTYPE}
        # SDXL-Turbo ships an fp16 variant; using it cuts download size and
        # avoids fp32-on-load -> fp16-after thrash. Other models may not
        # have an fp16 variant; tolerate the absence.
        if DEVICE == "cuda":
            kwargs["variant"] = "fp16"
        try:
            pipe = AutoPipelineForText2Image.from_pretrained(MODEL_ID, **kwargs)
        except Exception as e:
            log.warning("fp16 variant unavailable (%s); retrying without variant", e)
            kwargs.pop("variant", None)
            pipe = AutoPipelineForText2Image.from_pretrained(MODEL_ID, **kwargs)
        pipe.to(DEVICE)
        # Disable the safety checker if present — SDXL-Turbo doesn't ship
        # one but the AutoPipeline path can wire StableDiffusionSafetyChecker
        # in for some checkpoints, and false positives are common at low
        # step counts. Keep this opt-in via env if anyone wants it back.
        if hasattr(pipe, "safety_checker") and pipe.safety_checker is not None \
                and os.environ.get("IMAGEGEN_SAFETY_CHECKER") != "1":
            pipe.safety_checker = None
        _pipe = pipe
        log.info("loaded in %.1fs", time.time() - t0)
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
        "device": DEVICE,
        "cuda_available": torch.cuda.is_available(),
        "cuda_devices": torch.cuda.device_count() if torch.cuda.is_available() else 0,
    }


@app.post("/generate")
def generate(req: GenReq):
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
    generator = torch.Generator(device=DEVICE).manual_seed(seed_used)

    t0 = time.time()
    try:
        # SDXL-Turbo: guidance_scale must be 0.0 for the calibrated 4-step
        # path. Other models would need a different default; if you swap
        # MODEL_ID, also adjust GUIDANCE.
        guidance_scale = 0.0 if "turbo" in MODEL_ID.lower() else 7.5
        result = pipe(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt,
            num_inference_steps=req.steps,
            guidance_scale=guidance_scale,
            width=width,
            height=height,
            generator=generator,
        )
        image = result.images[0]
    except torch.cuda.OutOfMemoryError as e:
        torch.cuda.empty_cache()
        raise HTTPException(status_code=507, detail=f"GPU OOM: {e}") from e
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
