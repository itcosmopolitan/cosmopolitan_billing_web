from __future__ import annotations

import json
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from src import config
from src.pdf_renderer import PdfMode, PdfRenderError, render_pdf, sanitize_html
from src.security import current_user, require_perm

router = APIRouter()


class PdfRenderRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    html: str = Field(..., min_length=1)
    file_name: str = Field(default="Tax_Invoice.pdf", max_length=160)
    mode: PdfMode = PdfMode.EXPORT


def _safe_pdf_filename(value: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_.-]+", "_", value or "Tax_Invoice.pdf").strip("._")
    if not name:
        name = "Tax_Invoice.pdf"
    if not name.lower().endswith(".pdf"):
        name = f"{name}.pdf"
    return name


async def _read_limited_body(request: Request, max_bytes: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes:
        raise HTTPException(status_code=413, detail=_too_large_detail(max_bytes))

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(status_code=413, detail=_too_large_detail(max_bytes))
        chunks.append(chunk)
    return b"".join(chunks)


def _too_large_detail(max_bytes: int) -> str:
    return f"PDF request exceeds the {max_bytes // (1024 * 1024)} MB limit."


@router.post(
    "/invoice-pdf",
    dependencies=[Depends(require_perm("sales.view", "reports.view"))],
)
async def render_invoice_pdf(
    request: Request,
    _user=Depends(current_user),
):
    raw = await _read_limited_body(request, config.get().pdf_max_payload_bytes)
    try:
        payload = PdfRenderRequest.model_validate(json.loads(raw or b"{}"))
    except (ValueError, ValidationError) as exc:
        raise HTTPException(status_code=422, detail="Invalid PDF request body.") from exc

    html = sanitize_html(payload.html)
    try:
        pdf = await render_pdf(html, payload.mode)
    except PdfRenderError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    filename = _safe_pdf_filename(payload.file_name)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
