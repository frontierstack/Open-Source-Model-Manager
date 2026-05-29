# Python sandbox image for running tool / skill code under gVisor.
#
# Ships with the common scientific + graphics stack so the chat's "Run"
# button on matplotlib / numpy / pandas / pygame snippets doesn't fail on
# ModuleNotFoundError. If you need something exotic (e.g. torch), fork
# the image — we intentionally don't pip-install at run time.
#
# Launched by webapp/services/sandboxRunner.js with:
#   --runtime=runsc
#   --network=none|allowlist|bridge  (per tool policy)
#   --read-only
#   --tmpfs /tmp
#   -v <scratch>:/work:ro
#   -v <artifacts>:/artifacts:rw   (user writes here; surfaces in UI)
#   -v <workspace>:/workspace:rw   (optional; file-op skills)
#   -e HTTPS_PROXY, HTTP_PROXY, SANDBOX_EGRESS_TOKEN  (allowlist tier)

FROM python:3.12-slim

# SDL runtime + a few native libs pygame and matplotlib need. No dev
# headers — we install pygame from a prebuilt wheel below.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libsdl2-2.0-0 \
        libsdl2-image-2.0-0 \
        libsdl2-mixer-2.0-0 \
        libsdl2-ttf-2.0-0 \
        libfreetype6 \
        libpng16-16 \
        libjpeg62-turbo \
        libopenblas0 \
        fontconfig \
        fonts-dejavu-core \
        # poppler-utils powers pdf2image (pdftoppm) for pdf_to_images, plus
        # pdftotext / pdfinfo as command-line fallbacks. ~8 MB installed.
        poppler-utils \
        # tesseract-ocr (+ eng traineddata) is the engine the ocr_image
        # skill drives via the pytesseract wrapper. Without it the skill
        # returns "pytesseract and/or PIL not installed" and the chat
        # agent loses its only structured OCR path. The webapp container
        # has its own tesseract for upload-time OCR; ocr_image runs
        # inside the sandbox so it needs its own copy.
        tesseract-ocr \
        # libzbar0 is the shared lib pyzbar dlopens for QR/barcode reading
        # (read_email_file scans QR codes in email attachments). Without
        # it `import pyzbar` raises ImportError("Unable to find zbar
        # shared library").
        libzbar0 \
        # WeasyPrint system stack — pango/cairo/harfbuzz/gdk-pixbuf for the
        # html_to_pdf skill. Without these the wheel import-time check
        # fails ("cannot load library 'libgobject-2.0-0'") even though
        # the Python package is present.
        libpango-1.0-0 \
        libpangoft2-1.0-0 \
        libpangocairo-1.0-0 \
        libharfbuzz0b \
        libcairo2 \
        libgdk-pixbuf-2.0-0 \
        shared-mime-info \
        # git + TLS roots for the sandboxed git_clone_shallow skill.
        # Only needed when the model asks to inspect a remote repo; cheap
        # to include unconditionally.
        git \
        ca-certificates \
        # curl + gnupg for the NodeSource setup script just below. Removed
        # again before the layer ends so they don't bloat the image.
        curl \
        gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get purge -y --auto-remove gnupg \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for defense-in-depth (gVisor is already the primary
# boundary). uid 1000 matches what sandboxRunner expects for chmod of
# the /artifacts mount point.
RUN groupadd -r sandbox && useradd -r -g sandbox -u 1000 sandbox \
    && mkdir -p /artifacts && chown sandbox:sandbox /artifacts

# Python stack. Grouped by purpose so image layering stays cache-friendly.
#   core network / parsing — used by scraping / data tools
#   scientific — numeric + tabular work the chat often generates
#   plotting — matplotlib with the Agg backend (headless)
#   imaging — pillow + pygame (+ SDL_VIDEODRIVER=dummy so pygame.display
#             can init in a headless sandbox)
#   symbolic — sympy for algebra / calculus demos
RUN pip install --no-cache-dir \
        requests==2.32.3 \
        beautifulsoup4==4.12.3 \
        lxml==5.3.0 \
        pyyaml==6.0.2 \
        jsonschema==4.23.0 \
        numpy==2.1.3 \
        pandas==2.2.3 \
        scipy==1.14.1 \
        matplotlib==3.9.3 \
        pillow==11.0.0 \
        sympy==1.13.3 \
        pygame==2.6.1 \
        reportlab==4.4.4 \
        python-docx==1.1.2 \
        openpyxl==3.1.5 \
        # PDF read + page count (pure Python) + raster (needs poppler-utils
        # from the apt layer above). markdown + WeasyPrint round out the
        # markdown_to_html / html_to_pdf skills. WeasyPrint depends on the
        # pango/cairo system libs installed above; without them, import
        # weasyprint fails at load time. pydyf is pinned because newer
        # WeasyPrint releases require its matching pydyf API — leaving
        # pydyf unpinned lets pip pull a too-new pydyf (0.12+) whose
        # `transform()` signature WeasyPrint 62 can't call (raises
        # `'super' object has no attribute 'transform'` mid-render).
        pypdf==4.3.1 \
        pdf2image==1.17.0 \
        markdown==3.7 \
        weasyprint==62.3 \
        pydyf==0.10.0 \
        # Python wrapper for the tesseract-ocr binary installed above —
        # used by the ocr_image skill.
        pytesseract==0.3.13 \
        # read_email_file skill uses these: PyPDF2 (legacy name kept for
        # the .pdf path; pypdf above is the renamed version — both are
        # shipped because skill code imports the legacy spelling),
        # extract_msg (Outlook .msg parsing), pyzbar (QR codes in
        # attachment images).
        PyPDF2==3.0.1 \
        extract-msg==0.48.5 \
        pyzbar==0.1.9 \
    && rm -rf /root/.cache

# Audio transcription (faster-whisper, CTranslate2 backend). The small.en
# CT2-format model is pre-downloaded to /opt/whisper-models/small.en/ so
# the sandbox (which runs with network=none for transcribe_audio) can use
# it without a runtime fetch. ~485MB model + ~150MB libs is the cost; the
# transcribe_audio skill points faster-whisper at this local path.
# small.en is a meaningful step up from tiny.en for lyrics / music
# transcription — tiny.en routinely garbled phrases that small.en gets
# right, and CPU transcription of a 5-min song stays under a minute.
#
# ffmpeg is pulled in because faster-whisper / pyav decode arbitrary
# containers (mp3, m4a, ogg, webm) via libav. Without it, only .wav works.
#
# `clear_execstack.py` patches the GNU_STACK PT header to clear the PF_X
# bit on the ctranslate2 native libraries. Modern kernels (5.8+) and
# gVisor reject loading any .so that requests an executable stack, which
# is what ctranslate2's pre-built wheel ships with. Without this patch,
# `import ctranslate2` fails with "cannot enable executable stack as shared
# object requires: Invalid argument". Debian dropped `execstack` from
# repos so we ship our own ELF patcher (~80 lines, stdlib only).
COPY clear_execstack.py /usr/local/bin/clear_execstack.py
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir \
        ctranslate2==4.5.0 \
        faster-whisper==1.0.3 \
    && rm -rf /root/.cache \
    && find /usr/local/lib/python3.12/site-packages/ctranslate2 \
            /usr/local/lib/python3.12/site-packages/ctranslate2.libs \
            -name '*.so*' -print0 2>/dev/null \
       | xargs -0 python3 /usr/local/bin/clear_execstack.py \
    && python3 -c "from huggingface_hub import snapshot_download; \
        snapshot_download('Systran/faster-whisper-small.en', \
                          local_dir='/opt/whisper-models/small.en', \
                          local_dir_use_symlinks=False)" \
    && rm -rf /root/.cache /tmp/* \
    && chmod -R a+rX /opt/whisper-models

# DejaVu italic/oblique faces (NOT in fonts-dejavu-core, installed early
# above) so create_pdf renders *italic* spans in a Unicode-capable font
# instead of falling back to Times-Italic (which drops non-Latin glyphs).
# Added as a late layer so the heavy whisper/ctranslate2 layers above stay
# cached on rebuild.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-extra \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp baked in so the download_video / convert_youtube_to_mp3 skills don't
# pip-install it on first use (the cold install + dependency resolution was
# what pushed those skills past their sandbox timeout). ffmpeg is already
# installed above (whisper layer) — yt-dlp uses it to merge video+audio into
# mp4 and to extract/transcode mp3. Pinned for reproducible builds, but this
# is the one dep where "latest" is genuinely recommended: YouTube changes
# routinely break older yt-dlp, so bump this when downloads start failing.
# Added as a late layer so the heavy whisper/ctranslate2 layers above stay
# cached on rebuild.
RUN pip install --no-cache-dir yt-dlp==2026.03.17 \
    && python3 -c "import yt_dlp; print('yt-dlp', yt_dlp.version.__version__)"

# matplotlib headless default — prevents "no display name" errors when
# snippets forget plt.switch_backend('Agg').
ENV MPLBACKEND=Agg
# Matplotlib's config/cache dir — $HOME is read-only in the sandbox
# (/home/sandbox owned by root on this image), so point it at /tmp
# which is a writable tmpfs inside every run.
ENV MPLCONFIGDIR=/tmp/.matplotlib
# pygame without a real X server / Wayland. Lets pygame.display.set_mode()
# succeed so demos can at least run their game loop (and blit to an
# offscreen surface the user can save to /artifacts via pygame.image.save).
ENV SDL_VIDEODRIVER=dummy
ENV SDL_AUDIODRIVER=dummy
# pygame prints a 2-line "Hello from the pygame community" banner on
# import. The run-code harness imports pygame preemptively to install
# its auto-exit hook, so without this every snippet output would start
# with that banner. Official env var for silent import.
ENV PYGAME_HIDE_SUPPORT_PROMPT=hide
ENV XDG_CACHE_HOME=/tmp/.cache
ENV XDG_CONFIG_HOME=/tmp/.config

USER sandbox
WORKDIR /tmp

CMD ["python3", "--version"]
