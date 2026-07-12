"""
Cosmopolitan Pro — FastAPI Backend
Multi-branch retail billing & POS platform
"""
import asyncio
import logging
import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pathlib import Path

from sqlalchemy.exc import TimeoutError as SQLAlchemyTimeoutError

from src import config
from src.database import assert_activity_audit_schema, init_schema
from src.middleware.audit_middleware import AuditContextMiddleware
from src.routes import (
    activity,
    audit,
    auth,
    branches,
    cash,
    customer_display,
    customers,
    dashboard,
    items,
    permissions,
    purchases,
    reports,
    roles,
    sales,
    settings as settings_routes,
    taxes,
    transfers,
    adjustments,
    users,
    vendors,
    summaries,
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
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(AuditContextMiddleware)

logger = logging.getLogger("cosmopolitan.main")
logging.basicConfig(level=logging.INFO)

@app.middleware("http")
async def log_request_duration(request, call_next):
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception as exc:
        elapsed_ms = (time.perf_counter() - start) * 1000
        logger.exception(
            "Request failed %s %s in %.2fms",
            request.method,
            request.url.path,
            elapsed_ms,
            exc_info=exc,
        )
        raise
    elapsed_ms = (time.perf_counter() - start) * 1000
    logger.info(
        "%s %s completed in %.2fms %s",
        request.method,
        request.url.path,
        elapsed_ms,
        response.status_code,
    )
    response.headers["X-Process-Time-Ms"] = f"{elapsed_ms:.2f}"
    return response


@app.exception_handler(asyncio.TimeoutError)
async def timeout_exception_handler(request, exc):
    logger.warning("Request timeout for %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=504,
        content={"detail": "Request timed out. Please narrow the date range or try again later."},
    )


@app.exception_handler(SQLAlchemyTimeoutError)
async def sqlalchemy_timeout_exception_handler(request, exc):
    logger.warning("Database timeout for %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(
        status_code=504,
        content={"detail": "A database timeout occurred. Please narrow the date range or try again later."},
    )


# ─── Routers ──────────────────────────────────────────────────────────────────
PREFIX = "/api/v1"
app.include_router(auth.router,       prefix=f"{PREFIX}/auth",      tags=["Auth"])
app.include_router(audit.router,      prefix=f"{PREFIX}/audit",     tags=["Audit"])
app.include_router(activity.router,   prefix=f"{PREFIX}/activity",  tags=["Activity"])
app.include_router(dashboard.router,  prefix=f"{PREFIX}/dashboard", tags=["Dashboard"])
app.include_router(branches.router,   prefix=f"{PREFIX}/branches",  tags=["Branches"])
app.include_router(items.router,      prefix=f"{PREFIX}/items",     tags=["Items"])
app.include_router(customers.router,  prefix=f"{PREFIX}/customers", tags=["Customers"])
app.include_router(vendors.router,    prefix=f"{PREFIX}/vendors",   tags=["Vendors"])
app.include_router(sales.router,      prefix=f"{PREFIX}/sales",     tags=["Sales"])
app.include_router(purchases.router,  prefix=f"{PREFIX}/purchases", tags=["Purchases"])
app.include_router(transfers.router,  prefix=f"{PREFIX}/transfers", tags=["Transfers"])
app.include_router(adjustments.router, prefix=f"{PREFIX}/adjustments", tags=["Adjustments"])
app.include_router(summaries.router,    prefix=f"{PREFIX}/summaries",    tags=["Summaries"])
app.include_router(cash.router,       prefix=f"{PREFIX}/cash",      tags=["Cash"])
app.include_router(reports.router,    prefix=f"{PREFIX}/reports",   tags=["Reports"])
app.include_router(users.router,      prefix=f"{PREFIX}/users",     tags=["Users"])
app.include_router(roles.router,       prefix=f"{PREFIX}/roles",       tags=["Roles"])
app.include_router(permissions.router, prefix=f"{PREFIX}/permissions", tags=["Permissions"])
app.include_router(settings_routes.router, prefix=f"{PREFIX}/settings", tags=["Settings"])
app.include_router(taxes.router,       prefix=f"{PREFIX}/taxes",       tags=["Taxes"])
app.include_router(customer_display.router, prefix=f"{PREFIX}/ws", tags=["Customer Display WS"])

@app.on_event("startup")
async def startup():
    logger.info("Starting FastAPI application startup")
    try:
        await init_schema()
        await assert_activity_audit_schema()
        logger.info("FastAPI application startup completed")
    except Exception:
        logger.exception("Application startup failed during database initialization")
        raise

@app.get("/api/health")
async def health():
    return {"status": "ok", "service": settings.app_title, "version": settings.app_version}

# ─── Frontend Static Files ───────────────────────────────────────────────────

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

if FRONTEND_DIST.exists():
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIST / "assets"),
        name="assets",
    )

    @app.get("/{full_path:path}")
    async def serve_react_app(full_path: str):
        index_path = FRONTEND_DIST / "index.html"

        if index_path.exists():
            return FileResponse(index_path)

        return {"error": "Frontend not built"}
