#!/usr/bin/env python3
"""
AIMem Compress CLI — called by Node.js memoryCompressorService.js

Reads JSON from a params file, runs compression pipeline, outputs JSON to stdout.

Input JSON format:
{
    "messages": [
        {"role": "system"|"user"|"assistant", "content": "..."},
        ...
    ],
    "query": "current user question",
    "token_budget": 1000,
    "dedup_threshold": 0.45
}

Output JSON format:
{
    "success": true,
    "compressed_messages": [...],
    "stats": {
        "original_tokens": N,
        "compressed_tokens": N,
        "reduction_pct": N,
        "tokens_saved": N
    }
}
"""

import json
import sys
import os

# Add services dir to path so we can import aimem_compressor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aimem_compressor import MemoryCompressor, MemoryEntry, count_tokens


def messages_to_entries(messages):
    """Convert chat messages to MemoryEntry objects with importance scoring."""
    entries = []
    total = len(messages)

    for i, msg in enumerate(messages):
        role = msg.get("role", "user")
        content = msg.get("content", "")

        # Skip empty messages
        if not content or not isinstance(content, str):
            continue

        # Importance scoring:
        # - System messages: highest (always keep)
        # - Recent messages: higher importance (recency bias)
        # - User messages: slightly higher than assistant (preserve intent)
        recency = (i + 1) / total  # 0..1, higher = more recent

        if role == "system":
            importance = 1.0
        elif role == "user":
            importance = 0.5 + (recency * 0.5)  # 0.5 to 1.0
        else:  # assistant
            importance = 0.3 + (recency * 0.5)  # 0.3 to 0.8

        entries.append(MemoryEntry(
            content=content,
            source=f"{role}_{i}",
            importance=round(importance, 2),
        ))

    return entries


def entries_to_messages(entries, original_messages):
    """Map compressed entries back to message format, preserving roles."""
    compressed = []
    # Build a source->role lookup from originals
    role_map = {}
    for i, msg in enumerate(original_messages):
        role = msg.get("role", "user")
        role_map[f"{role}_{i}"] = role

    for entry in entries:
        role = role_map.get(entry.source, "user")
        compressed.append({
            "role": role,
            "content": entry.content,
        })

    return compressed


def main():
    # Read params file path from argv
    if len(sys.argv) < 2:
        json.dump({"success": False, "error": "No params file provided"}, sys.stdout)
        return

    params_file = sys.argv[1]
    try:
        with open(params_file, 'r') as f:
            params = json.load(f)
    except Exception as e:
        json.dump({"success": False, "error": f"Failed to read params: {e}"}, sys.stdout)
        return

    messages = params.get("messages", [])
    query = params.get("query", "")
    token_budget = params.get("token_budget", 1000)
    dedup_threshold = params.get("dedup_threshold", 0.45)

    if not messages:
        json.dump({"success": True, "compressed_messages": [], "stats": {}}, sys.stdout)
        return

    try:
        # Separate system messages (never compress those)
        system_msgs = [m for m in messages if m.get("role") == "system"]
        non_system_msgs = [m for m in messages if m.get("role") != "system"]

        if not non_system_msgs:
            json.dump({
                "success": True,
                "compressed_messages": messages,
                "stats": {"original_tokens": 0, "compressed_tokens": 0,
                          "reduction_pct": 0, "tokens_saved": 0}
            }, sys.stdout)
            return

        # Convert to entries
        entries = messages_to_entries(non_system_msgs)
        original_entries = list(entries)

        # Run compression
        compressor = MemoryCompressor(
            dedup_threshold=dedup_threshold,
            token_budget=token_budget,
        )
        compressed_entries = compressor.compress(entries, query=query)

        # Get stats
        stats = compressor.stats(original_entries, compressed_entries)

        # Convert back to messages
        compressed_msgs = entries_to_messages(compressed_entries, non_system_msgs)

        # Prepend system messages (uncompressed)
        result_messages = system_msgs + compressed_msgs

        json.dump({
            "success": True,
            "compressed_messages": result_messages,
            "stats": {
                "original_tokens": stats["original_tokens"],
                "compressed_tokens": stats["compressed_tokens"],
                "reduction_pct": stats["reduction_pct"],
                "tokens_saved": stats["tokens_saved"],
                "original_entries": stats["original_entries"],
                "compressed_entries": stats["compressed_entries"],
            }
        }, sys.stdout)

    except Exception as e:
        json.dump({"success": False, "error": str(e)}, sys.stdout)


if __name__ == "__main__":
    main()
