"""Repair item lines saved with 0% GST although the item master has a GST rate.

Scope: quotations, sales orders and (with --include-invoices) sale invoices whose
customer is not internal and whose GSTIN differs from the organisation GSTIN.
Each affected line takes the item-master rate and the document subtotal/tax_total
are recomputed. The document total is unchanged because line prices are
GST-inclusive.

Dry run by default. Pass --apply to write.

Review before using --include-invoices: posted/paid invoices may already be in
filed GST returns, and sales returns created against them keep the old 0% rate.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import selectinload

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.database import get_async_session  # noqa: E402
from src.models import (  # noqa: E402
    Customer,
    Item,
    Organisation,
    Quotation,
    SaleInvoice,
    SalesOrder,
)
from src.tax_calc import restore_zero_rate, rollup_inclusive_lines  # noqa: E402


def _norm(gstin) -> str:
    return "".join(str(gstin or "").split()).upper()


async def _repair(db, model, label: str, org_gstin: str, apply: bool) -> int:
    docs = (await db.execute(
        select(model).options(selectinload(model.line_items))
    )).scalars().all()
    customers = {c.id: c for c in (await db.execute(select(Customer))).scalars().all()}
    master = {i.id: float(i.tax_rate or 0) for i in (await db.execute(select(Item))).scalars().all()}
    fixed = 0
    for doc in docs:
        customer = customers.get(doc.customer_id)
        if customer is not None:
            if str(getattr(customer, "classification", "") or "").lower() == "internal":
                continue
            if org_gstin and _norm(customer.gstin) == org_gstin:
                continue
        lines = list(doc.line_items or [])
        new_rates = [
            restore_zero_rate(l.tax_rate, master.get(l.item_id)) if l.item_id else float(l.tax_rate or 0)
            for l in lines
        ]
        if all(n == float(l.tax_rate or 0) for n, l in zip(new_rates, lines)):
            continue
        _rows, subtotal, tax_total, _total = rollup_inclusive_lines(
            [float(l.line_total or 0) for l in lines], new_rates, float(doc.discount or 0),
        )
        number = getattr(doc, "number", None) or doc.id
        print(f"{label} {number}: tax {doc.tax_total} -> {tax_total}, subtotal {doc.subtotal} -> {subtotal}")
        fixed += 1
        if apply:
            for line, rate in zip(lines, new_rates):
                line.tax_rate = rate
            doc.subtotal = subtotal
            doc.tax_total = tax_total
    return fixed


async def run(apply: bool, include_invoices: bool) -> None:
    async with get_async_session()() as db:
        org = (await db.execute(select(Organisation))).scalars().first()
        org_gstin = _norm(org.gstin) if org else ""
        total = 0
        total += await _repair(db, Quotation, "Quote", org_gstin, apply)
        total += await _repair(db, SalesOrder, "Order", org_gstin, apply)
        if include_invoices:
            total += await _repair(db, SaleInvoice, "Invoice", org_gstin, apply)
        if apply:
            await db.commit()
        print(f"{total} document(s) {'repaired' if apply else 'would be repaired (dry run)'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--include-invoices", action="store_true")
    args = parser.parse_args()
    asyncio.run(run(args.apply, args.include_invoices))
