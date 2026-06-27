import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import Vendor, VendorCreditEntry
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._serializers import serialize_vendor
from src.permissions import VENDOR_PICKER_READ
from src.security import require_perm

router = APIRouter()

class VendorCreate(BaseModel):
    name: str
    contact_person: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    gstin: Optional[str] = None
    payment_terms: str = "30 days"

class VendorUpdate(BaseModel):
    name: Optional[str] = None
    contact_person: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    gstin: Optional[str] = None
    payment_terms: Optional[str] = None

@router.get("/", dependencies=[Depends(require_perm(*VENDOR_PICKER_READ))])
async def list_vendors(
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    q = select(Vendor)
    cq = select(func.count(Vendor.id))
    conds = []
    if search:
        term = f"%{search}%"
        search_filter = or_(
            Vendor.name.ilike(term),
            Vendor.contact_person.ilike(term),
            Vendor.phone.ilike(term),
            Vendor.email.ilike(term),
        )
        q = q.where(search_filter)
        cq = cq.where(search_filter)
        conds.append(search_filter)
    total = int((await db.execute(cq)).scalar() or 0)
    outstanding_total = float(
        (
            await db.execute(
                select(func.coalesce(func.sum(Vendor.outstanding), 0)).where(
                    and_(*conds) if conds else True
                )
            )
        ).scalar()
        or 0
    )
    wb_filter = and_(Vendor.outstanding > 0, *conds) if conds else (Vendor.outstanding > 0)
    with_balance = int((await db.execute(select(func.count(Vendor.id)).where(wb_filter))).scalar() or 0)
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "name": Vendor.name,
            "contact_person": Vendor.contact_person,
            "phone": Vendor.phone,
            "email": Vendor.email,
            "payment_terms": Vendor.payment_terms,
            "outstanding": Vendor.outstanding,
            "total_purchases": Vendor.total_purchases,
            "created_at": Vendor.created_at,
        },
        default_key="name",
        default_order="asc",
    )
    result = await db.execute(q.order_by(sort_expr).offset(sk).limit(lim))
    items = [serialize_vendor(v) for v in result.scalars().all()]
    return paged(
        items,
        total,
        sk,
        lim,
        summary={"outstandingTotal": outstanding_total, "withBalanceCount": with_balance},
    )

@router.get("/{vendor_id}", dependencies=[Depends(require_perm(*VENDOR_PICKER_READ))])
async def get_vendor(vendor_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    v = result.scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Vendor not found")
    return serialize_vendor(v)

@router.get("/{vendor_id}/credit-ledger", dependencies=[Depends(require_perm("vendors.view"))])
async def vendor_credit_ledger(
    vendor_id: str,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    """Append-only vendor advance / overpayment credit ledger."""
    exists = (
        await db.execute(select(Vendor.id).where(Vendor.id == vendor_id))
    ).scalar_one_or_none()
    if not exists:
        raise HTTPException(404, "Vendor not found")

    total = int(
        (
            await db.execute(
                select(func.count(VendorCreditEntry.id)).where(
                    VendorCreditEntry.vendor_id == vendor_id
                )
            )
        ).scalar()
        or 0
    )
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    rows = (
        await db.execute(
            select(VendorCreditEntry)
            .where(VendorCreditEntry.vendor_id == vendor_id)
            .order_by(VendorCreditEntry.created_at.desc(), VendorCreditEntry.id.desc())
            .offset(sk)
            .limit(lim)
        )
    ).scalars().all()

    def _entry_type_label(t: str) -> str:
        labels = {
            "payment_debit": "Credit payment",
            "overpayment": "Overpayment credit",
            "return_void_revoke": "Return void (revoke)",
            "void_restore": "Payment void (restore)",
            "void_revoke": "Payment void (revoke)",
        }
        return labels.get(t, t.replace("_", " ").title())

    items = [{
        "id": e.id,
        "entryType": e.entry_type,
        "entryLabel": _entry_type_label(e.entry_type),
        "delta": round(float(e.delta or 0), 2),
        "balanceBefore": round(float(e.balance_before or 0), 2),
        "balanceAfter": round(float(e.balance_after or 0), 2),
        "sourceType": e.source_type,
        "sourceRef": e.source_ref,
        "sourceNumber": e.source_number,
        "notes": e.notes,
        "date": e.date,
        "createdBy": e.created_by,
        "createdAt": e.created_at.isoformat() if e.created_at else None,
    } for e in rows]
    return paged(items, total, sk, lim)

@router.post("/", status_code=201, dependencies=[Depends(require_perm("vendors.create"))])
async def create_vendor(data: VendorCreate, db: AsyncSession = Depends(get_db)):
    v = Vendor(id=str(uuid.uuid4()), name=data.name, contact_person=data.contact_person,
               phone=data.phone, email=data.email, address=data.address,
               gstin=data.gstin, payment_terms=data.payment_terms)
    db.add(v)
    await db.commit()
    await db.refresh(v)
    return serialize_vendor(v)

@router.put("/{vendor_id}", dependencies=[Depends(require_perm("vendors.edit"))])
async def update_vendor(vendor_id: str, data: VendorUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    v = result.scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Vendor not found")
    for k, val in data.model_dump(exclude_unset=True).items():
        setattr(v, k, val)
    await db.commit()
    await db.refresh(v)
    return serialize_vendor(v)
