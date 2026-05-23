"""
Tax rate configuration — CRUD for GST rates used on items and invoices.
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import Item, Organisation, TaxRate
from src.security import require_perm
from src.tax_calc import VALID_TAX_PRICING_MODES, normalize_tax_pricing_mode

router = APIRouter()


class TaxRateCreate(BaseModel):
    rate: float = Field(ge=0, le=100)
    label: str = Field(min_length=1, max_length=80)
    examples: str = ""


class TaxRateUpdate(BaseModel):
    rate: Optional[float] = Field(default=None, ge=0, le=100)
    label: Optional[str] = Field(default=None, min_length=1, max_length=80)
    examples: Optional[str] = None
    active: Optional[bool] = None


class TaxSettingsUpdate(BaseModel):
    tax_pricing_mode: str


async def _get_organisation(db: AsyncSession) -> Organisation:
    org = (await db.execute(select(Organisation).limit(1))).scalar_one_or_none()
    if not org:
        raise HTTPException(404, "Organisation not configured")
    return org


def _serialize(t: TaxRate) -> dict:
    return {
        "id": t.id,
        "rate": t.rate,
        "label": t.label,
        "examples": t.examples or "",
        "active": bool(t.active),
        "is_system": bool(t.is_system),
    }


async def _item_count_for_rate(db: AsyncSession, rate: float) -> int:
    return (await db.execute(
        select(func.count(Item.id)).where(Item.tax_rate == rate)
    )).scalar() or 0


@router.get("/")
async def list_tax_rates(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(TaxRate).order_by(TaxRate.rate.asc(), TaxRate.label.asc())
    )).scalars().all()
    return [_serialize(t) for t in rows]


@router.get("/settings")
async def get_tax_settings(db: AsyncSession = Depends(get_db)):
    org = await _get_organisation(db)
    mode = normalize_tax_pricing_mode(org.tax_pricing_mode)
    return {
        "tax_pricing_mode": mode,
        "tax_pricing_label": "Tax inclusive" if mode == "inclusive" else "Tax exclusive",
    }


@router.patch("/settings", dependencies=[Depends(require_perm("settings.edit"))])
async def update_tax_settings(
    data: TaxSettingsUpdate,
    db: AsyncSession = Depends(get_db),
):
    mode = data.tax_pricing_mode.strip().lower()
    if mode not in VALID_TAX_PRICING_MODES:
        raise HTTPException(400, "tax_pricing_mode must be 'inclusive' or 'exclusive'")
    org = await _get_organisation(db)
    org.tax_pricing_mode = mode
    await db.commit()
    return {
        "tax_pricing_mode": mode,
        "tax_pricing_label": "Tax inclusive" if mode == "inclusive" else "Tax exclusive",
    }


@router.get("/{tax_id}")
async def get_tax_rate(tax_id: str, db: AsyncSession = Depends(get_db)):
    tax = (await db.execute(select(TaxRate).where(TaxRate.id == tax_id))).scalar_one_or_none()
    if not tax:
        raise HTTPException(404, "Tax rate not found")
    return _serialize(tax)


@router.post("/", status_code=201, dependencies=[Depends(require_perm("settings.edit"))])
async def create_tax_rate(data: TaxRateCreate, db: AsyncSession = Depends(get_db)):
    existing = (await db.execute(
        select(TaxRate).where(TaxRate.rate == data.rate, TaxRate.active == True)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(409, f"A tax rate of {data.rate}% already exists")
    tax = TaxRate(
        id=f"tax-{uuid.uuid4().hex[:8]}",
        rate=data.rate,
        label=data.label.strip(),
        examples=(data.examples or "").strip(),
        active=True,
        is_system=False,
    )
    db.add(tax)
    await db.commit()
    await db.refresh(tax)
    return _serialize(tax)


@router.put("/{tax_id}", dependencies=[Depends(require_perm("settings.edit"))])
async def update_tax_rate(tax_id: str, data: TaxRateUpdate, db: AsyncSession = Depends(get_db)):
    tax = (await db.execute(select(TaxRate).where(TaxRate.id == tax_id))).scalar_one_or_none()
    if not tax:
        raise HTTPException(404, "Tax rate not found")
    new_rate = data.rate if data.rate is not None else tax.rate
    if data.rate is not None and data.rate != tax.rate and tax.is_system:
        raise HTTPException(400, "Default tax rates cannot change their percentage")
    if data.rate is not None and data.rate != tax.rate:
        clash = (await db.execute(
            select(TaxRate).where(
                TaxRate.rate == new_rate,
                TaxRate.active == True,
                TaxRate.id != tax_id,
            )
        )).scalar_one_or_none()
        if clash:
            raise HTTPException(409, f"A tax rate of {new_rate}% already exists")
        in_use = await _item_count_for_rate(db, tax.rate)
        if in_use > 0:
            raise HTTPException(
                409,
                f"Cannot change rate — {in_use} item(s) use {tax.rate}%. "
                "Create a new rate instead.",
            )
        tax.rate = new_rate
    if data.label is not None:
        tax.label = data.label.strip()
    if data.examples is not None:
        tax.examples = data.examples.strip()
    if data.active is not None and not tax.is_system:
        tax.active = data.active
    await db.commit()
    await db.refresh(tax)
    return _serialize(tax)


@router.delete("/{tax_id}", dependencies=[Depends(require_perm("settings.edit"))])
async def delete_tax_rate(tax_id: str, db: AsyncSession = Depends(get_db)):
    tax = (await db.execute(select(TaxRate).where(TaxRate.id == tax_id))).scalar_one_or_none()
    if not tax:
        raise HTTPException(404, "Tax rate not found")
    if tax.is_system:
        raise HTTPException(400, "Default tax rates cannot be deleted")
    in_use = await _item_count_for_rate(db, tax.rate)
    if in_use > 0:
        raise HTTPException(
            409,
            f"Tax rate is used by {in_use} item(s). Reassign those items first.",
        )
    await db.delete(tax)
    await db.commit()
    return {"message": "Tax rate deleted"}
