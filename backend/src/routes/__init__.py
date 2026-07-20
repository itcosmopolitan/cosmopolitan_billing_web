"""Route module barrel — imports each router so they're registered with
FastAPI when `src.routes` is imported. Each name is explicitly re-exported
via `__all__` so ruff doesn't flag them as unused (F401)."""
from src.routes import (
    activity,
    audit,
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
    setup,
    taxes,
    transfers,
    users,
    vendors,
)

__all__ = [
    "activity",
    "audit",
    "auth", "branches", "cash", "customers", "dashboard",
    "items", "permissions", "purchases", "reports", "roles",
    "sales", "setup", "taxes", "transfers", "users", "vendors",
]
