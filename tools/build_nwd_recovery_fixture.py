"""Build an explicitly synthetic NWD with two usable fragments and one bad record.

Independent fixture layout shared with the Rust reader tests. Coordinates are
authored in metres; the file intentionally has no decoded partition-unit record.
Choose metres in the viewer. This is neither a real project nor Autodesk output.
"""
import argparse
from pathlib import Path
import struct
import zlib

OUTER = b"#LcUStream-V1.1 binary double release C lichunk-008\n"


def words(target, *values):
    target.extend(struct.pack("<" + "I" * len(values), *values))


def align(target, boundary):
    target.extend(b"\0" * (-len(target) % boundary))


def geometry(corrupt=False):
    result = bytearray()
    words(result, 100, 94, 101, 60, 3, 9)
    result.extend(struct.pack("<9f", float("nan") if corrupt else 0, 0, 0, 2, 0, 0, 0, 2, 0))
    words(result, 1, 2, 1, 0xC0000000)
    align(result, 8)
    return result


def fragments():
    result = bytearray()
    words(result, 3)
    for index in range(3):
        identity = 100 + index * 4
        words(result, identity, 13)
        align(result, 8)
        result.extend(struct.pack("<d", 1))
        words(result, 3 if index == 2 else 1, 4, 0, 123, 0, identity + 1, 55, 17, identity + 2, 54)
        result.extend(struct.pack("<14f", float("nan") if index == 0 else .2, .5, .8, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0))
        words(result, identity + 3, 93)
        result.extend(struct.pack("<6f", 0, 0, 0, 2.1 if index == 2 else 2, 2, 0))
        align(result, 8)
        result.extend(struct.pack("<3d", 4 if index == 2 else 0, 0, 0))
        result.extend(struct.pack("<f", 1))
        words(result, 0, index + 1)
    align(result, 8)
    return result


def build():
    records = [geometry(), geometry(True), geometry()]
    encoded = zlib.compress(b"".join(records))
    appendix = bytearray()
    words(appendix, len(records), 1, len(encoded), *(len(record) for record in records))
    align(appendix, 8)
    tail = zlib.compress(appendix)
    streams = [("synthetic\\LcOpNwdGeometry", b"\0" * 4 + encoded + tail, 4, len(tail)),
               ("synthetic\\LcOpNwdFragments", zlib.compress(fragments()), 0, 0)]
    file, directory = bytearray(OUTER), bytearray()
    words(directory, 0xFFFFFFFF, len(streams))
    for name, data, prefix, suffix in streams:
        name = name.encode("utf-8")
        words(directory, len(name))
        directory.extend(name)
        align(directory, 4)
        words(directory, 1)
        align(directory, 8)
        directory.extend(struct.pack("<QQ", len(file), len(data)))
        words(directory, prefix, suffix)
        file.extend(data)
    offset = len(file)
    file.extend(b"#LcUStream-V1.1 binary double release utf8 navisworks:431 lizlib\n")
    file.extend(b"\0" * 7 + zlib.compress(directory) + b"\0" * 8)
    file.extend(struct.pack("<Q", offset) + OUTER)
    return file


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("xb") as stream:
        stream.write(build())
    print("Synthetic NWD created. Choose metres; expected: two meshes, one unavailable fragment, appearance and consistency warnings.")
