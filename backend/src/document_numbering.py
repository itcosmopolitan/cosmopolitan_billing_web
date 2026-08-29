"""
Document numbering — format templates, counters, and allocation.

Format placeholders:
  PREFIX — configured prefix string
  BRANCH — branch short code (per-branch scope; omitted when centralised / unknown)
  YYYY   — 4-digit year
  MM     — 2-digit month
  DD     — 2-digit day
  ####   — sequence padded to the number of `#` characters (e.g. #### → 4 digits)
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from sqlalchemy import func, select, text
from types import SimpleNamespace
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import Branch, CustomerPayment, DocumentNumberCounter, DocumentNumbering, SaleInvoice

_SEQ_TOKEN = re.compile(r"(#+)")
_BRANCH_CLEAN = re.compile(r"-{2,}")

# Both render into SaleInvoice.number — skip collisions for either doc type.
_SALE_INVOICE_DOC_TYPES = frozenset({"sales_invoice", "pos_receipt"})
_MAX_NUMBER_SCAN = 10_000

DEFAULT_NUMBERING: list[dict[str, Any]] = [
    {
        "doc_type": "sales_invoice",
        "label": "Sales Invoice",
        "prefix": "INV",
        "format": "INV-BRANCH-YYYY-####",
        "scope": "per_branch",
        "next_seq": 1848,
    },
    {
        "doc_type": "purchase_bill",
        "label": "Purchase Bill",
        "prefix": "PUR",
        "format": "PUR-YYYY-####",
        "scope": "centralised",
        "next_seq": 413,
    },
    {
        "doc_type": "pos_receipt",
        "label": "POS Receipt",
        "prefix": "POS",
        "format": "POS-BRANCH-YYYY-####",
        "scope": "per_branch",
        "next_seq": 1849,
    },
    {
        "doc_type": "stock_transfer",
        "label": "Stock Transfer",
        "prefix": "TRF",
        "format": "TRF-YYYY-###",
        "scope": "centralised",
        "next_seq": 42,
    },
    {
        "doc_type": "stock_adjustment",
        "label": "Stock Adjustment",
        "prefix": "ADJ",
        "format": "ADJ-BRANCH-YYYY-####",
        "scope": "per_branch",
        "next_seq": 41,
    },
    {
        "doc_type": "credit_note",
        "label": "Credit Note",
        "prefix": "CN",
        "format": "CN-BRANCH-YYYY-####",
        "scope": "per_branch",
        "next_seq": 13,
    },
    {
        "doc_type": "quotation",
        "label": "Quotation",
        "prefix": "QT",
        "format": "QT-BRANCH-YYYY-####",
        "scope": "per_branch",
        "next_seq": 89,
    },
]


def _counter_key(doc_type: str, scope: str, branch_id: str | None) -> str:
    if scope == "centralised":
        return f"{doc_type}:central"
    if not branch_id:
        raise ValueError("branch_id is required for per_branch numbering")
    return f"{doc_type}:{branch_id}"


def ensure_branch_in_format(format_str: str) -> str:
    """Insert BRANCH after the first segment (CN-YYYY-#### → CN-BRANCH-YYYY-####)."""
    fmt = (format_str or "").strip()
    if not fmt or "BRANCH" in fmt:
        return fmt
    dash = fmt.find("-")
    if dash == -1:
        return f"{fmt}-BRANCH"
    return f"{fmt[:dash]}-BRANCH{fmt[dash:]}"


def _apply_branch_token(format_str: str, branch_code: str | None) -> str:
    """Substitute BRANCH, or strip the token cleanly when no code is available."""
    out = format_str or ""
    if "BRANCH" not in out:
        return out
    code = (branch_code or "").strip().upper()
    if code:
        return out.replace("BRANCH", code)
    # Drop token + tidy doubled separators (CN--YYYY → CN-YYYY).
    out = out.replace("-BRANCH-", "-").replace("BRANCH-", "").replace("-BRANCH", "")
    out = out.replace("BRANCH", "")
    out = _BRANCH_CLEAN.sub("-", out)
    return out.strip("-")


def render_number(
    *,
    prefix: str,
    format_str: str,
    seq: int,
    when: datetime | None = None,
    branch_code: str | None = None,
) -> str:
    """Render a document number from a template and sequence value."""
    dt = when or datetime.utcnow()
    out = (format_str or "").replace("PREFIX", prefix or "")
    out = _apply_branch_token(out, branch_code)
    out = out.replace("YYYY", f"{dt.year:04d}")
    out = out.replace("MM", f"{dt.month:02d}").replace("DD", f"{dt.day:02d}")
    match = _SEQ_TOKEN.search(out)
    if not match:
        return out
    pad = len(match.group(1))
    return out[: match.start()] + str(seq).zfill(pad) + out[match.end() :]


def preview_sample(
    cfg: dict[str, Any],
    seq: int | None = None,
    *,
    branch_code: str | None = "TN",
) -> str:
    seq_val = seq if seq is not None else int(cfg.get("next_seq") or 1)
    scope = cfg.get("scope") or "per_branch"
    code = branch_code if scope == "per_branch" else None
    return render_number(
        prefix=cfg.get("prefix") or "",
        format_str=cfg.get("format") or "PREFIX-YYYY-####",
        seq=seq_val,
        branch_code=code,
    )


def serialize_numbering(
    row: DocumentNumbering,
    next_seq: int,
    *,
    sample_branch_code: str | None = "TN",
) -> dict[str, Any]:
    base = {
        "doc_type": row.doc_type,
        "label": row.label,
        "prefix": row.prefix,
        "format": row.format,
        "scope": row.scope,
        "next_seq": next_seq,
    }
    base["sample"] = preview_sample(base, next_seq, branch_code=sample_branch_code)
    return base


async def get_config(db: AsyncSession, doc_type: str) -> DocumentNumbering | None:
    return (
        await db.execute(
            select(DocumentNumbering).where(DocumentNumbering.doc_type == doc_type)
        )
    ).scalar_one_or_none()


async def resolve_branch_code(db: AsyncSession, branch_id: str | None) -> str | None:
    if not branch_id:
        return None
    row = (
        await db.execute(select(Branch).where(Branch.id == branch_id))
    ).scalar_one_or_none()
    if not row:
        return None
    code = (row.code or "").strip().upper()
    return code or None


async def _sale_number_taken(db: AsyncSession, number: str) -> bool:
    cnt = (
        await db.execute(
            select(func.count())
            .select_from(SaleInvoice)
            .where(SaleInvoice.number == number)
        )
    ).scalar() or 0
    return int(cnt) > 0


async def get_counter_seq(
    db: AsyncSession, doc_type: str, scope: str, branch_id: str | None
) -> int:
    if scope == "per_branch" and not branch_id:
        cfg = await get_config(db, doc_type)
        return int(cfg.next_seq or 1) if cfg else 1
    key = _counter_key(doc_type, scope, branch_id)
    row = (
        await db.execute(
            select(DocumentNumberCounter).where(DocumentNumberCounter.id == key)
        )
    ).scalar_one_or_none()
    if row:
        return int(row.next_seq or 1)
    cfg = await get_config(db, doc_type)
    return int(cfg.next_seq or 1) if cfg else 1


async def allocate_number(
    db: AsyncSession,
    doc_type: str,
    *,
    branch_id: str | None = None,
    when: datetime | None = None,
) -> str:
    """Reserve and return the next document number for *doc_type*."""
    cfg = await get_config(db, doc_type)
    if not cfg:
        # Use in-code defaults when DB-backed numbering isn't configured
        default = next((c for c in DEFAULT_NUMBERING if c["doc_type"] == doc_type), None)
        if not default:
            year = (when or datetime.utcnow()).year
            return f"{doc_type.upper()}-{year}-0001"
        cfg = SimpleNamespace(**default)

    scope = cfg.scope or "per_branch"
    key = _counter_key(doc_type, scope, branch_id)
    counter = (
        await db.execute(
            select(DocumentNumberCounter)
            .where(DocumentNumberCounter.id == key)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if not counter:
        counter = DocumentNumberCounter(
            id=key,
            doc_type=doc_type,
            branch_id=None if scope == "centralised" else (branch_id or ""),
            next_seq=int(cfg.next_seq or 1),
        )
        db.add(counter)
        await db.flush()

    branch_code = await resolve_branch_code(db, branch_id) if scope == "per_branch" else None

    for _ in range(_MAX_NUMBER_SCAN):
        seq = int(counter.next_seq or 1)
        number = render_number(
            prefix=cfg.prefix or "",
            format_str=cfg.format or "PREFIX-YYYY-####",
            seq=seq,
            when=when,
            branch_code=branch_code,
        )
        if doc_type in _SALE_INVOICE_DOC_TYPES and await _sale_number_taken(db, number):
            counter.next_seq = seq + 1
            continue
        counter.next_seq = seq + 1
        await db.flush()
        return number

    raise ValueError(f"Could not allocate a free number for {doc_type}")


async def allocate_customer_payment_number(
    db: AsyncSession,
    *,
    when: datetime | None = None,
) -> str:
    """Allocate a unique customer payment number without count-based reuse."""
    if db.bind and db.bind.dialect.name == "postgresql":
        await db.execute(text("SELECT pg_advisory_xact_lock(742019)"))

    key = "customer_payment:central"
    counter = (
        await db.execute(
            select(DocumentNumberCounter)
            .where(DocumentNumberCounter.id == key)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if not counter:
        numbers = (
            await db.execute(select(CustomerPayment.number))
        ).scalars().all()
        max_seq = 999
        for number in numbers:
            match = re.fullmatch(r"PAY-\d{4}-(\d+)", number or "")
            if match:
                max_seq = max(max_seq, int(match.group(1)))
        counter = DocumentNumberCounter(
            id=key,
            doc_type="customer_payment",
            branch_id=None,
            next_seq=max_seq + 1,
        )
        db.add(counter)
        await db.flush()

    sequence = int(counter.next_seq or 1000)
    counter.next_seq = sequence + 1
    await db.flush()
    year = (when or datetime.utcnow()).year
    return f"PAY-{year}-{sequence:04d}"


async def peek_next_number(
    db: AsyncSession,
    doc_type: str,
    *,
    branch_id: str | None = None,
    when: datetime | None = None,
) -> str:
    """Render the next free number without reserving it (for form previews)."""
    cfg = await get_config(db, doc_type)
    if not cfg:
        year = (when or datetime.utcnow()).year
        return f"{doc_type.upper()}-{year}-0001"

    scope = cfg.scope or "per_branch"
    seq = await get_counter_seq(db, doc_type, scope, branch_id)
    prefix = cfg.prefix or ""
    format_str = cfg.format or "PREFIX-YYYY-####"
    branch_code = await resolve_branch_code(db, branch_id) if scope == "per_branch" else None

    for _ in range(_MAX_NUMBER_SCAN):
        number = render_number(
            prefix=prefix,
            format_str=format_str,
            seq=seq,
            when=when,
            branch_code=branch_code,
        )
        if doc_type in _SALE_INVOICE_DOC_TYPES and await _sale_number_taken(db, number):
            seq += 1
            continue
        return number

    return render_number(
        prefix=prefix,
        format_str=format_str,
        seq=seq,
        when=when,
        branch_code=branch_code,
    )


async def resolve_number(
    db: AsyncSession,
    *,
    requested: str | None,
    model,
    allocate,
) -> str:
    """Use *requested* when provided (unique check), else call *allocate*()."""
    from fastapi import HTTPException

    if requested and str(requested).strip():
        num = str(requested).strip()
        cnt = (
            await db.execute(
                select(func.count()).select_from(model).where(model.number == num)
            )
        ).scalar() or 0
        if cnt:
            raise HTTPException(400, f"Document number '{num}' is already in use")
        return num
    return await allocate()
