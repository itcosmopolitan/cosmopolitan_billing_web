import asyncio
import re
import stat
from typing import Optional

import pytest
from httpx import AsyncClient

from src import config, pdf_renderer
from src.main import app
from src.pdf_renderer import (
    PAGE_PRESETS,
    PdfMode,
    PdfRendererUnavailable,
    PdfRenderTimeout,
    build_command,
    render_pdf,
    sanitize_html,
)
from src.routes import documents

ROUTE_PATH = "/api/v1/documents/invoice-pdf"
SAMPLE_HTML = "<html><body><p>Hello</p></body></html>"
FAKE_PDF = b"%PDF-1.4\n%fake\n"


def _post(body: dict, headers: Optional[dict] = None):
    async def _run():
        async with AsyncClient(app=app, base_url="http://test") as client:
            return await client.post(ROUTE_PATH, json=body, headers=headers or {})

    return asyncio.run(_run())


@pytest.fixture
def bypass_auth():
    route = next(r for r in app.routes if getattr(r, "path", None) == ROUTE_PATH)
    overrides = {dep.dependency: (lambda: None) for dep in route.dependencies}
    overrides[documents.current_user] = lambda: None
    app.dependency_overrides.update(overrides)
    yield
    for key in overrides:
        app.dependency_overrides.pop(key, None)


@pytest.fixture
def capture_render(monkeypatch):
    calls = []

    async def fake_render(html, mode):
        calls.append({"html": html, "mode": mode})
        return FAKE_PDF

    monkeypatch.setattr(documents, "render_pdf", fake_render)
    return calls


def _write_fake_binary(tmp_path, script: str):
    path = tmp_path / "fake-wkhtmltopdf"
    path.write_text(f"#!/bin/sh\n{script}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def _media_box(pdf: bytes):
    match = re.search(rb"/MediaBox\s*\[\s*([\d.\s-]+?)\s*\]", pdf)
    assert match, "PDF has no MediaBox"
    x0, y0, x1, y1 = (float(v) for v in match.group(1).split())
    return x1 - x0, y1 - y0


def test_page_presets_define_print_a5_and_export_a4():
    assert PAGE_PRESETS == {
        "print": {"size": "A5", "margin_mm": 8},
        "export": {"size": "A4", "margin_mm": 12},
    }


def test_build_command_uses_preset_flags_and_argument_list():
    command = build_command(PdfMode.PRINT)
    assert all(isinstance(part, str) for part in command)
    for flag in (
        "--quiet",
        "--encoding",
        "--print-media-type",
        "--disable-javascript",
        "--disable-local-file-access",
        "--disable-smart-shrinking",
    ):
        assert flag in command
    assert command[command.index("--page-size") + 1] == "A5"
    for side in ("top", "right", "bottom", "left"):
        assert command[command.index(f"--margin-{side}") + 1] == "8mm"
    assert command[-2:] == ["-", "-"]

    export = build_command(PdfMode.EXPORT)
    assert export[export.index("--page-size") + 1] == "A4"
    assert export[export.index("--margin-left") + 1] == "12mm"


def test_sanitize_html_strips_scripts_and_event_handlers():
    dirty = (
        '<html><head><script>alert(1)</script></head>'
        '<body onload="steal()"><img src="https://evil.example/x.png" onerror="bad()">'
        '<a href="javascript:bad()">x</a><p>Keep me</p></body></html>'
    )
    cleaned = sanitize_html(dirty)
    assert "<script" not in cleaned.lower()
    assert "alert(1)" not in cleaned
    assert "onload" not in cleaned.lower()
    assert "onerror" not in cleaned.lower()
    assert "javascript:" not in cleaned.lower()
    assert "evil.example" not in cleaned
    assert "<p>Keep me</p>" in cleaned


def test_sanitize_html_keeps_inline_data_images():
    html = '<img src="data:image/png;base64,AAAA" alt="logo">'
    assert 'src="data:image/png;base64,AAAA"' in sanitize_html(html)


def test_render_pdf_reports_missing_binary(monkeypatch):
    monkeypatch.setattr(config.get(), "wkhtmltopdf_binary", "/nonexistent/wkhtmltopdf")
    with pytest.raises(PdfRendererUnavailable):
        asyncio.run(render_pdf(SAMPLE_HTML, PdfMode.EXPORT))


def test_render_pdf_times_out_and_kills_process(monkeypatch, tmp_path):
    binary = _write_fake_binary(tmp_path, "sleep 10")
    monkeypatch.setattr(config.get(), "wkhtmltopdf_binary", binary)
    monkeypatch.setattr(config.get(), "pdf_timeout_seconds", 0.5)
    with pytest.raises(PdfRenderTimeout):
        asyncio.run(render_pdf(SAMPLE_HTML, PdfMode.PRINT))


def test_route_returns_pdf_with_attachment_header(bypass_auth, capture_render):
    response = _post({"html": SAMPLE_HTML, "file_name": "Tax Invoice 1/2.pdf", "mode": "print"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"].startswith("attachment; filename=")
    assert response.content.startswith(b"%PDF")
    assert capture_render[0]["mode"] is PdfMode.PRINT


def test_route_defaults_to_export_mode(bypass_auth, capture_render):
    response = _post({"html": SAMPLE_HTML})
    assert response.status_code == 200
    assert capture_render[0]["mode"] is PdfMode.EXPORT


def test_route_rejects_unknown_mode(bypass_auth, capture_render):
    response = _post({"html": SAMPLE_HTML, "mode": "letter"})
    assert response.status_code == 422
    assert capture_render == []


def test_route_ignores_client_size_and_margin_overrides(bypass_auth, capture_render):
    response = _post({
        "html": SAMPLE_HTML,
        "mode": "print",
        "page_size": "Letter",
        "margin_mm": 0,
        "size": "A3",
    })
    assert response.status_code == 200
    command = build_command(capture_render[0]["mode"])
    assert command[command.index("--page-size") + 1] == "A5"
    assert command[command.index("--margin-top") + 1] == "8mm"


def test_route_strips_scripts_before_rendering(bypass_auth, capture_render):
    html = '<html><body onload="x()"><script>evil()</script><p>Total</p></body></html>'
    response = _post({"html": html, "mode": "export"})
    assert response.status_code == 200
    rendered = capture_render[0]["html"]
    assert "evil()" not in rendered
    assert "onload" not in rendered.lower()
    assert "<p>Total</p>" in rendered


def test_route_rejects_oversized_payload_with_413(bypass_auth, capture_render, monkeypatch):
    monkeypatch.setattr(config.get(), "pdf_max_payload_bytes", 1024)
    response = _post({"html": "<p>" + "x" * 4096 + "</p>", "mode": "export"})
    assert response.status_code == 413
    assert capture_render == []


def test_route_maps_render_timeout_to_504(bypass_auth, monkeypatch):
    async def timeout_render(html, mode):
        raise PdfRenderTimeout("PDF rendering timed out.")

    monkeypatch.setattr(documents, "render_pdf", timeout_render)
    response = _post({"html": SAMPLE_HTML, "mode": "export"})
    assert response.status_code == 504


def test_route_maps_missing_binary_to_503(bypass_auth, monkeypatch):
    async def unavailable_render(html, mode):
        raise PdfRendererUnavailable("PDF renderer is not installed on the server.")

    monkeypatch.setattr(documents, "render_pdf", unavailable_render)
    response = _post({"html": SAMPLE_HTML, "mode": "export"})
    assert response.status_code == 503


@pytest.mark.skipif(not pdf_renderer.is_binary_available(), reason="wkhtmltopdf is not installed")
@pytest.mark.parametrize(
    ("mode", "expected"),
    [
        (PdfMode.PRINT, (419.5, 595.3)),
        (PdfMode.EXPORT, (595.3, 841.9)),
    ],
)
def test_real_render_page_sizes(mode, expected):
    pdf = asyncio.run(render_pdf(SAMPLE_HTML, mode))
    assert pdf.startswith(b"%PDF")
    width, height = _media_box(pdf)
    assert abs(width - expected[0]) < 1.5
    assert abs(height - expected[1]) < 1.5
