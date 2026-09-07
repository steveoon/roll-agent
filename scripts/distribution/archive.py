"""Create deterministic, link-free distribution archives (build hosts only)."""

import gzip
import argparse
import os
from pathlib import Path
import shutil
import stat
import tarfile
import zipfile


def archive(source: Path, destination: Path, fast: bool = False) -> None:
    paths = sorted(source.rglob("*"))
    if any(path.is_symlink() for path in paths):
        raise ValueError("Distribution archives cannot contain symbolic links")
    if destination.suffix == ".zip":
        with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED) as output:
            for path in paths:
                if path.is_dir():
                    continue
                entry = zipfile.ZipInfo(path.relative_to(source).as_posix(), (1980, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.external_attr = (stat.S_IFREG | 0o644) << 16
                if fast:
                    # Synthetic upgrade fixtures favor CPU time over download size. Keep the
                    # released archive's default streaming/compression behavior unchanged.
                    output.writestr(entry, path.read_bytes(), compresslevel=1)
                    continue
                with path.open("rb") as stream, output.open(entry, "w") as target:
                    shutil.copyfileobj(stream, target)
    else:
        with destination.open("xb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0, compresslevel=1 if fast else 9) as gz:
            with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as output:
                for path in paths:
                    # Omit directory entries; installers create parent directories themselves.
                    if path.is_dir():
                        continue
                    entry = output.gettarinfo(os.fspath(path), path.relative_to(source).as_posix())
                    entry.uid = entry.gid = 0
                    entry.uname = entry.gname = ""
                    entry.mtime = 0
                    entry.mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
                    with path.open("rb") as stream:
                        output.addfile(entry, stream)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--fast", action="store_true", help="Low compression for synthetic test fixtures")
    args = parser.parse_args()
    archive(args.source, args.destination, args.fast)
