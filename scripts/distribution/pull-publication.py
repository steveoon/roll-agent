"""Download one immutable Actions artifact on the distribution host. Input is a private ticket."""
import hashlib
import http.client
import json
import os
import re
import shutil
import ssl
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def download(ticket, archive):
    expected = ticket["size"]
    digest = hashlib.sha256()
    received = 0
    start = last_report = time.monotonic()
    print(f"[deploy] Downloading {expected} bytes", flush=True)
    try:
        trust = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE"))
        opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=trust))
        with opener.open(ticket["url"], timeout=30) as response:
            if response.status != 200:
                raise ValueError("Expected a complete HTTP response")
            while True:
                chunk = response.read1(512 * 1024)
                if not chunk:
                    break
                received += len(chunk)
                if received > expected:
                    raise ValueError("Artifact exceeds its recorded size")
                archive.write(chunk)
                digest.update(chunk)
                now = time.monotonic()
                if now - last_report >= 10 or received == expected:
                    rate = received / max(now - start, 0.001) / (1024 * 1024)
                    print(f"[deploy] Received {received}/{expected} bytes ({rate:.2f} MiB/s)", flush=True)
                    last_report = now
    except urllib.error.HTTPError as err:
        print(f"[deploy] Storage HTTP {err.code} after {received}/{expected} bytes", file=sys.stderr)
        return 75 if err.code in (401, 403, 408, 429) or err.code >= 500 else 1
    except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException) as err:
        reason = getattr(err, "reason", err)
        print(f"[deploy] {type(reason).__name__} after {received}/{expected} bytes", file=sys.stderr)
        if isinstance(reason, ssl.SSLCertVerificationError):
            print(f"[deploy] TLS verification failed: {reason.verify_message}", file=sys.stderr)
            return 1
        return 75
    if received < expected:
        print(f"[deploy] Short download: {received}/{expected} bytes", file=sys.stderr)
        return 75
    if digest.hexdigest() != ticket["sha256"]:
        raise ValueError("GitHub artifact SHA-256 mismatch")
    archive.seek(0)
    return 0


def unpack(archive, stage, version, size):
    names = {"CHECKSUMS.sha256", "install.sh", "install.ps1", "manifest.json"}
    for platform in ("darwin", "linux", "win32"):
        for arch in ("arm64", "x64"):
            target = f"{platform}-{arch}"
            ext = "zip" if platform == "win32" else "tar.gz"
            names.update((f"{target}.txt", f"roll-{version}-{target}.{ext}"))
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) != len(names) or set(bundle.namelist()) != names:
            raise ValueError("Unexpected publication ZIP members")
        # Assembly stores already compressed native archives at compression level zero.
        if sum(entry.file_size for entry in entries) > size:
            raise ValueError("Unexpected expanded publication size")
        for entry in entries:
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if kind not in (0, stat.S_IFREG):
                raise ValueError("Expected regular publication files")
        for entry in entries:
            with bundle.open(entry) as source, (stage / entry.filename).open("xb") as output:
                shutil.copyfileobj(source, output)
    if json.loads((stage / "manifest.json").read_bytes())["version"] != version:
        raise ValueError("Publication manifest version mismatch")


def main():
    stage, version = Path(sys.argv[1]), sys.argv[2]
    ticket = json.load(sys.stdin)
    if (not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version)
            or not re.fullmatch(r"[0-9a-f]{64}", ticket["sha256"])
            or type(ticket["size"]) is not int or ticket["size"] < 1
            or urllib.parse.urlsplit(ticket["url"]).scheme != "https"):
        raise ValueError("Invalid publication ticket or version")
    os.umask(0o022)
    with tempfile.TemporaryFile(dir=stage) as archive:
        status = download(ticket, archive)
        if status:
            return status
        unpack(archive, stage, version, ticket["size"])
    print("[deploy] GitHub artifact SHA-256 verified and publication extracted", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
