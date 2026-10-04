"""Apply workspace writes without following user-created symbolic links.

Every component is resolved relative to an already-open directory descriptor.
An editor running a concurrent shell therefore cannot swap an ancestor for a
symlink between checking its name and opening the destination.
"""
import json
import os
import stat
import sys


def parts_for(name):
    if not isinstance(name, str) or not name or len(name) > 1024:
        raise ValueError("Invalid workspace path")
    parts = name.replace("\\", "/").split("/")
    if len(parts) > 64 or any(p in ("", ".", "..") or "\x00" in p or ":" in p for p in parts):
        raise ValueError("Invalid workspace path")
    return parts


def apply(root, files, preserve, identity=None):
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root_fd = os.open(root, directory_flags)
    try:
        for item in files:
            parts = parts_for(item["path"])
            is_folder = item["type"] == "FOLDER"
            parent_fd = os.dup(root_fd)
            try:
                for segment in parts if is_folder else parts[:-1]:
                    try:
                        os.mkdir(segment, 0o755, dir_fd=parent_fd)
                    except FileExistsError:
                        pass
                    next_fd = os.open(segment, directory_flags, dir_fd=parent_fd)
                    if identity is not None:
                        os.fchown(next_fd, *identity)
                    os.close(parent_fd)
                    parent_fd = next_fd
                if not is_folder:
                    # Do not truncate until the opened inode is verified. A
                    # FIFO must not block the broker, and hard links must not
                    # let it overwrite another name for a privileged file.
                    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
                    flags |= os.O_EXCL if preserve else 0
                    try:
                        fd = os.open(parts[-1], flags, 0o644, dir_fd=parent_fd)
                    except FileExistsError:
                        if preserve:
                            continue
                        raise
                    with os.fdopen(fd, "wb") as destination:
                        metadata = os.fstat(destination.fileno())
                        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                            raise ValueError("Workspace destinations must be regular files without hard links")
                        if identity is not None:
                            os.fchown(destination.fileno(), *identity)
                        os.ftruncate(destination.fileno(), 0)
                        destination.write(item.get("content", "").encode("utf-8"))
            finally:
                os.close(parent_fd)
    finally:
        os.close(root_fd)


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        identity = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) == 4 else None
        apply(sys.argv[1], request["files"], request.get("preserveExisting", False), identity)
        print(json.dumps({"ok": True}))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(1)
