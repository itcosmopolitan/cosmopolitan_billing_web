from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_
from sqlalchemy.orm import selectinload
from src.database import get_db
from src.models import Item, ItemStock, Category
from src.pagination import paged, normalize_limit, normalize_skip
from pydantic import BaseModel
from typing import Optional, List
import uuid

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

@router.get("/")
async def list_items(
    search: Optional[str] = None,
    category_id: Optional[str] = None,
    branch_id: Optional[str] = "br-001",
    status: Optional[str] = None,
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
    result = await db.execute(q.order_by(Item.name).offset(sk).limit(lim))
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

@router.post("/")
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

@router.put("/{item_id}")
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

@router.patch("/{item_id}")
async def patch_item(item_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Item).where(Item.id == item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Item not found")
    for k, v in data.items():
        if hasattr(item, k):
            setattr(item, k, v)
    await db.commit()
    return {"message": "Updated"}

@router.post("/adjust")
async def adjust_stock(data: StockAdjustRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ItemStock).where(ItemStock.item_id == data.item_id, ItemStock.branch_id == data.branch_id))
    stock = result.scalar_one_or_none()
    if not stock:
        stock = ItemStock(id=str(uuid.uuid4()), item_id=data.item_id, branch_id=data.branch_id, quantity=0)
        db.add(stock)
    stock.quantity = data.new_qty
    await db.commit()
    return {"message": "Stock adjusted"}