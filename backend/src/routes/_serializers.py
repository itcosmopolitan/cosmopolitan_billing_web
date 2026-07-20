"""
Shared ORM-row → dict serializers used by route handlers.

Each helper returns the JSON-safe shape the frontend already consumes;
keeping them in one module makes it easier to add a field once instead of
hunting through every route file. We're not using Pydantic response_model=
yet because doing it right means typing every endpoint — see audit Tier 2
follow-up.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, List


def _enum_value(v: Any) -> Any:
    """Return `v.value` if `v` is an enum, otherwise `v` itself."""
    return v.value if hasattr(v, "value") else v


async def attach_branch_ids(db, user_dicts: List[dict]) -> List[dict]:
    """Mutate `user_dicts` in place, adding `branch_ids` to each one.

    Bulk-fetches all UserBranch rows for the page in a single query
    (avoids N+1 in list endpoints). For users with `all_branches=True`
    the list is left empty — the frontend reads `all_branches` as the
    "implies all" signal.

    Returns the same list for chainability.
    """
    if not user_dicts:
        return user_dicts
    # Local import to avoid the module-level cycle (_serializers is a leaf).
    from sqlalchemy import select

    from src.models import UserBranch
    ids = [u["id"] for u in user_dicts if u.get("id")]
    if not ids:
        return user_dicts
    rows = (await db.execute(
        select(UserBranch.user_id, UserBranch.branch_id)
        .where(UserBranch.user_id.in_(ids))
    )).all()
    by_user: dict[str, list[str]] = defaultdict(list)
    for user_id, branch_id in rows:
        by_user[user_id].append(branch_id)
    for u in user_dicts:
        u["branch_ids"] = by_user.get(u["id"], [])
    return user_dicts


async def get_user_branch_ids(db, user_id: str) -> List[str]:
    """Single-user variant of attach_branch_ids — used by /auth/me + /login
    where we already have one user object and want its branch list."""
    from sqlalchemy import select

    from src.models import UserBranch
    rows = (await db.execute(
        select(UserBranch.branch_id).where(UserBranch.user_id == user_id)
    )).scalars().all()
    return list(rows)


def serialize_branch(b) -> dict:
    return {
        "id": b.id,
        "name": b.name,
        "code": b.code,
        "phone": b.phone,
        "address": b.address,
        "gstin": b.gstin,
        "active": b.active,
    }


def serialize_customer(c) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "phone": c.phone,
        "email": c.email,
        "address": c.address,
        # NB: model column is `gstin`; the frontend / API contract calls it
        # `gst_in`. Keep the API name; don't rename the model.
        "gst_in": c.gstin,
        "branch_id": c.branch_id,
        "credit_limit": c.credit_limit,
        "outstanding": c.outstanding,
        # Money we owe the customer (overpayments + returns refunded as
        # credit). Always ≥0. Frontend Customers table + Credit Notes tab
        # render this alongside `outstanding` without auto-netting — both
        # numbers can be non-zero at the same time.
        "credit_balance": float(getattr(c, "credit_balance", 0) or 0),
        "total_purchases": c.total_purchases,
        "customer_type": c.type,
        "active": c.active,
    }


def serialize_vendor(v) -> dict:
    return {
        "id": v.id,
        "name": v.name,
        "contact_person": v.contact_person,
        "phone": v.phone,
        "email": v.email,
        "address": v.address,
        "gstin": v.gstin,
        "payment_terms": v.payment_terms,
        "outstanding": v.outstanding,
        "credit_balance": getattr(v, "credit_balance", 0) or 0,
        "total_purchases": v.total_purchases,
        "active": bool(getattr(v, "active", True)),
    }


def serialize_cash_entry(e) -> dict:
    return {
        "id": e.id,
        "branch_id": e.branch_id,
        "entry_number": getattr(e, "entry_number", None),
        "type": e.type,
        "category": e.category,
        "description": e.description,
        "amount": e.amount,
        "ref": e.ref,
        "date": e.date,
        "time": e.time,
        "by": e.by,
        "source_type": getattr(e, "source_type", "manual"),
        "source_id": getattr(e, "source_id", None),
        "is_system": bool(getattr(e, "is_system", False)),
        "is_voided": bool(getattr(e, "is_voided", False)),
        "voided_by": getattr(e, "voided_by", None),
        "void_reason": getattr(e, "void_reason", None),
        "created_at": e.created_at.isoformat() if e.created_at else None,
    }


def serialize_cash_day_close(c) -> dict:
    if c is None:
        return None
    return {
        "id": c.id,
        "branch_id": c.branch_id,
        "date": c.date,
        "opening_balance": c.opening_balance,
        "total_cash_in": c.total_cash_in,
        "total_cash_out": c.total_cash_out,
        "expected_balance": c.expected_balance,
        "physical_count": c.physical_count,
        "variance": c.variance,
        "variance_reason": c.variance_reason,
        "notes": c.notes,
        "closed_by": c.closed_by,
        "closed_by_id": c.closed_by_id,
        "closed_at": c.closed_at.isoformat() if c.closed_at else None,
        "is_locked": c.is_locked,
        "unlocked_by": c.unlocked_by,
        "unlocked_at": c.unlocked_at.isoformat() if c.unlocked_at else None,
        "unlock_reason": c.unlock_reason,
    }


def serialize_transfer(t) -> dict:
    created = t.created_at
    return {
        "id": t.id,
        "ref_number": t.ref_number,
        "number": t.ref_number,
        "from_branch_id": t.from_branch_id,
        "to_branch_id": t.to_branch_id,
        "requested_by": t.requested_by,
        "approved_by": t.approved_by,
        "status": _enum_value(t.status),
        "priority": t.priority,
        "notes": t.notes,
        "request_date": t.request_date,
        "created_at": created.isoformat() if created else None,
        "date": created.strftime("%Y-%m-%d") if created else None,
    }


def serialize_user(u) -> dict:
    """Sync serializer — does NOT include `branch_ids` (which lives in a
    separate table). List endpoints follow this up with `attach_branch_ids`;
    single-user paths (login, /me) follow up with `get_user_branch_ids`."""
    return {
        "id": u.id,
        "name": u.name,
        "email": u.email,
        "role": _enum_value(u.role),
        "role_id": u.role_id,
        "all_branches": bool(getattr(u, "all_branches", False)),
        "active": u.active,
        "last_login": u.last_login.isoformat() if u.last_login else None,
        # Read by the frontend RequirePasswordSet guard — when True, the user
        # is redirected to /change-password and blocked from everything else.
        # Set True at create / reset; cleared by POST /auth/change-password.
        "must_change_password": bool(getattr(u, "must_change_password", False)),
    }
