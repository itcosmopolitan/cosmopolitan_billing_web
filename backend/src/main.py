"""
Cosmopolitan Pro — FastAPI Backend
Multi-branch retail billing & POS platform
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src import config
from src.database import init_schema
from src.routes import (
    auth,
    branches,
    cash,
    customers,
    dashboard,
    items,
    permissions,
    purchases,
    reports,
    roles,
    sales,
    transfers,
    users,
    vendors,
)

# ─── Load Configuration ────────────────────────────────────────────────────
config.load()
settings = config.get()

# ─── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(
    title=settings.app_title,
    description=settings.app_description,
    version=settings.app_version,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)

# ─── CORS ─────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Routers ──────────────────────────────────────────────────────────────────
PREFIX = "/api/v1"
app.include_router(auth.router,       prefix=f"{PREFIX}/auth",      tags=["Auth"])
app.include_router(dashboard.router,  prefix=f"{PREFIX}/dashboard", tags=["Dashboard"])
app.include_router(branches.router,   prefix=f"{PREFIX}/branches",  tags=["Branches"])
app.include_router(items.router,      prefix=f"{PREFIX}/items",     tags=["Items"])
app.include_router(customers.router,  prefix=f"{PREFIX}/customers", tags=["Customers"])
app.include_router(vendors.router,    prefix=f"{PREFIX}/vendors",   tags=["Vendors"])
app.include_router(sales.router,      prefix=f"{PREFIX}/sales",     tags=["Sales"])
app.include_router(purchases.router,  prefix=f"{PREFIX}/purchases", tags=["Purchases"])
app.include_router(transfers.router,  prefix=f"{PREFIX}/transfers", tags=["Transfers"])
app.include_router(cash.router,       prefix=f"{PREFIX}/cash",      tags=["Cash"])
app.include_router(reports.router,    prefix=f"{PREFIX}/reports",   tags=["Reports"])
app.include_router(users.router,      prefix=f"{PREFIX}/users",     tags=["Users"])
app.include_router(roles.router,       prefix=f"{PREFIX}/roles",       tags=["Roles"])
app.include_router(permissions.router, prefix=f"{PREFIX}/permissions", tags=["Permissions"])

@app.on_event("startup")
async def startup():
    # Creates tables, applies additive column migrations, backfills role_id (D6).
    await init_schema()

@app.get("/api/health")
async def health():
    return {"status": "ok", "service": settings.app_title, "version": settings.app_version}
