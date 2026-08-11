"""Lightweight autocomplete endpoints for dropdowns."""

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import Branch, Category, Customer, Item, ItemBranchConfig, ItemStock, TaxRate, User, Vendor
from src.permissions import BRANCH_PICKER_READ
from src.routes._serializers import get_user_branch_ids
from src.security import current_user, require_perm

router = APIRouter()

DEFAULT_UNITS = ("Pcs", "Kg", "Gram", "Litre", "ML", "Pack", "Box", "Dozen")


@router.get("/customer", dependencies=[Depends(require_perm("customers.view"))])
async def autocomplete_customer(
    search_text: Optional[str] = None,
    limit: int = Query(30, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Return `{ id, text }` rows for customer name dropdowns."""
    q = select(Customer).where(Customer.active.is_(True))
    if search_text:
        term = f"%{search_text.strip()}%"
        q = q.where(
            or_(
                Customer.name.ilike(term),
                Customer.phone.ilike(term),
                Customer.email.ilike(term),
            )
        )
    rows = (
        await db.execute(q.order_by(Customer.name.asc()).limit(limit))
    ).scalars().all()
    return [{
        "id": c.id,
        "text": c.name,
        "customer_type": c.type,
        "credit_terms": getattr(c, "credit_terms", None),
        "key_account_manager": getattr(c, "key_account_manager", None),
    } for c in rows]


@router.get("/vendor", dependencies=[Depends(require_perm("vendors.view"))])
async def autocomplete_vendor(
    search_text: Optional[str] = None,
    limit: int = Query(30, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Return `{ id, text }` rows for vendor name dropdowns."""
    q = select(Vendor).where(Vendor.active.is_(True))
    if search_text:
        term = f"%{search_text.strip()}%"
        q = q.where(
            or_(
                Vendor.name.ilike(term),
                Vendor.phone.ilike(term),
                Vendor.email.ilike(term),
            )
        )
    rows = (
        await db.execute(q.order_by(Vendor.name.asc()).limit(limit))
    ).scalars().all()
    return [{"id": v.id, "text": v.name} for v in rows]


@router.get(
    "/category",
    dependencies=[Depends(require_perm("items.view", "items.create", "items.edit"))],
)
async def autocomplete_category(
    search_text: Optional[str] = None,
    limit: int = Query(30, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Return `{ id, text }` rows for item category dropdowns."""
    q = select(Category)
    if search_text:
        term = f"%{search_text.strip()}%"
        q = q.where(Category.name.ilike(term))
    rows = (
        await db.execute(q.order_by(Category.name.asc()).limit(limit))
    ).scalars().all()
    return [{"id": c.id, "text": c.name} for c in rows]


@router.get(
    "/unit",
    dependencies=[Depends(require_perm("items.view", "items.create", "items.edit"))],
)
async def autocomplete_unit(
    search_text: Optional[str] = None,
    limit: int = Query(30, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Return `{ id, text }` rows for item unit dropdowns (`id` equals unit name)."""
    db_units = (
        await db.execute(
            select(Item.unit)
            .where(Item.unit.isnot(None), Item.unit != "")
            .distinct()
            .order_by(Item.unit.asc())
        )
    ).scalars().all()

    needle = search_text.strip().lower() if search_text else ""
    seen: set[str] = set()
    units: list[str] = []
    for raw in list(DEFAULT_UNITS) + list(db_units):
        unit = (raw or "").strip()
        key = unit.lower()
        if not unit or key in seen:
            continue
        if needle and needle not in key:
            continue
        seen.add(key)
        units.append(unit)
        if len(units) >= limit:
            break

    return [{"id": u, "text": u} for u in units]


@router.get("/tax-rate", dependencies=[Depends(require_perm("items.view", "items.create", "items.edit"))])
async def autocomplete_tax_rate(
    search_text: Optional[str] = None,
    include_rate: Optional[float] = None,
    limit: int = Query(30, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Return `{ id, text }` rows for GST rate dropdowns (`id` is the rate string)."""
    q = select(TaxRate).where(TaxRate.active.is_(True))
    if search_text:
        term = f"%{search_text.strip()}%"
        q = q.where(or_(TaxRate.label.ilike(term), TaxRate.examples.ilike(term)))
    rows = (
        await db.execute(q.order_by(TaxRate.rate.asc()).limit(limit))
    ).scalars().all()

    items = [{"id": str(t.rate), "text": f"{t.rate}%"} for t in rows]
    if include_rate is not None:
        rate_key = str(include_rate)
        if not any(i["id"] == rate_key for i in items):
            extra = (
                await db.execute(select(TaxRate).where(TaxRate.rate == include_rate).limit(1))
            ).scalar_one_or_none()
            label = f"{include_rate}%"
            if extra and not extra.active:
                label = f"{include_rate}% (inactive)"
            items = [{"id": rate_key, "text": label}, *items]
    return items[:limit]


@router.get("/branch", dependencies=[Depends(require_perm(*BRANCH_PICKER_READ))])
async def autocomplete_branch(
    search_text: Optional[str] = None,
    retail_only: bool = Query(True),
    exclude_id: Optional[str] = None,
    limit: int = Query(30, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Return `{ id, text }` rows for branch dropdowns."""
    q = select(Branch).where(Branch.active.is_(True))
    if retail_only:
        q = q.where(Branch.code != "WH")
    if exclude_id:
        q = q.where(Branch.id != exclude_id)
    if not getattr(user, "all_branches", False):
        accessible = await get_user_branch_ids(db, user.id)
        if not accessible:
            return []
        q = q.where(Branch.id.in_(accessible))
    if search_text:
        term = f"%{search_text.strip()}%"
        q = q.where(or_(Branch.name.ilike(term), Branch.code.ilike(term)))
    rows = (
        await db.execute(q.order_by(Branch.name.asc()).limit(limit))
    ).scalars().all()
    return [{"id": b.id, "text": b.name} for b in rows]


@router.get(
    "/item",
    dependencies=[Depends(require_perm("items.view", "adjustments.create"))],
)
async def autocomplete_item(
    branch_id: str = Query(..., min_length=1),
    search_text: Optional[str] = None,
    listed_only: bool = Query(True),
    limit: int = Query(30, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Return item rows for branch-scoped dropdowns (`text` includes stock hint)."""
    q = select(Item).where(Item.active.is_(True))
    if listed_only:
        listed_join = and_(
            ItemBranchConfig.item_id == Item.id,
            ItemBranchConfig.branch_id == branch_id,
            ItemBranchConfig.is_available.is_(True),
        )
        q = q.join(ItemBranchConfig, listed_join)
    if search_text:
        term = f"%{search_text.strip()}%"
        q = q.where(
            or_(
                Item.name.ilike(term),
                Item.sku.ilike(term),
                Item.barcode.ilike(term),
            )
        )
    rows = (
        await db.execute(q.order_by(Item.name.asc()).limit(limit))
    ).scalars().all()

    ids = [it.id for it in rows]
    stock_by_item: dict[str, int] = {}
    if ids:
        sr = await db.execute(
            select(ItemStock).where(
                and_(ItemStock.item_id.in_(ids), ItemStock.branch_id == branch_id)
            )
        )
        for row in sr.scalars().all():
            stock_by_item[row.item_id] = row.quantity

    out = []
    for item in rows:
        stock = stock_by_item.get(item.id, 0)
        out.append({
            "id": item.id,
            "text": f"{item.name} — stock {stock}",
            "name": item.name,
            "available_stock": stock,
            "batch_tracking": item.batch_tracking,
            "expiry_tracking": item.expiry_tracking,
        })
    return out


@router.get("/staff", dependencies=[Depends(require_perm("dashboard.view", "reports.view"))])
async def autocomplete_staff(
    search_text: Optional[str] = None,
    limit: int = Query(30, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Return `{ id, text }` rows for staff filter dropdowns."""
    q = select(User).where(User.active.is_(True))
    if search_text:
        term = f"%{search_text.strip()}%"
        q = q.where(or_(User.name.ilike(term), User.email.ilike(term)))
    rows = (
        await db.execute(q.order_by(User.name.asc()).limit(limit))
    ).scalars().all()
    return [{"id": u.id, "text": u.name} for u in rows]


@router.get(
    "/branch-managers",
    dependencies=[Depends(require_perm("customers.view", "customers.create", "customers.edit"))],
)
async def autocomplete_branch_managers(
    search_text: Optional[str] = None,
    limit: int = Query(30, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Active users with the Branch Manager role — for customer KAM dropdown."""
    from src.models import UserRole

    q = select(User).where(
        User.active.is_(True),
        or_(
            User.role == UserRole.branch_manager,
            User.role_id == "role-branch-manager",
        ),
    )
    if search_text:
        term = f"%{search_text.strip()}%"
        q = q.where(or_(User.name.ilike(term), User.email.ilike(term)))
    rows = (
        await db.execute(q.order_by(User.name.asc()).limit(limit))
    ).scalars().all()
    return [{"id": u.id, "text": u.name} for u in rows]
