#!/bin/bash

export PYTHONPATH="/usr/local/lib/python3.11/dist-packages:$PYTHONPATH"

# Check if parameters are provided
if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <huggingface-gguf-repo> <gguf-file-name>"
  echo "Example: $0 TheBloke/Llama-2-7B-GGUF llama-2-7b.Q4_K_M.gguf"
  exit 1
fi

GGUF_REPO=$1
GGUF_FILE=$2
MODEL_BASENAME=$(basename ${GGUF_REPO})
MODEL_PATH="/models/${MODEL_BASENAME}"

# Variable to store Python process PID
PYTHON_PID=""

# SIGTERM/SIGINT handler for graceful cancellation.
# The Python downloader installs its own handler: it flushes and closes the
# partial file, writes an `interrupted` state manifest so the file stays
# resumable, and exits 143. So we must ask it to stop and then WAIT for that
# cleanup to finish before exiting ourselves — killing the shell first would
# leave the manifest claiming the download is still running.
cleanup() {
  echo ">>> Download cancelled - asking the downloader to stop and flush..."
  if [ -n "$PYTHON_PID" ]; then
    kill -TERM "$PYTHON_PID" 2>/dev/null || true
    # `wait` is interruptible; loop until the child is really gone so the
    # manifest/partial file are on disk before we exit.
    while kill -0 "$PYTHON_PID" 2>/dev/null; do
      wait "$PYTHON_PID" 2>/dev/null
    done
  fi
  echo ">>> Download interrupted - partial file left in place and is resumable"
  exit 143
}

# Set up traps
trap cleanup SIGTERM SIGINT

# Download the GGUF model from Hugging Face
echo ">>> Downloading GGUF model ${GGUF_REPO}/${GGUF_FILE}..."
python3 -u /usr/src/app/scripts/download_model.py "${GGUF_REPO}" "${GGUF_FILE}" "${MODEL_PATH}" &

# Store the Python process PID
PYTHON_PID=$!

# Wait for the Python process to complete. `wait` returns early when a signal
# is trapped, so loop until the child has actually exited.
PYTHON_EXIT_CODE=0
while kill -0 "$PYTHON_PID" 2>/dev/null; do
  wait "$PYTHON_PID"
  PYTHON_EXIT_CODE=$?
done

# A signal delivered straight to the Python process (e.g. the whole process
# group getting SIGTERM on a container restart) surfaces here as 143.
if [ $PYTHON_EXIT_CODE -eq 143 ] || [ $PYTHON_EXIT_CODE -eq 130 ]; then
  echo ">>> Download interrupted - partial file left in place and is resumable"
  exit 143
fi

# If Python process failed, exit with its code
if [ $PYTHON_EXIT_CODE -ne 0 ]; then
  echo ">>> Download failed with exit code $PYTHON_EXIT_CODE"
  exit $PYTHON_EXIT_CODE
fi

echo ">>> Model downloaded to ${MODEL_PATH}/${GGUF_FILE}"
echo ">>> Download complete. Use the Model Manager to load this model into llama.cpp."
