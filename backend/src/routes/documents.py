from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from src.security import current_user, require_perm

router = APIRouter()


class PdfRenderRequest(BaseModel):
    html: str = Field(..., min_length=1)
    file_name: str = Field(default="Tax_Invoice.pdf", max_length=160)


def _safe_pdf_filename(value: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_.-]+", "_", value or "Tax_Invoice.pdf").strip("._")
    if not name:
        name = "Tax_Invoice.pdf"
    if not name.lower().endswith(".pdf"):
        name = f"{name}.pdf"
    return name


def _with_base_href(html: str, base_url: str) -> str:
    base_tag = f'<base href="{base_url.rstrip("/")}/">'
    if "<head>" in html:
        return html.replace("<head>", f"<head>{base_tag}", 1)
    return f"<!doctype html><html><head>{base_tag}</head><body>{html}</body></html>"


@router.post(
    "/invoice-pdf",
    dependencies=[Depends(require_perm("sales.view", "reports.view"))],
)
async def render_invoice_pdf(
    payload: PdfRenderRequest,
    request: Request,
    _user=Depends(current_user),
):
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="PDF export renderer is not installed. Install Playwright and its Chromium browser.",
        ) from exc

    browser = None
    try:
        html = _with_base_href(payload.html, str(request.base_url))
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(args=["--no-sandbox"])
            page = await browser.new_page(viewport={"width": 794, "height": 1123})
            await page.emulate_media(media="print")
            await page.set_content(html, wait_until="networkidle")
            await page.evaluate("document.fonts && document.fonts.ready")
            pdf = await page.pdf(
                format="A4",
                print_background=True,
                prefer_css_page_size=True,
                margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not render invoice PDF: {exc}") from exc
    finally:
        if browser is not None:
            await browser.close()

    filename = _safe_pdf_filename(payload.file_name)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
