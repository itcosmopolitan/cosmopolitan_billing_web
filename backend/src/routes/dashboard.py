from fastapi import APIRouter, Query
from typing import Optional

router = APIRouter()

@router.get("/kpis")
async def get_kpis(branch_id: Optional[str] = None):
    return {
        "today_sales": 124850,
        "today_purchases": 48200,
        "cash_in_hand": 22640,
        "outstanding_receivables": 342100,
        "outstanding_payables": 118400,
        "low_stock_count": 24,
        "expiring_count": 6,
        "overdue_invoices": 18,
    }

@router.get("/sales-trend")
async def sales_trend(days: int = 14, branch_id: Optional[str] = None):
    import random
    dates = [f"Apr {i}" for i in range(3, 17)]
    return [{"date": d, "sales": random.randint(70000, 150000), "purchases": random.randint(10000, 90000)} for d in dates]

@router.get("/top-products")
async def top_products(branch_id: Optional[str] = None, limit: int = 5):
    return [
        {"name": "Basmati Rice 5kg", "units": 84, "revenue": 25200},
        {"name": "Toor Dal 1kg",     "units": 112, "revenue": 16800},
        {"name": "Sunflower Oil 1L", "units": 96,  "revenue": 14400},
        {"name": "Parle-G 800g",     "units": 240, "revenue": 12000},
        {"name": "Amul Butter 500g", "units": 68,  "revenue": 10200},
    ]

@router.get("/branch-comparison")
async def branch_comparison():
    return [
        {"branch": "Anna Nagar", "sales": 124850, "purchases": 48200},
        {"branch": "T. Nagar",   "sales": 98400,  "purchases": 32100},
        {"branch": "Vadapalani", "sales": 72600,  "purchases": 24400},
        {"branch": "Velachery",  "sales": 46200,  "purchases": 18000},
    ]

@router.get("/alerts")
async def alerts():
    return [
        {"type": "danger", "text": "Basmati Rice critical stock at T.Nagar", "module": "inventory"},
        {"type": "warning","text": "INV-2024-1840 overdue by 12 days", "module": "sales"},
        {"type": "warning","text": "Cash variance ₹340 at Vadapalani", "module": "cash"},
        {"type": "info",   "text": "TRF-041 awaiting approval", "module": "transfers"},
        {"type": "danger", "text": "6 items expiring in 30 days", "module": "inventory"},
    ]