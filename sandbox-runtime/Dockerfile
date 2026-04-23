# Minimal Python sandbox image for running tool / skill code under gVisor.
#
# Kept intentionally thin — skill code is mounted in at runtime, not baked
# into the image. Only pre-install libraries that the stock skill catalog
# relies on so import failures don't hide sandbox errors.
#
# Launched by webapp/services/sandboxRunner.js with:
#   --runtime=runsc
#   --network=none|allowlist|bridge (per tool policy)
#   --read-only
#   --tmpfs /tmp
#   -v <skill.py>:/skill.py:ro
#   -v <params.json>:/params.json:ro
#   -v <artifact-dir>:/artifacts
#   -e HTTPS_PROXY, HTTP_PROXY, PROXY_TOKEN   (allowlist tier only)
#
# Container exits with the skill's stdout (must be JSON) and a 0/1 status.

FROM python:3.12-slim

# Run as a non-root user inside the container. gVisor already blocks most
# escalations, but defense in depth: if the skill somehow breaks out of the
# Python interpreter, it still only has a nobody's privileges.
RUN groupadd -r sandbox && useradd -r -g sandbox -u 1000 sandbox \
    && mkdir -p /artifacts && chown sandbox:sandbox /artifacts

# Commonly-used libs. Keep the list short — every package is attack surface.
# Skills that need rare libs can request them via a `requirements` field at
# some future date; for now this covers the default catalog.
RUN pip install --no-cache-dir \
        requests==2.32.3 \
        beautifulsoup4==4.12.3 \
        lxml==5.3.0 \
        pyyaml==6.0.2 \
        jsonschema==4.23.0 \
    && rm -rf /root/.cache

USER sandbox
WORKDIR /tmp

# Default entrypoint — webapp overrides with the specific skill command.
CMD ["python3", "--version"]
