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

# SIGTERM handler for graceful cancellation
cleanup() {
  echo ">>> Download cancelled by user"
  if [ -n "$PYTHON_PID" ]; then
    kill -TERM "$PYTHON_PID" 2>/dev/null || true
    wait "$PYTHON_PID" 2>/dev/null || true
  fi
  exit 143
}

# Set up trap for SIGTERM
trap cleanup SIGTERM

# Download the GGUF model from Hugging Face
echo ">>> Downloading GGUF model ${GGUF_REPO}/${GGUF_FILE}..."
python3 -u /usr/src/app/scripts/download_model.py "${GGUF_REPO}" "${GGUF_FILE}" "${MODEL_PATH}" &

# Store the Python process PID
PYTHON_PID=$!

# Wait for the Python process to complete
wait $PYTHON_PID
PYTHON_EXIT_CODE=$?

# If Python process failed, exit with its code
if [ $PYTHON_EXIT_CODE -ne 0 ]; then
  echo ">>> Download failed with exit code $PYTHON_EXIT_CODE"
  exit $PYTHON_EXIT_CODE
fi

echo ">>> Model downloaded to ${MODEL_PATH}/${GGUF_FILE}"
echo ">>> Download complete. Use the Model Manager to load this model into llama.cpp."
