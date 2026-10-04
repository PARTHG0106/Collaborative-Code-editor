#!/usr/bin/env python3
"""Generate or verify the deterministic archive of the jail's five safe devices.

Tar headers describe the nodes without requiring mknod on the build host.
Dockerfile ADD materializes them through BuildKit's image file operation, not
inside a RUN container. No host device or filesystem content is read.
"""
import argparse
import hashlib
import io
import pathlib
import tarfile

DEVICES = (("null", 1, 3), ("zero", 1, 5), ("random", 1, 8),
           ("urandom", 1, 9), ("tty", 5, 0))


def archive():
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as package:
        for name, major, minor in DEVICES:
            item = tarfile.TarInfo(name)
            item.type = tarfile.CHRTYPE
            item.mode = 0o666
            item.uid = item.gid = 0
            item.uname = item.gname = "root"
            item.mtime = 0
            item.devmajor, item.devminor = major, minor
            package.addfile(item)
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", type=pathlib.Path,
                        default=pathlib.Path(__file__).with_name("devices.tar"))
    parser.add_argument("--verify", action="store_true")
    arguments = parser.parse_args()
    expected = archive()
    if arguments.verify:
        if arguments.path.read_bytes() != expected:
            parser.error("device archive differs from the five approved deterministic headers")
    else:
        arguments.path.write_bytes(expected)
    print(("Verified" if arguments.verify else "Generated") + " safe device archive: "
          + hashlib.sha256(expected).hexdigest())


if __name__ == "__main__":
    main()
