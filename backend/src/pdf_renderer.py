"""Server-side PDF rendering with wkhtmltopdf.

HTML is piped to wkhtmltopdf on stdin and the PDF is read from stdout, so no
temporary files are written. Page size and margins come only from
PAGE_PRESETS; callers choose a mode, never a size or margin.
"""
from __future__ import annotations

import asyncio
import logging
import re
import shutil
from asyncio.subprocess import PIPE
from enum import Enum

from src import config

logger = logging.getLogger("cosmopolitan.pdf")

PAGE_PRESETS = {
    "print": {"size": "A5", "margin_mm": 8},
    "export": {"size": "A4", "margin_mm": 12},
}

PDF_MAGIC = b"%PDF"


class PdfMode(str, Enum):
    PRINT = "print"
    EXPORT = "export"


class PdfRenderError(Exception):
    status_code = 500

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


class PdfRendererUnavailable(PdfRenderError):
    status_code = 503


class PdfRenderTimeout(PdfRenderError):
    status_code = 504


class PdfRenderFailed(PdfRenderError):
    status_code = 500


def binary_path() -> str:
    return config.get().wkhtmltopdf_binary


def is_binary_available() -> bool:
    return shutil.which(binary_path()) is not None


def build_command(mode: PdfMode) -> list[str]:
    preset = PAGE_PRESETS[mode.value]
    margin = f"{preset['margin_mm']}mm"
    return [
        binary_path(),
        "--quiet",
        "--encoding", "utf-8",
        "--print-media-type",
        "--disable-javascript",
        "--disable-local-file-access",
        "--disable-smart-shrinking",
        "--load-error-handling", "ignore",
        "--load-media-error-handling", "ignore",
        "--page-size", preset["size"],
        "--margin-top", margin,
        "--margin-right", margin,
        "--margin-bottom", margin,
        "--margin-left", margin,
        "-",
        "-",
    ]


_TAG_RE = re.compile(r"<[a-zA-Z][^>]*>")
_SCRIPT_RE = re.compile(r"<script\b[^>]*>.*?</script\s*>|<script\b[^>]*>|</script\s*>", re.IGNORECASE | re.DOTALL)
_ACTIVE_ELEMENT_RE = re.compile(
    r"<(iframe|object|embed|applet|frameset|frame)\b[^>]*>(?:.*?</\1\s*>)?",
    re.IGNORECASE | re.DOTALL,
)
_HEAD_ONLY_RE = re.compile(r"<(base|link|meta)\b[^>]*>", re.IGNORECASE)
_EVENT_ATTR_RE = re.compile(r"\s+on[a-zA-Z]+\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)", re.IGNORECASE)
_SCRIPT_URL_RE = re.compile(r"(?:javascript|vbscript)\s*:", re.IGNORECASE)
_URL_ATTR_RE = re.compile(
    r"\s+(src|srcset|poster|background|xlink:href|href)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)",
    re.IGNORECASE,
)
_CSS_URL_RE = re.compile(r"url\(\s*(['\"]?)(?!data:)(.*?)\1\s*\)", re.IGNORECASE)
_CSS_IMPORT_RE = re.compile(r"@import[^;]*;", re.IGNORECASE)


def _clean_url_attr(tag_name: str, match: re.Match) -> str:
    attr = match.group(1).lower()
    value = match.group(2).strip("\"'")
    if attr == "href" and tag_name.lower() == "a":
        return match.group(0)
    if value.startswith("data:") or value.startswith("#"):
        return match.group(0)
    return ""


def _clean_tag(match: re.Match) -> str:
    tag = match.group(0)
    tag_name = re.match(r"<([a-zA-Z][a-zA-Z0-9-]*)", tag).group(1)
    tag = _EVENT_ATTR_RE.sub("", tag)
    tag = _SCRIPT_URL_RE.sub("blocked:", tag)
    return _URL_ATTR_RE.sub(lambda m: _clean_url_attr(tag_name, m), tag)


def sanitize_html(html: str) -> str:
    """Remove active content and external references before rendering.

    wkhtmltopdf runs with JavaScript and local file access disabled; this is
    defence in depth against script injection and server-side file or network
    reads through embedded resources.
    """
    cleaned = _SCRIPT_RE.sub("", html)
    cleaned = _ACTIVE_ELEMENT_RE.sub("", cleaned)
    cleaned = _HEAD_ONLY_RE.sub("", cleaned)
    cleaned = _TAG_RE.sub(_clean_tag, cleaned)
    cleaned = _CSS_IMPORT_RE.sub("", cleaned)
    cleaned = _CSS_URL_RE.sub("none", cleaned)
    return cleaned


_slots: tuple[asyncio.AbstractEventLoop, asyncio.Semaphore] | None = None


def _render_slots() -> asyncio.Semaphore:
    # A semaphore is bound to the loop that first uses it, so rebuild it for a new loop.
    global _slots
    loop = asyncio.get_running_loop()
    if _slots is None or _slots[0] is not loop:
        _slots = (loop, asyncio.Semaphore(config.get().pdf_max_concurrency))
    return _slots[1]


async def _stop(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is None:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
    await proc.wait()


async def render_pdf(html: str, mode: PdfMode) -> bytes:
    timeout = config.get().pdf_timeout_seconds
    command = build_command(mode)

    async with _render_slots():
        try:
            proc = await asyncio.create_subprocess_exec(*command, stdin=PIPE, stdout=PIPE, stderr=PIPE)
        except FileNotFoundError as exc:
            logger.error("wkhtmltopdf binary not found: %s", command[0])
            raise PdfRendererUnavailable("PDF renderer is not installed on the server.") from exc

        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(html.encode("utf-8")), timeout=timeout)
        except asyncio.TimeoutError as exc:
            await _stop(proc)
            logger.error("wkhtmltopdf timed out after %ss (mode=%s)", timeout, mode.value)
            raise PdfRenderTimeout("PDF rendering timed out.") from exc
        except asyncio.CancelledError:
            await _stop(proc)
            raise

    stderr_text = stderr.decode("utf-8", errors="replace").strip()
    if not stdout.startswith(PDF_MAGIC):
        logger.error(
            "wkhtmltopdf produced no PDF (exit=%s, mode=%s): %s",
            proc.returncode,
            mode.value,
            stderr_text[:4000],
        )
        raise PdfRenderFailed("PDF rendering failed.")
    if proc.returncode != 0:
        logger.warning(
            "wkhtmltopdf exited with %s but produced a PDF (mode=%s): %s",
            proc.returncode,
            mode.value,
            stderr_text[:4000],
        )
    return stdout
