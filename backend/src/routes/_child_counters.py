from __future__ import annotations

from typing import Optional

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import Branch
from src.routes._serializers import normalize_child_counters


async def validate_child_counter(
    db: AsyncSession,
    branch_id: str,
    child_counter_id: Optional[str],
    child_counter_name: Optional[str],
) -> tuple[Optional[str], Optional[str]]:
    branch = (
        await db.execute(select(Branch).where(Branch.id == branch_id))
    ).scalar_one_or_none()
    if not branch:
        raise HTTPException(404, "Branch not found")

    counters = getattr(branch, "child_counters", None) or []
    selected_id = (child_counter_id or "").strip()
    selected_name = (child_counter_name or "").strip()
    if not getattr(branch, "has_child_counters", False):
        if selected_id or selected_name:
            raise HTTPException(400, "This branch does not have child counters")
        return None, None

    normalized = [
        counter
        for counter in normalize_child_counters(branch.id, counters)
        if str(counter.get("name") or "").strip()
    ]
    if not normalized:
        if selected_id or selected_name:
            raise HTTPException(400, "This branch has no configured child counters")
        return None, None
    if not selected_id and not selected_name:
        raise HTTPException(400, "Select a valid child counter for this branch")

    selected = next(
        (
            counter for counter in normalized
            if (
                counter["id"] == selected_id
                if selected_id
                else counter.get("name") == selected_name
            )
        ),
        None,
    )
    if not selected:
        raise HTTPException(400, "Selected child counter does not belong to this branch")
    return selected["id"], selected["name"]
