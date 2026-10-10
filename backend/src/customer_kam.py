"""Per-branch key account manager (KAM) helpers.

A customer can have a different KAM in each branch. Values live in
customer_branch_kams. The legacy customers.key_account_manager column is kept
in step with the customer's home branch (customers.branch_id).

Loaded customers must be passed through attach_branch_kam_names before
branch_kam_label is used, because the label is read from attributes.
"""
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import Customer, CustomerBranchKam, User


# Customer import/template column for a branch's KAM, e.g. "Key Account Manager - MLN".
KAM_BRANCH_COLUMN_PREFIX = "Key Account Manager - "

async def load_branch_kams(db: AsyncSession, customer_ids: Iterable[str]) -> dict[str, dict[str, str]]:
    """Return {customer_id: {branch_id: key_account_manager}} for the given customers."""
    ids = {cid for cid in customer_ids if cid}
    result: dict[str, dict[str, str]] = {cid: {} for cid in ids}
    if not ids:
        return result
    rows = (
        await db.execute(
            select(
                CustomerBranchKam.customer_id,
                CustomerBranchKam.branch_id,
                CustomerBranchKam.key_account_manager,
            ).where(CustomerBranchKam.customer_id.in_(ids))
        )
    ).all()
    for customer_id, branch_id, kam in rows:
        if kam:
            result[customer_id][branch_id] = kam
    return result


async def attach_branch_kam_names(db: AsyncSession, customers) -> None:
    """Set per-branch KAM values and display names on each loaded customer.

    Sets:
      _branch_kams        {branch_id: stored value}
      _branch_kam_names   {branch_id: display name} (legacy user ids resolved)
      _key_account_manager_name  display name for the home branch
    """
    rows = [c for c in (customers or []) if c is not None]
    if not rows:
        return
    by_customer = await load_branch_kams(db, [c.id for c in rows])
    kam_values = {value for mapping in by_customer.values() for value in mapping.values()}
    name_by_id: dict[str, str] = {}
    if kam_values:
        name_rows = (
            await db.execute(select(User.id, User.name).where(User.id.in_(kam_values)))
        ).all()
        name_by_id = {row.id: row.name for row in name_rows if row.name}
    for c in rows:
        mapping = by_customer.get(c.id, {})
        names = {branch_id: name_by_id.get(value) or value for branch_id, value in mapping.items()}
        c._branch_kams = mapping
        c._branch_kam_names = names
        c._key_account_manager_name = names.get(c.branch_id)


def branch_kam_label(customer, branch_id: Optional[str]) -> Optional[str]:
    """Display name of the customer's KAM in the given branch, or None."""
    if customer is None or not branch_id:
        return None
    return (getattr(customer, "_branch_kam_names", None) or {}).get(branch_id)


async def save_branch_kams(db: AsyncSession, customer: Customer, mapping: dict[str, Optional[str]]) -> None:
    """Upsert or delete per-branch KAMs for a customer.

    A blank or None value clears that branch. Branches missing from `mapping`
    are left unchanged. Branch ids are not validated here; routes must check
    them first. The legacy column is set to the home branch's value.
    """
    if not mapping:
        return
    existing = {
        row.branch_id: row
        for row in (
            await db.execute(
                select(CustomerBranchKam).where(CustomerBranchKam.customer_id == customer.id)
            )
        ).scalars()
    }
    for branch_id, raw in mapping.items():
        value = (raw or "").strip() or None
        row = existing.get(branch_id)
        if value is None:
            if row is not None:
                await db.delete(row)
        elif row is not None:
            row.key_account_manager = value
        else:
            db.add(CustomerBranchKam(
                customer_id=customer.id,
                branch_id=branch_id,
                key_account_manager=value,
            ))
    if customer.branch_id in mapping:
        customer.key_account_manager = (mapping[customer.branch_id] or "").strip() or None


def merge_legacy_kam(mapping: dict[str, Optional[str]], home_branch_id: Optional[str], legacy_value) -> dict[str, Optional[str]]:
    """Fold the legacy single `key_account_manager` input into a per-branch map.

    The legacy value applies to the home branch unless the map sets it.
    """
    merged = dict(mapping or {})
    if home_branch_id and home_branch_id not in merged:
        merged[home_branch_id] = legacy_value
    return merged
