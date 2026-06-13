"""Small dialect helpers — SQLite vs PostgreSQL SQL differences."""
from __future__ import annotations

from typing import Optional

from src import config


def database_url() -> str:
    return config.get().database_url


def is_postgresql(url: Optional[str] = None) -> bool:
    u = (url or database_url()).lower()
    return u.startswith("postgresql") or u.startswith("postgres+")


def scalar_min(name: str = "MIN") -> str:
    """Two-argument minimum: LEAST on PostgreSQL, MIN on SQLite."""
    return "LEAST" if is_postgresql() else "MIN"


def additive_column_ddl(ddl_type: str) -> str:
    """Normalize raw ALTER TABLE … ADD COLUMN types for the active dialect."""
    if not is_postgresql():
        return ddl_type
    out = ddl_type
    out = out.replace("BOOLEAN DEFAULT 0", "BOOLEAN DEFAULT FALSE")
    out = out.replace("BOOLEAN DEFAULT 1", "BOOLEAN DEFAULT TRUE")
    out = out.replace("FLOAT DEFAULT 0", "DOUBLE PRECISION DEFAULT 0")
    return out


def pg_invoice_status_case(clamp_expr: str) -> str:
    """CASE expression for sale_invoices.status — PG needs enum cast."""
    if is_postgresql():
        return (
            f"CASE WHEN {clamp_expr}(total, paid_amount + :amt) >= total "
            f"THEN 'paid'::invoicestatus ELSE 'partial'::invoicestatus END"
        )
    return (
        f"CASE WHEN {clamp_expr}(total, paid_amount + :amt) >= total "
        f"THEN 'paid' ELSE 'partial' END"
    )
