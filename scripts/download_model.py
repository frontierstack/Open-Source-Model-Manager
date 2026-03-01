from huggingface_hub import hf_hub_download, list_repo_files
import sys
import os
import re

def detect_split_files(repo_id, filename):
    """Detect if this is a split model and return all split files."""
    # Check if filename matches split pattern (e.g., Q8_0/model-00003-of-00003.gguf)
    match = re.match(r'(.+)-(\d{5})-of-(\d{5})(\.gguf)$', os.path.basename(filename))
    if not match:
        return [filename]  # Not a split model

    base_name, part_num, total_parts, ext = match.groups()
    total = int(total_parts)
    directory = os.path.dirname(filename)

    print(f">>> Detected split model: {total} parts")

    # Generate all split filenames with directory prefix if present
    split_files = []
    for i in range(1, total + 1):
        split_name = f"{base_name}-{i:05d}-of-{total_parts}{ext}"
        if directory:
            split_files.append(f"{directory}/{split_name}")
        else:
            split_files.append(split_name)

    print(f">>> Will download: {', '.join([os.path.basename(f) for f in split_files])}")
    return split_files

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python download_model.py <huggingface-gguf-repo> <gguf-file-name> <local-dir>")
        sys.exit(1)

    repo_id = sys.argv[1]
    filename = sys.argv[2]
    local_dir = sys.argv[3]

    print(f">>> Checking for split model files in {repo_id}...")
    files_to_download = detect_split_files(repo_id, filename)

    print(f">>> Downloading {len(files_to_download)} file(s) to {local_dir}...")

    try:
        # Ensure the local directory exists
        os.makedirs(local_dir, exist_ok=True)

        # Download all files
        for file in files_to_download:
            print(f">>> Downloading {file}...")
            file_path = hf_hub_download(
                repo_id=repo_id,
                filename=file,
                local_dir=local_dir,
                local_dir_use_symlinks=False
            )
            print(f">>> Downloaded: {file_path}")

        print(f">>> All downloads complete!")
    except Exception as e:
        print(f"Error during download: {e}")
        sys.exit(1)
