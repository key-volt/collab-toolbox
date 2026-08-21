"""Uploaded files.

The declared content type of an upload is never trusted; the stored type comes from the
bytes themselves, and anything unrecognised is refused.
"""

from pathlib import Path


def sniff_mime(head: bytes) -> str | None:
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "image/webp"
    lead = head.lstrip()[:256].lower()
    if lead.startswith(b"<svg") or (lead.startswith(b"<?xml") and b"<svg" in lead):
        return "image/svg+xml"
    return None


def save_upload(uploads_dir: Path, upload_id: str, content: bytes) -> None:
    uploads_dir.mkdir(parents=True, exist_ok=True)
    (uploads_dir / upload_id).write_bytes(content)


def delete_upload(uploads_dir: Path, upload_id: str) -> None:
    (uploads_dir / upload_id).unlink(missing_ok=True)
