"""
Tax rate configuration — CRUD for GST rates used on items and invoices.
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import Item, Organisation, TaxRate
from src.pagination import normalize_limit, normalize_skip, paged_list, pagination_from_page, resolve_sort
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
    is_active: Optional[bool] = None


class TaxSettingsUpdate(BaseModel):
    tax_pricing_mode: str


async def _get_organisation(db: AsyncSession) -> Organisation:
    org = (await db.execute(select(Organisation).limit(1))).scalar_one_or_none()
    if not org:
        raise HTTPException(404, "Organisation not configured")
    return org


def _serialize(t: TaxRate) -> dict:
    row = {
        "id": t.id,
        "rate": t.rate,
        "label": t.label,
        "examples": t.examples or "",
        "is_active": bool(t.active),
        "is_system": bool(t.is_system),
    }
    if not t.active:
        row["tax_id"] = t.id
    return row


def _parse_csv_ids(raw: Optional[str]) -> list[str]:
    if not raw:
        return []
    return [part.strip() for part in raw.split(",") if part.strip()]


def _parse_csv_rates(raw: Optional[str]) -> list[float]:
    if not raw:
        return []
    rates: list[float] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            rates.append(float(part))
        except ValueError:
            continue
    return rates


def _active_list_filter(
    active_only: bool,
    include_inactive_tax_ids: Optional[str],
    include_inactive_rates: Optional[str],
):
    """Active taxes, plus optional inactive rows referenced by id or item rate."""
    if not active_only:
        return None
    extra = []
    ids = _parse_csv_ids(include_inactive_tax_ids)
    rates = _parse_csv_rates(include_inactive_rates)
    if ids:
        extra.append(TaxRate.id.in_(ids))
    if rates:
        extra.append((TaxRate.active == False) & (TaxRate.rate.in_(rates)))
    if not extra:
        return TaxRate.active == True
    return or_(TaxRate.active == True, *extra)


async def _item_count_for_rate(db: AsyncSession, rate: float) -> int:
    return (await db.execute(
        select(func.count(Item.id)).where(Item.tax_rate == rate)
    )).scalar() or 0


@router.get("/")
async def list_tax_rates(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    page_no: Optional[int] = Query(None, ge=1),
    per_page: Optional[int] = Query(None, ge=1, le=500),
    skip: Optional[int] = Query(None, ge=0),
    limit: Optional[int] = Query(None, ge=1, le=500),
    active_only: bool = Query(True),
    include_inactive_tax_ids: Optional[str] = Query(
        None,
        description="Comma-separated tax ids to include even when inactive (e.g. item still on that rate)",
    ),
    include_inactive_rates: Optional[str] = Query(
        None,
        description="Comma-separated rates whose inactive tax rows should be included",
    ),
    db: AsyncSession = Depends(get_db),
):
    if page_no is not None or per_page is not None:
        _, pp, sk, lim = pagination_from_page(page_no, per_page)
    else:
        sk = normalize_skip(skip)
        lim = normalize_limit(limit)
    visibility = _active_list_filter(
        active_only, include_inactive_tax_ids, include_inactive_rates,
    )
    count_q = select(func.count(TaxRate.id))
    if visibility is not None:
        count_q = count_q.where(visibility)
    total = int((await db.execute(count_q)).scalar() or 0)
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "rate": TaxRate.rate,
            "label": TaxRate.label,
            "examples": TaxRate.examples,
            "active": TaxRate.active,
            "is_active": TaxRate.active,
            "created_at": TaxRate.created_at,
        },
        default_key="rate",
        default_order="asc",
    )
    list_q = select(TaxRate)
    if visibility is not None:
        list_q = list_q.where(visibility)
    result = await db.execute(list_q.order_by(sort_expr).offset(sk).limit(lim))
    items = [_serialize(t) for t in result.scalars().all()]
    return paged_list(items, total, sk, lim)


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
    if data.is_active is not None:
        tax.active = data.is_active
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
