"""Read-only, plain-English reconciliation of Current Stock for one day.

Run from the backend directory:
    python3 scripts/current_stock_reconciliation.py --date YYYY-MM-DD
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import math
import sys
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src import config  # noqa: E402
from src.database import get_engine  # noqa: E402
from src.models import (  # noqa: E402
    Branch,
    GoodsReceiptNote,
    GRNLineItem,
    GRNStatus,
    InvoiceStatus,
    Item,
    ItemStock,
    SaleInvoice,
    SaleLineItem,
    SalesReturn,
    SalesReturnLineItem,
    SalesReturnStatus,
    StockMovement,
)


TOLERANCE = 0.01


def money(value: float) -> str:
    return f"{value:,.3f}"


def quantity(value: float) -> str:
    return f"{value:,.3f}"


def number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Compare opening and closing stock, received GRNs, stock movements, "
            "and the sales reports' cost-of-goods-sold calculation. This script "
            "only reads the database."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--date", required=True, type=date.fromisoformat, help="Day to check, YYYY-MM-DD")
    parser.add_argument(
        "--branch",
        help="Branch ID or exact branch name; omit to include all branches",
    )
    parser.add_argument(
        "--opening-value",
        type=float,
        help="Optional opening stock value shown in your saved report",
    )
    parser.add_argument(
        "--grn-value",
        type=float,
        help="Optional GRN value shown in your saved report",
    )
    parser.add_argument(
        "--closing-value",
        type=float,
        help="Optional closing stock value shown in your saved report",
    )
    parser.add_argument(
        "--reported-cogs",
        type=float,
        help="Optional COGS value shown in Sales Register or Category-wise report",
    )
    parser.add_argument(
        "--csv",
        type=Path,
        help="Optional path to save the complete item-by-item comparison as CSV",
    )
    return parser.parse_args()


async def resolve_branch(db: AsyncSession, requested: str | None) -> tuple[str | None, str]:
    if not requested:
        return None, "All branches"
    result = await db.execute(
        select(Branch.id, Branch.name).where(
            or_(Branch.id == requested, func.lower(Branch.name) == requested.lower())
        )
    )
    matches = result.all()
    if not matches:
        raise ValueError(f"No branch matches '{requested}'. Use a branch ID or exact branch name.")
    if len(matches) > 1:
        options = ", ".join(f"{row.name} (ID: {row.id})" for row in matches)
        raise ValueError(f"Branch name is ambiguous. Please use its ID: {options}")
    return matches[0].id, f"{matches[0].name} (ID: {matches[0].id})"


async def load_stock_items(
    db: AsyncSession,
    target_day: date,
    branch_id: str | None,
) -> list[dict[str, Any]]:
    day_end = datetime.combine(target_day + timedelta(days=1), time.min)
    opening_end = datetime.combine(target_day, time.min)
    conditions = []
    if branch_id:
        conditions.append(ItemStock.branch_id == branch_id)
    query = (
        select(
            ItemStock.item_id,
            ItemStock.branch_id,
            ItemStock.quantity,
            Item.sku,
            Item.name,
            Item.cost_price,
            Branch.name.label("branch_name"),
        )
        .join(Item, Item.id == ItemStock.item_id)
        .join(Branch, Branch.id == ItemStock.branch_id)
        .where(and_(*conditions) if conditions else True)
    )
    rows = (await db.execute(query)).all()

    if not rows:
        return []

    movement_branch_condition = [ItemStock.branch_id == branch_id] if branch_id else []
    after_opening = (
        await db.execute(
            select(
                StockMovement.item_id,
                StockMovement.branch_id,
                func.sum(StockMovement.delta),
            )
            .join(
                ItemStock,
                and_(
                    ItemStock.item_id == StockMovement.item_id,
                    ItemStock.branch_id == StockMovement.branch_id,
                ),
            )
            .where(
                *movement_branch_condition,
                StockMovement.created_at >= opening_end,
            )
            .group_by(StockMovement.item_id, StockMovement.branch_id)
        )
    ).all()
    after_closing = (
        await db.execute(
            select(
                StockMovement.item_id,
                StockMovement.branch_id,
                func.sum(StockMovement.delta),
            )
            .join(
                ItemStock,
                and_(
                    ItemStock.item_id == StockMovement.item_id,
                    ItemStock.branch_id == StockMovement.branch_id,
                ),
            )
            .where(
                *movement_branch_condition,
                StockMovement.created_at >= day_end,
            )
            .group_by(StockMovement.item_id, StockMovement.branch_id)
        )
    ).all()
    opening_changes = {(row[0], row[1]): number(row[2]) for row in after_opening}
    closing_changes = {(row[0], row[1]): number(row[2]) for row in after_closing}

    output = []
    for row in rows:
        key = (row.item_id, row.branch_id)
        current_qty = number(row.quantity)
        cost = number(row.cost_price)
        opening_qty = current_qty - opening_changes.get(key, 0)
        closing_qty = current_qty - closing_changes.get(key, 0)
        output.append(
            {
                "item_id": row.item_id,
                "branch_id": row.branch_id,
                "branch": row.branch_name,
                "sku": row.sku or "",
                "item": row.name or "",
                "unit_cost_now": cost,
                "opening_qty": opening_qty,
                "closing_qty": closing_qty,
                "opening_value": max(opening_qty, 0) * cost,
                "closing_value": max(closing_qty, 0) * cost,
            }
        )
    return output


async def load_movements(
    db: AsyncSession,
    target_day: date,
    branch_id: str | None,
) -> tuple[dict[tuple[str, str], float], list[dict[str, Any]]]:
    start = datetime.combine(target_day, time.min)
    end = start + timedelta(days=1)
    conditions = [StockMovement.created_at >= start, StockMovement.created_at < end]
    if branch_id:
        conditions.append(StockMovement.branch_id == branch_id)
    rows = (
        await db.execute(
            select(
                StockMovement.item_id,
                StockMovement.branch_id,
                StockMovement.movement_type,
                StockMovement.source_type,
                func.count(),
                func.sum(StockMovement.delta),
            )
            .where(*conditions)
            .group_by(
                StockMovement.item_id,
                StockMovement.branch_id,
                StockMovement.movement_type,
                StockMovement.source_type,
            )
            .order_by(StockMovement.movement_type, StockMovement.source_type)
        )
    ).all()
    item_delta: dict[tuple[str, str], float] = defaultdict(float)
    groups = []
    for row in rows:
        delta = number(row[5])
        item_delta[(row[0], row[1])] += delta
        groups.append(
            {
                "movement_type": row[2] or "(blank)",
                "source_type": row[3] or "(blank)",
                "count": int(row[4] or 0),
                "delta": delta,
            }
        )
    return item_delta, groups


async def load_grns(
    db: AsyncSession,
    target_day: date,
    branch_id: str | None,
) -> tuple[list[dict[str, Any]], dict[tuple[str, str], float]]:
    conditions = [
        GoodsReceiptNote.date == target_day.isoformat(),
        GoodsReceiptNote.status == GRNStatus.received,
    ]
    if branch_id:
        conditions.append(GoodsReceiptNote.branch_id == branch_id)
    grns = (
        await db.execute(
            select(
                GoodsReceiptNote.id,
                GoodsReceiptNote.number,
                GoodsReceiptNote.branch_id,
                GoodsReceiptNote.branch_name,
                GoodsReceiptNote.subtotal,
                GoodsReceiptNote.tax_total,
                GoodsReceiptNote.total,
                GRNLineItem.item_id,
                GRNLineItem.name,
                GRNLineItem.received_qty,
                GRNLineItem.cost,
                GRNLineItem.line_total,
            )
            .join(GRNLineItem, GRNLineItem.grn_id == GoodsReceiptNote.id, isouter=True)
            .where(*conditions)
            .order_by(GoodsReceiptNote.number, GRNLineItem.name)
        )
    ).all()
    docs: dict[str, dict[str, Any]] = {}
    item_value: dict[tuple[str, str], float] = defaultdict(float)
    for row in grns:
        doc = docs.setdefault(
            row.id,
            {
                "number": row.number,
                "branch": row.branch_name or row.branch_id,
                "subtotal": number(row.subtotal),
                "tax": number(row.tax_total),
                "total": number(row.total),
                "cost_extension": 0.0,
                "line_total": 0.0,
                "line_count": 0,
            },
        )
        if row.item_id:
            extension = number(row.received_qty) * number(row.cost)
            doc["cost_extension"] += extension
            doc["line_total"] += number(row.line_total)
            doc["line_count"] += 1
            item_value[(row.item_id, row.branch_id)] += extension
    return list(docs.values()), item_value


async def load_sales_cogs(
    db: AsyncSession,
    target_day: date,
    branch_id: str | None,
) -> tuple[float, float, int, int, dict[tuple[str, str], float]]:
    inv_conditions = [
        SaleInvoice.date == target_day.isoformat(),
        SaleInvoice.status != InvoiceStatus.cancelled,
    ]
    return_conditions = [
        SalesReturn.date == target_day.isoformat(),
        SalesReturn.status != SalesReturnStatus.void,
    ]
    if branch_id:
        inv_conditions.append(SaleInvoice.branch_id == branch_id)
        return_conditions.append(SalesReturn.branch_id == branch_id)

    invoice_rows = (
        await db.execute(
            select(
                SaleLineItem.item_id,
                SaleInvoice.branch_id,
                func.sum(
                    func.coalesce(Item.cost_price, 0) * func.coalesce(SaleLineItem.qty, 0)
                ),
            )
            .select_from(SaleInvoice)
            .outerjoin(SaleLineItem, SaleLineItem.invoice_id == SaleInvoice.id)
            .outerjoin(Item, Item.id == SaleLineItem.item_id)
            .where(*inv_conditions)
            .group_by(SaleLineItem.item_id, SaleInvoice.branch_id)
        )
    ).all()
    return_rows = (
        await db.execute(
            select(
                SalesReturnLineItem.item_id,
                SalesReturn.branch_id,
                func.sum(
                    func.coalesce(Item.cost_price, 0)
                    * func.coalesce(SalesReturnLineItem.return_qty, 0)
                ),
            )
            .select_from(SalesReturn)
            .join(SaleInvoice, SaleInvoice.id == SalesReturn.invoice_id)
            .outerjoin(SalesReturnLineItem, SalesReturnLineItem.return_id == SalesReturn.id)
            .outerjoin(Item, Item.id == SalesReturnLineItem.item_id)
            .where(*return_conditions)
            .group_by(SalesReturnLineItem.item_id, SalesReturn.branch_id)
        )
    ).all()
    invoice_cogs = sum(number(row[2]) for row in invoice_rows)
    returned_cost = sum(number(row[2]) for row in return_rows)
    by_item: dict[tuple[str, str], float] = defaultdict(float)
    for row in invoice_rows:
        if row[0]:
            by_item[(row[0], row[1])] += number(row[2])
    for row in return_rows:
        if row[0]:
            by_item[(row[0], row[1])] -= number(row[2])
    invoice_count = int(
        (
            await db.execute(
                select(func.count())
                .select_from(SaleInvoice)
                .where(*inv_conditions)
            )
        ).scalar()
        or 0
    )
    return_count = int(
        (
            await db.execute(
                select(func.count())
                .select_from(SalesReturn)
                .where(*return_conditions)
            )
        ).scalar()
        or 0
    )
    return invoice_cogs, returned_cost, invoice_count, return_count, by_item


async def load_date_coverage(db: AsyncSession) -> dict[str, tuple[Any, Any, int]]:
    coverage = {}
    queries = {
        "Sales documents": (
            SaleInvoice.date,
            SaleInvoice.status != InvoiceStatus.cancelled,
            SaleInvoice,
        ),
        "Sales returns": (
            SalesReturn.date,
            SalesReturn.status != SalesReturnStatus.void,
            SalesReturn,
        ),
        "Received GRNs": (
            GoodsReceiptNote.date,
            GoodsReceiptNote.status == GRNStatus.received,
            GoodsReceiptNote,
        ),
    }
    for label, (date_column, status_condition, model) in queries.items():
        row = (
            await db.execute(
                select(func.min(date_column), func.max(date_column), func.count())
                .select_from(model)
                .where(status_condition)
            )
        ).one()
        coverage[label] = (row[0], row[1], int(row[2] or 0))

    movement_row = (
        await db.execute(
            select(
                func.min(StockMovement.created_at),
                func.max(StockMovement.created_at),
                func.count(),
            )
        )
    ).one()
    coverage["Stock movements"] = (
        movement_row[0].date() if movement_row[0] else None,
        movement_row[1].date() if movement_row[1] else None,
        int(movement_row[2] or 0),
    )
    return coverage


async def run(args: argparse.Namespace) -> int:
    config.load()
    engine = get_engine()
    try:
        async with engine.connect() as connection:
            await connection.exec_driver_sql("SELECT 1")
        async with AsyncSession(engine) as db:
            branch_id, branch_label = await resolve_branch(db, args.branch)
            date_coverage = await load_date_coverage(db)
            stocks = await load_stock_items(db, args.date, branch_id)
            movement_by_item, movement_groups = await load_movements(db, args.date, branch_id)
            grn_docs, grn_by_item = await load_grns(db, args.date, branch_id)
            invoice_cogs, returned_cost, invoice_count, return_count, cogs_by_item = (
                await load_sales_cogs(db, args.date, branch_id)
            )
    finally:
        await engine.dispose()

    opening_value = sum(row["opening_value"] for row in stocks)
    closing_value = sum(row["closing_value"] for row in stocks)
    grn_cost = sum(doc["cost_extension"] for doc in grn_docs)
    report_cogs = invoice_cogs - returned_cost
    inventory_formula_cogs = opening_value + grn_cost - closing_value
    movement_deltas = sum(row["delta"] for row in movement_groups)
    item_by_key = {(row["item_id"], row["branch_id"]): row for row in stocks}
    details = []
    for key in set(item_by_key) | set(movement_by_item) | set(grn_by_item) | set(cogs_by_item):
        stock = item_by_key.get(key, {})
        item_movement = movement_by_item.get(key, 0.0)
        implied_change = number(stock.get("closing_qty")) - number(stock.get("opening_qty"))
        row = {
            "item_id": key[0],
            "branch_id": key[1],
            "branch": stock.get("branch", ""),
            "sku": stock.get("sku", ""),
            "item": stock.get("item", ""),
            "unit_cost_now": number(stock.get("unit_cost_now")),
            "opening_qty": number(stock.get("opening_qty")),
            "movement_qty": item_movement,
            "closing_qty": number(stock.get("closing_qty")),
            "qty_rollforward_difference": implied_change - item_movement,
            "opening_value": number(stock.get("opening_value")),
            "grn_cost": grn_by_item.get(key, 0.0),
            "closing_value": number(stock.get("closing_value")),
            "movement_value_estimate": (
                item_movement * number(stock.get("unit_cost_now"))
            ),
            "simple_formula_cogs": (
                number(stock.get("opening_value"))
                + grn_by_item.get(key, 0.0)
                - number(stock.get("closing_value"))
            ),
            "report_cogs": cogs_by_item.get(key, 0.0),
        }
        row["simple_formula_minus_report_cogs"] = (
            row["simple_formula_cogs"] - row["report_cogs"]
        )
        row["stock_value_minus_movement_estimate"] = (
            number(stock.get("closing_value"))
            - number(stock.get("opening_value"))
            - row["movement_value_estimate"]
        )
        details.append(row)
    details.sort(key=lambda row: abs(row["simple_formula_minus_report_cogs"]), reverse=True)

    print("\nCURRENT STOCK CHECK - READ ONLY")
    print(f"Date checked: {args.date.isoformat()} (closing at end of day)")
    print(f"Branch scope: {branch_label}")
    print(f"Items / item-branch balances checked: {len(stocks):,}")
    print("\nDATES PRESENT IN THE CONFIGURED DATABASE")
    for label, (first, last, count) in date_coverage.items():
        span = f"{first} to {last}" if first and last else "no records"
        print(f"{label}: {span} ({count:,} total records)")
    sales_first, sales_last, _ = date_coverage["Sales documents"]
    if sales_first and (args.date < date.fromisoformat(str(sales_first)) or args.date > date.fromisoformat(str(sales_last))):
        print(
            "WARNING: The checked date is outside this database's sales-date range. "
            "A zero sales COGS for this date cannot verify the sales report you viewed."
        )
    elif invoice_count == 0:
        print(
            "WARNING: There are no non-cancelled sales invoices dated this day in this "
            "database. Confirm the report date and database before interpreting zero COGS."
        )
    print("\nWHAT EACH NUMBER MEANS")
    print("Opening stock value = stock value at the end of the previous day.")
    print("GRN value = received quantity × unit cost on received GRNs dated this day.")
    print("Closing stock value = stock value at the end of this day.")
    print("Simple inventory formula = opening value + GRN value - closing value.")
    print(
        "Sales report COGS = sale quantity × current item cost, minus "
        "returned quantity × current item cost (cancelled sales / void returns excluded)."
    )
    print("Stock value and sales COGS use the item's current cost, not a saved historical cost.")

    print("\nDATABASE RECONCILIATION")
    print(f"Opening stock value:             {money(opening_value)}")
    print(f"Received GRN cost extension:     {money(grn_cost)}")
    print(f"Closing stock value:             {money(closing_value)}")
    print(f"Simple inventory formula COGS:   {money(inventory_formula_cogs)}")
    print(f"Sales report COGS - invoices:    {money(invoice_cogs)} ({invoice_count:,} invoices)")
    print(f"Less returned cost:              {money(returned_cost)} ({return_count:,} returns)")
    print(f"Sales report net COGS:           {money(report_cogs)}")
    print(f"Formula minus sales report COGS: {money(inventory_formula_cogs - report_cogs)}")
    print(
        "Note: the simple formula includes every reason stock changed, but its GRN term "
        "includes only received GRNs. Adjustments, transfers, returns, write-offs, "
        "and other receipts can explain a difference."
    )

    print("\nSTOCK MOVEMENTS RECORDED ON THIS DATE")
    print(
        "Movement timestamps are grouped by their stored calendar date; document dates "
        "for sales and GRNs are reported separately."
    )
    if movement_groups:
        print(f"{'Movement type':24} {'Source':24} {'Entries':>9} {'Net qty':>16}")
        for group in movement_groups:
            print(
                f"{group['movement_type'][:24]:24} {group['source_type'][:24]:24} "
                f"{group['count']:>9,} {quantity(group['delta']):>16}"
            )
        print(f"{'All movement types':57} {quantity(movement_deltas):>16}")
    else:
        print("No stock movement entries were found for this date and branch scope.")

    print("\nRECEIVED GRNS")
    if grn_docs:
        print(f"{'GRN':18} {'Branch':24} {'Lines':>7} {'Cost x qty':>16} {'Line totals':>16} {'Subtotal':>16}")
        for doc in grn_docs:
            print(
                f"{doc['number'][:18]:18} {doc['branch'][:24]:24} "
                f"{doc['line_count']:>7,} {money(doc['cost_extension']):>16} "
                f"{money(doc['line_total']):>16} {money(doc['subtotal']):>16}"
            )
        print(
            "GRN total, cost × qty: "
            f"{money(grn_cost)}; line totals: "
            f"{money(sum(doc['line_total'] for doc in grn_docs))}; "
            f"document subtotals: {money(sum(doc['subtotal'] for doc in grn_docs))}."
        )
    else:
        print("No received GRNs dated this day were found in this branch scope.")

    quantity_mismatches = [
        row for row in details if abs(row["qty_rollforward_difference"]) > TOLERANCE
    ]
    print("\nSTOCK LEDGER CHECK")
    print(
        "For each item: closing quantity - opening quantity should equal the net "
        "stock-movement quantity for this day."
    )
    if not quantity_mismatches:
        print("PASS: no item quantity differences greater than 0.01 were found.")
    else:
        print(f"CHECK: {len(quantity_mismatches)} item/branch balances differ by more than 0.01.")
        for row in sorted(quantity_mismatches, key=lambda x: abs(x["qty_rollforward_difference"]), reverse=True)[:20]:
            print(
                f"  {row['sku'] or row['item_id']} | {row['item']} | {row['branch']}: "
                f"difference {quantity(row['qty_rollforward_difference'])}"
            )
    stock_value_movement_difference = sum(
        row["stock_value_minus_movement_estimate"] for row in details
    )
    print(
        "Closing value - opening value - movement value estimate: "
        f"{money(stock_value_movement_difference)}"
    )
    print(
        "Movement value estimate uses each item's current cost. It can differ when "
        "stock is negative because Current Stock values negative quantities at zero."
    )

    print("\nLARGEST ITEM-LEVEL DIFFERENCES")
    print(
        "These rows show where opening + this day's GRN cost - closing differs from "
        "the sales report's item-cost calculation. Other stock changes can cause this."
    )
    interesting = [
        row for row in details
        if abs(row["simple_formula_minus_report_cogs"]) > TOLERANCE
        or abs(row["qty_rollforward_difference"]) > TOLERANCE
    ]
    if not interesting:
        print("No item-level differences greater than 0.01 were found.")
    else:
        print(
            f"{'SKU / item':34} {'Open value':>15} {'GRN cost':>15} "
            f"{'Close value':>15} {'Formula COGS':>15} {'Report COGS':>15} {'Difference':>15}"
        )
        for row in interesting[:20]:
            label = (row["sku"] or row["item_id"]) + " / " + row["item"]
            print(
                f"{label[:34]:34} {money(row['opening_value']):>15} "
                f"{money(row['grn_cost']):>15} {money(row['closing_value']):>15} "
                f"{money(row['simple_formula_cogs']):>15} "
                f"{money(row['report_cogs']):>15} "
                f"{money(row['simple_formula_minus_report_cogs']):>15}"
            )
        if len(interesting) > 20:
            print(f"... plus {len(interesting) - 20:,} additional item rows.")

    supplied = {
        "opening stock value": args.opening_value,
        "GRN value": args.grn_value,
        "closing stock value": args.closing_value,
        "reported COGS": args.reported_cogs,
    }
    if all(value is not None for value in supplied.values()):
        saved_formula = args.opening_value + args.grn_value - args.closing_value
        print("\nYOUR SAVED REPORT FIGURES")
        print(f"Opening value + GRN value - closing value = {money(saved_formula)}")
        print(f"Reported COGS:                          {money(args.reported_cogs)}")
        print(f"Saved figures formula minus COGS:        {money(saved_formula - args.reported_cogs)}")
        print(
            "Compare these figures with the database reconciliation above. A difference "
            "between saved figures and the database can mean the report was run with a "
            "different branch scope, valuation date, or cost data."
        )
    elif any(value is not None for value in supplied.values()):
        missing = ", ".join(name for name, value in supplied.items() if value is None)
        print(f"\nTo compare saved report figures, also provide: {missing}.")

    if args.csv:
        args.csv.parent.mkdir(parents=True, exist_ok=True)
        columns = [
            "sku",
            "item",
            "branch",
            "unit_cost_now",
            "opening_qty",
            "movement_qty",
            "closing_qty",
            "qty_rollforward_difference",
            "opening_value",
            "grn_cost",
            "closing_value",
            "movement_value_estimate",
            "simple_formula_cogs",
            "report_cogs",
            "simple_formula_minus_report_cogs",
            "stock_value_minus_movement_estimate",
        ]
        with args.csv.open("w", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, fieldnames=columns)
            writer.writeheader()
            writer.writerows({key: row[key] for key in columns} for row in details)
        print(f"\nComplete item-by-item comparison saved to: {args.csv}")

    print(
        "\nIMPORTANT: Historical stock quantities are reconstructed from today's "
        "on-hand quantity and later movements. Historical stock value uses today's "
        "item cost. The stock report's historical Reserved value is also not a "
        "reservation snapshot from that past day."
    )
    return 0


def main() -> int:
    args = parse_args()
    values = (
        args.opening_value,
        args.grn_value,
        args.closing_value,
        args.reported_cogs,
    )
    if any(value is not None and not math.isfinite(value) for value in values):
        raise SystemExit("Money comparison values must be finite numbers.")
    try:
        return asyncio.run(run(args))
    except (ValueError, RuntimeError) as exc:
        raise SystemExit(f"Could not complete the read-only stock check: {exc}") from exc


if __name__ == "__main__":
    raise SystemExit(main())
