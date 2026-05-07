import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.database import get_db
from src.models import Item, ItemStock
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._atomic import set_stock_atomic
from src.security import require_perm

router = APIRouter()

class ItemCreate(BaseModel):
    name: str
    sku: Optional[str] = None
    barcode: Optional[str] = None
    category_id: str
    brand: Optional[str] = None
    unit: str = "Pcs"
    cost_price: float
    selling_price: float
    tax_rate: float = 18
    hsn_code: Optional[str] = None
    reorder_level: int = 10
    emoji: str = "📦"
    batch_tracking: bool = False
    expiry_tracking: bool = False
    opening_stock: int = 0
    branch_id: str = "br-001"

class StockAdjustRequest(BaseModel):
    item_id: str
    branch_id: str
    new_qty: int
    reason: str
    notes: Optional[str] = None


class ItemPatch(BaseModel):
    """Partial item update body. Excludes immutable / derived fields like
    `id`, `sku` (managed by create), `active` (use a separate deactivation
    endpoint when added). `data: dict` + setattr would have allowed any
    column to be flipped from a PATCH."""
    name: Optional[str] = None
    barcode: Optional[str] = None
    category_id: Optional[str] = None
    brand: Optional[str] = None
    unit: Optional[str] = None
    cost_price: Optional[float] = None
    selling_price: Optional[float] = None
    tax_rate: Optional[float] = None
    hsn_code: Optional[str] = None
    reorder_level: Optional[int] = None
    emoji: Optional[str] = None
    batch_tracking: Optional[bool] = None
    expiry_tracking: Optional[bool] = None

@router.get("/", dependencies=[Depends(require_perm("items.view", "pos.use"))])
async def list_items(
    search: Optional[str] = None,
    category_id: Optional[str] = None,
    branch_id: Optional[str] = "br-001",
    status: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    q = select(Item).where(Item.active == True).options(selectinload(Item.category))
    if search:
        q = q.where(Item.name.ilike(f"%{search}%"))
    if category_id:
        q = q.where(Item.category_id == category_id)
    cq = select(func.count(Item.id)).where(Item.active == True)
    if search:
        cq = cq.where(Item.name.ilike(f"%{search}%"))
    if category_id:
        cq = cq.where(Item.category_id == category_id)
    total = int((await db.execute(cq)).scalar() or 0)
    # NB: `available_stock` is a per-branch lookup done in Python below, not a
    # column on Item — we can't sort by it at the SQL level without a join. If
    # that becomes important, restructure the query to join ItemStock and add
    # `available_stock` to the allow-list as a query expression.
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "name": Item.name,
            "sku": Item.sku,
            "barcode": Item.barcode,
            "category_id": Item.category_id,
            "cost_price": Item.cost_price,
            "selling_price": Item.selling_price,
            "tax_rate": Item.tax_rate,
            "reorder_level": Item.reorder_level,
            "created_at": Item.created_at,
            "updated_at": Item.updated_at,
        },
        default_key="name",
        default_order="asc",
    )
    result = await db.execute(q.order_by(sort_expr).offset(sk).limit(lim))
    items = result.scalars().all()
    ids = [it.id for it in items]
    stock_by_item = {}
    if ids:
        sr = await db.execute(
            select(ItemStock).where(and_(ItemStock.item_id.in_(ids), ItemStock.branch_id == branch_id))
        )
        for row in sr.scalars().all():
            stock_by_item[row.item_id] = row.quantity
    out = []
    for item in items:
        out.append({
            "id": item.id,
            "name": item.name,
            "sku": item.sku,
            "barcode": item.barcode,
            "categoryId": item.category_id,
            "categoryName": item.category.name if item.category else "Uncategorized",
            "brand": item.brand,
            "unit": item.unit,
            "cost_price": item.cost_price,
            "selling_price": item.selling_price,
            "tax_rate": item.tax_rate,
            "hsn_code": item.hsn_code,
            "reorder_level": item.reorder_level,
            "emoji": item.emoji,
            "batch_tracking": item.batch_tracking,
            "expiry_tracking": item.expiry_tracking,
            "available_stock": stock_by_item.get(item.id, 0),
        })
    return paged(out, total, sk, lim)

@router.post("/", dependencies=[Depends(require_perm("items.create"))])
async def create_item(data: ItemCreate, db: AsyncSession = Depends(get_db)):
    item = Item(
        id=str(uuid.uuid4()),
        name=data.name,
        sku=data.sku or f"SKU-{uuid.uuid4().hex[:6].upper()}",
        barcode=data.barcode,
        category_id=data.category_id,
        brand=data.brand,
        unit=data.unit,
        cost_price=data.cost_price,
        selling_price=data.selling_price,
        tax_rate=data.tax_rate,
        hsn_code=data.hsn_code,
        reorder_level=data.reorder_level,
        emoji=data.emoji,
        batch_tracking=data.batch_tracking,
        expiry_tracking=data.expiry_tracking,
    )
    db.add(item)
    stock = ItemStock(
        id=str(uuid.uuid4()),
        item_id=item.id,
        branch_id=data.branch_id,
        quantity=data.opening_stock,
    )
    db.add(stock)
    await db.commit()
    return {"id": item.id, "message": "Item created"}

@router.put("/{item_id}", dependencies=[Depends(require_perm("items.edit"))])
async def update_item(item_id: str, data: ItemCreate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Item).where(Item.id == item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Item not found")

    item.name = data.name
    item.sku = data.sku or item.sku
    item.barcode = data.barcode
    item.category_id = data.category_id
    item.brand = data.brand
    item.unit = data.unit
    item.cost_price = data.cost_price
    item.selling_price = data.selling_price
    item.tax_rate = data.tax_rate
    item.hsn_code = data.hsn_code
    item.reorder_level = data.reorder_level
    item.batch_tracking = data.batch_tracking
    item.expiry_tracking = data.expiry_tracking

    await db.commit()
    await db.refresh(item)
    return {"id": item.id, "message": "Item updated"}

@router.patch("/{item_id}", dependencies=[Depends(require_perm("items.edit"))])
async def patch_item(item_id: str, data: ItemPatch, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Item).where(Item.id == item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Item not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(item, k, v)
    await db.commit()
    return {"message": "Updated"}

@router.post("/adjust", dependencies=[Depends(require_perm("items.adjust"))])
async def adjust_stock(data: StockAdjustRequest, db: AsyncSession = Depends(get_db)):
    if data.new_qty < 0:
        raise HTTPException(400, "new_qty must be >= 0")
    await set_stock_atomic(
        db,
        item_id=data.item_id,
        branch_id=data.branch_id,
        new_qty=data.new_qty,
    )
    await db.commit()
    return {"message": "Stock adjusted"}
