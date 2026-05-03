#!/usr/bin/env python3
"""Clear the GNU_STACK PF_X bit on every shared object passed as an argument.

ctranslate2 ships .so files whose PT_GNU_STACK program header requests an
executable stack. Modern kernels (Linux 5.8+, gVisor) reject loading any
shared library that needs an exec stack, so `import ctranslate2` fails
with "cannot enable executable stack as shared object requires: Invalid
argument". Distributions historically ship `execstack` to clear this bit,
but execstack was removed from Debian. This script does the same patch
(~30 lines of struct unpacking, no external deps).
"""
from __future__ import annotations
import struct
import sys

PT_GNU_STACK = 0x6474e551
PF_X = 1


def patch(path: str) -> bool:
    """Returns True if the file was modified, False if it already had a
    non-exec stack (or no GNU_STACK header at all)."""
    with open(path, 'r+b') as f:
        f.seek(0)
        magic = f.read(4)
        if magic != b'\x7fELF':
            return False
        cls = f.read(1)[0]    # 1 = 32-bit, 2 = 64-bit
        endian = '<' if f.read(1)[0] == 1 else '>'
        if cls == 2:
            f.seek(0x20)
            phoff = struct.unpack(endian + 'Q', f.read(8))[0]
            f.seek(0x36)
            phentsize = struct.unpack(endian + 'H', f.read(2))[0]
            phnum = struct.unpack(endian + 'H', f.read(2))[0]
            # 64-bit Phdr layout: p_type(4) p_flags(4) p_offset(8) ...
            type_off, flags_off = 0, 4
        elif cls == 1:
            f.seek(0x1c)
            phoff = struct.unpack(endian + 'I', f.read(4))[0]
            f.seek(0x2a)
            phentsize = struct.unpack(endian + 'H', f.read(2))[0]
            phnum = struct.unpack(endian + 'H', f.read(2))[0]
            # 32-bit Phdr layout: p_type(4) p_offset(4) p_vaddr(4) p_paddr(4)
            #                     p_filesz(4) p_memsz(4) p_flags(4) p_align(4)
            type_off, flags_off = 0, 24
        else:
            return False

        for i in range(phnum):
            ph_off = phoff + i * phentsize
            f.seek(ph_off + type_off)
            p_type = struct.unpack(endian + 'I', f.read(4))[0]
            if p_type != PT_GNU_STACK:
                continue
            f.seek(ph_off + flags_off)
            p_flags = struct.unpack(endian + 'I', f.read(4))[0]
            if not (p_flags & PF_X):
                return False
            new_flags = p_flags & ~PF_X
            f.seek(ph_off + flags_off)
            f.write(struct.pack(endian + 'I', new_flags))
            return True
    return False


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print('usage: clear_execstack.py <so> [<so> ...]', file=sys.stderr)
        return 2
    rc = 0
    for path in argv[1:]:
        try:
            patched = patch(path)
            print(f'{path}: {"patched" if patched else "ok (no change)"}')
        except Exception as e:
            print(f'{path}: ERROR {e}', file=sys.stderr)
            rc = 1
    return rc


if __name__ == '__main__':
    sys.exit(main(sys.argv))
