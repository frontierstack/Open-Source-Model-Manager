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
    && rm -rf /root/.cache

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
