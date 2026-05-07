"""
Shared ORM-row → dict serializers used by route handlers.

Each helper returns the JSON-safe shape the frontend already consumes;
keeping them in one module makes it easier to add a field once instead of
hunting through every route file. We're not using Pydantic response_model=
yet because doing it right means typing every endpoint — see audit Tier 2
follow-up.
"""
from __future__ import annotations

from typing import Any


def _enum_value(v: Any) -> Any:
    """Return `v.value` if `v` is an enum, otherwise `v` itself."""
    return v.value if hasattr(v, "value") else v


def serialize_branch(b) -> dict:
    return {
        "id": b.id,
        "name": b.name,
        "code": b.code,
        "manager": b.manager,
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
        "total_purchases": v.total_purchases,
    }


def serialize_cash_entry(e) -> dict:
    return {
        "id": e.id,
        "branch_id": e.branch_id,
        "type": e.type,
        "category": e.category,
        "description": e.description,
        "amount": e.amount,
        "ref": e.ref,
        "date": e.date,
        "time": e.time,
        "by": e.by,
    }


def serialize_transfer(t) -> dict:
    return {
        "id": t.id,
        "ref_number": t.ref_number,
        "from_branch_id": t.from_branch_id,
        "to_branch_id": t.to_branch_id,
        "requested_by": t.requested_by,
        "approved_by": t.approved_by,
        "status": _enum_value(t.status),
        "notes": t.notes,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }


def serialize_user(u) -> dict:
    return {
        "id": u.id,
        "name": u.name,
        "email": u.email,
        "role": _enum_value(u.role),
        "role_id": u.role_id,
        "branch_id": u.branch_id,
        "active": u.active,
        "last_login": u.last_login.isoformat() if u.last_login else None,
    }
