from __future__ import annotations

import uuid
from typing import Any, Optional

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import AuditLog, User


_SENSITIVE_KEYS = {
    "password",
    "pass",
    "passwd",
    "token",
    "access_token",
    "refresh_token",
    "card",
    "card_number",
    "cvv",
    "cvc",
    "pan",
}


def _sanitize_metadata(value: Any) -> Any:
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, child in value.items():
            lower_key = key.lower()
            if lower_key in _SENSITIVE_KEYS or "password" in lower_key or "token" in lower_key or "card" in lower_key:
                cleaned[key] = "[REDACTED]"
            else:
                cleaned[key] = _sanitize_metadata(child)
        return cleaned
    if isinstance(value, list):
        return [_sanitize_metadata(item) for item in value]
    return value


RISK_RULES = [
    (lambda a, m, d: a == "Invoice Cancelled", "HIGH"),
    (lambda a, m, d: a == "Purchase Bill Edited" and abs(d.get("amount_delta", 0)) > 1000, "HIGH"),
    (lambda a, m, d: a == "User Login" and d.get("login_anomaly") is True, "HIGH"),
    (lambda a, m, d: a == "Stock Transfer Approved" and d.get("stock_value", 0) > 50000, "HIGH"),
    (lambda a, m, d: a == "Stock Transfer Approved" and d.get("approver_id") == d.get("requester_id"), "HIGH"),
    (lambda a, m, d: a == "Purchase Bill Edited", "MEDIUM"),
    (lambda a, m, d: a == "Stock Transfer Approved", "MEDIUM"),
    (lambda a, m, d: a == "Stock Adjustment" and abs(d.get("unit_delta", 0)) > 10, "MEDIUM"),
    (lambda a, m, d: a == "Discount Applied" and d.get("above_threshold") is True, "MEDIUM"),
]


def classify_risk(action: str, module: str, metadata: Optional[dict[str, Any]]) -> str:
    data = metadata or {}
    for condition, level in RISK_RULES:
        if condition(action, module, data):
            return level
    return "LOW"


def build_audit_entry(
    action: str,
    module: str,
    reference_id: str,
    detail: str,
    user_id: str,
    user_name: str,
    user_role: str,
    ip_address: Optional[str] = None,
    device_info: Optional[str] = None,
    branch_id: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Build a standard audit payload with enforced risk classification."""
    safe_metadata = _sanitize_metadata(metadata or {})
    risk = classify_risk(action, module, safe_metadata)
    return {
        "action": action,
        "module": module,
        "reference_id": reference_id,
        "ref": reference_id,
        "detail": detail,
        "user_id": user_id,
        "user_name": user_name,
        "user_role": user_role,
        "ip_address": ip_address,
        "device_info": device_info,
        "branch_id": branch_id,
        "metadata_": safe_metadata,
        "risk": risk,
    }

def _get_user_role(user: Optional[User]) -> str:
    if user is None:
        return "unknown"
    return user.role.value if hasattr(user.role, "value") else str(user.role)


def add_audit_log(
    db: AsyncSession,
    *,
    action: str,
    module: str,
    reference_id: str,
    detail: str,
    user: Optional[User],
    request: Optional[Request] = None,
    branch_id: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> None:
    payload = build_audit_entry(
        action=action,
        module=module,
        reference_id=reference_id,
        detail=detail,
        user_id=getattr(user, "id", "system"),
        user_name=getattr(user, "name", "System"),
        user_role=_get_user_role(user),
        ip_address=getattr(request.state, "ip_address", None) if request else None,
        device_info=getattr(request.state, "device_info", None) if request else None,
        branch_id=branch_id,
        metadata=metadata,
    )
    db.add(AuditLog(id=str(uuid.uuid4()), **payload))