"""Every list endpoint must accept the largest page size the UI offers.

The shared `PaginationBar` (frontend/src/utils/pagination.js PAGE_SIZE_OPTIONS)
lets the user pick up to 500 rows per page, so any `limit` query param on a
GET route must allow at least that value. Otherwise choosing 500 produces a
422 "Input should be less than or equal to 200" error.
"""

import asyncio

from httpx import AsyncClient
from sqlalchemy import select

from src.database import get_db, get_engine
from src.main import app
from src.models import User
from src.pagination import ALLOWED_PAGE_SIZES
from src.security import create_access_token

MAX_UI_PAGE_SIZE = max(ALLOWED_PAGE_SIZES)


def _collect_maximums(schema):
    """Return every `maximum` declared in a (possibly anyOf-wrapped) JSON schema."""
    found = []
    if isinstance(schema, dict):
        if "maximum" in schema:
            found.append(schema["maximum"])
        for value in schema.values():
            found.extend(_collect_maximums(value))
    elif isinstance(schema, list):
        for value in schema:
            found.extend(_collect_maximums(value))
    return found


def _limit_params_by_route():
    spec = app.openapi()
    result = {}
    for path, operations in spec["paths"].items():
        # Autocomplete routes are typeahead dropdowns, not paginated lists.
        if path.startswith("/api/v1/autocomplete/"):
            continue
        get_op = operations.get("get")
        if not get_op:
            continue
        for param in get_op.get("parameters", []):
            if param.get("in") == "query" and param.get("name") == "limit":
                result[path] = _collect_maximums(param.get("schema", {}))
    return result


def test_list_limit_params_allow_largest_ui_page_size():
    params = _limit_params_by_route()
    assert params, "expected at least one GET route with a limit query param"

    too_small = {
        path: maxes for path, maxes in params.items()
        if not maxes or min(maxes) < MAX_UI_PAGE_SIZE
    }
    assert not too_small, (
        f"GET routes whose `limit` max is below {MAX_UI_PAGE_SIZE}: {too_small}"
    )


async def _get_super_admin_token():
    async for db in get_db():
        result = await db.execute(select(User).where(User.role == "super_admin"))
        user = result.scalars().first()
        return create_access_token(user.id)


def test_payment_lists_accept_500_rows_per_page():
    async def _run():
        try:
            token = await _get_super_admin_token()
            headers = {"Authorization": f"Bearer {token}"}
            async with AsyncClient(app=app, base_url="http://test") as client:
                for path in ("/api/v1/sales/payments/", "/api/v1/purchases/payments/"):
                    response = await client.get(path, params={"limit": 500}, headers=headers)
                    assert response.status_code == 200, (path, response.text)
                    assert response.json()["limit"] == 500

                    too_big = await client.get(path, params={"limit": 501}, headers=headers)
                    assert too_big.status_code == 422, path
        finally:
            # Pooled connections are bound to this loop; drop them before it closes.
            await get_engine().dispose()

    asyncio.run(_run())
