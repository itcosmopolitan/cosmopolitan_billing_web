"""Route module barrel — imports each router so they're registered with
FastAPI when `src.routes` is imported. Each name is explicitly re-exported
via `__all__` so ruff doesn't flag them as unused (F401)."""
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

__all__ = [
    "auth", "branches", "cash", "customers", "dashboard",
    "items", "permissions", "purchases", "reports", "roles",
    "sales", "transfers", "users", "vendors",
]
