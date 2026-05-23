"""
Settings — document numbering configuration.
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.document_numbering import get_counter_seq, serialize_numbering
from src.models import DocumentNumberCounter, DocumentNumbering
from src.security import require_perm

router = APIRouter()


class NumberingUpdate(BaseModel):
    prefix: Optional[str] = Field(None, min_length=1, max_length=16)
    format: Optional[str] = Field(None, min_length=3, max_length=64)
    scope: Optional[Literal["per_branch", "centralised"]] = None
    next_seq: Optional[int] = Field(None, ge=1, le=9_999_999)


@router.get("/numbering", dependencies=[Depends(require_perm("settings.view"))])
async def list_numbering(db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(select(DocumentNumbering).order_by(DocumentNumbering.label))
    ).scalars().all()
    if not rows:
        return []
    out = []
    for row in rows:
        seq = await get_counter_seq(db, row.doc_type, row.scope or "per_branch", None)
        if row.scope == "centralised":
            out.append(serialize_numbering(row, seq))
        else:
            # Per-branch: show the configured starting / minimum sequence.
            out.append(serialize_numbering(row, int(row.next_seq or 1)))
    return out


@router.put(
    "/numbering/{doc_type}",
    dependencies=[Depends(require_perm("settings.edit"))],
)
async def update_numbering(
    doc_type: str,
    data: NumberingUpdate,
    db: AsyncSession = Depends(get_db),
):
    row = (
        await db.execute(
            select(DocumentNumbering).where(DocumentNumbering.doc_type == doc_type)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Document type not found")

    payload = data.model_dump(exclude_unset=True)
    if "format" in payload and "#" not in payload["format"]:
        raise HTTPException(400, "Format must include a # sequence placeholder (e.g. ####)")
    if "scope" in payload and payload["scope"] not in ("per_branch", "centralised"):
        raise HTTPException(400, "Scope must be per_branch or centralised")

    old_scope = row.scope
    for key, val in payload.items():
        setattr(row, key, val)

    # When next_seq is bumped, reset counters so the new floor takes effect.
    if "next_seq" in payload:
        counters = (
            await db.execute(
                select(DocumentNumberCounter).where(
                    DocumentNumberCounter.doc_type == doc_type
                )
            )
        ).scalars().all()
        for c in counters:
            c.next_seq = int(payload["next_seq"])

    # Scope change clears branch-specific counters so allocation restarts cleanly.
    if "scope" in payload and payload["scope"] != old_scope:
        counters = (
            await db.execute(
                select(DocumentNumberCounter).where(
                    DocumentNumberCounter.doc_type == doc_type
                )
            )
        ).scalars().all()
        for c in counters:
            await db.delete(c)

    await db.commit()
    await db.refresh(row)
    seq = await get_counter_seq(db, row.doc_type, row.scope or "per_branch", None)
    return serialize_numbering(row, seq)
