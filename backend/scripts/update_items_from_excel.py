#!/usr/bin/env python3
"""Update existing ``items`` rows from an Item Master Excel export, matched by SKU.

Rows whose SKU is not already in the database are reported and skipped; nothing
is inserted. Opening stock and branch columns are not item attributes and are
ignored.

A blank text or price cell in the workbook is written as NULL. Text values have leading and
trailing spaces removed, and are otherwise stored as they appear in the workbook. A blank Name skips that row because the database
does not allow a NULL name. A blank Active, Batch Tracking or Expiry Tracking cell is written as
False. Selling, Wholesale and Staff prices in the workbook are GST-exclusive, but the app stores
GST-inclusive prices, so they are converted to price x (1 + Tax Rate / 100). Cost Price has no
GST and is stored as-is. is_packaging and packaging_quantity are not in the workbook and are
never changed.

Examples (run from backend/):

    python scripts/update_items_from_excel.py ../ItemMaster_2026-10-08_1.xlsx
    python scripts/update_items_from_excel.py ../ItemMaster_2026-10-08_1.xlsx --apply

Without --apply every row is evaluated and then rolled back, so the default run is a
safe preview. The database URL comes from --database-url or the DATABASE_URL variable.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import openpyxl
from sqlalchemy import MetaData, Table, create_engine, select
from sqlalchemy.engine import Connection

# Excel header (case-insensitive) -> column on the items table.
HEADER_TO_FIELD = {
    "name": "name",
    "barcode": "barcode",
    "category": "category",
    "brand": "brand",
    "unit": "unit",
    "packing": "packaging",
    "cost price": "cost_price",
    "selling price": "selling_price",
    "wholesale rate": "wholesale_price",
    "staff rate": "staff_price",
    "tax rate": "tax_rate",
    "reorder level": "reorder_level",
    "batch tracking": "batch_tracking",
    "expiry tracking": "expiry_tracking",
    "active": "active",
}
SKU_HEADER = "sku"
TRUE_STRINGS = {"1", "true", "yes", "y"}
FALSE_STRINGS = {"0", "false", "no", "n"}


@dataclass
class ExcelRow:
    row_number: int
    sku: str | None
    values: dict[str, Any]


@dataclass
class Report:
    excel_rows: int = 0
    updated: int = 0
    unchanged: int = 0
    categories_created: list[str] = field(default_factory=list)
    field_counts: Counter = field(default_factory=Counter)
    change_lines: list[str] = field(default_factory=list)
    not_found: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class _DryRunRollback(Exception):
    """Raised inside the transaction to roll back a dry run."""


def _normalize_header(value: Any) -> str:
    return str(value).strip().lower() if value is not None else ""


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _text(value: Any) -> str | None:
    """Return the cell text with leading and trailing spaces removed, or None for a blank cell."""
    if _blank(value):
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _sku_text(value: Any) -> str | None:
    if _blank(value):
        return None
    # Excel stores numeric SKUs as numbers; the DB column is text.
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value).strip()


def _number(value: Any, label: str) -> float | None:
    if _blank(value):
        return None
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a number, got {value!r}")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} is not a number: {value!r}") from None
    if not math.isfinite(number):
        raise ValueError(f"{label} is not a finite number: {value!r}")
    return number


def _flag(value: Any, label: str) -> bool | None:
    if _blank(value):
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    if text in TRUE_STRINGS:
        return True
    if text in FALSE_STRINGS:
        return False
    raise ValueError(f"{label} is not a yes/no value: {value!r}")


def _to_inclusive(price: float | None, tax_rate: float | None, label: str) -> float | None:
    """Convert a GST-exclusive workbook price to the GST-inclusive amount the app stores."""
    if price is None:
        return None
    if tax_rate is None:
        raise ValueError(f"{label} is set but Tax Rate is blank, so GST cannot be added")
    return price * (1 + tax_rate / 100)


def item_changes(values: dict[str, Any]) -> dict[str, Any]:
    """Map one Excel row to item column values. Raises ValueError for bad data."""
    name = _text(values.get("name"))
    if name is None:
        # The items.name column is NOT NULL, so a blank name cannot be written.
        raise ValueError("Name is blank")
    reorder = _number(values.get("reorder_level"), "Reorder Level")
    if reorder is not None and not reorder.is_integer():
        raise ValueError(f"Reorder Level must be a whole number: {reorder}")
    tax_rate = _number(values.get("tax_rate"), "Tax Rate")
    # Blank flags become False, matching the import route's bool(value or False).
    return {
        "name": name,
        "barcode": _text(values.get("barcode")),
        "brand": _text(values.get("brand")),
        "unit": _text(values.get("unit")),
        "packaging": _text(values.get("packaging")),
        "cost_price": _number(values.get("cost_price"), "Cost Price"),
        "selling_price": _to_inclusive(
            _number(values.get("selling_price"), "Selling Price"), tax_rate, "Selling Price"
        ),
        # Fixed wholesale/staff rates are stored as prices, not discounts (as the import route does).
        "wholesale_pricing_mode": "price",
        "wholesale_discount_pct": 0.0,
        "wholesale_price": _to_inclusive(
            _number(values.get("wholesale_price"), "Wholesale Rate"), tax_rate, "Wholesale Rate"
        ),
        "staff_pricing_mode": "price",
        "staff_discount_pct": 0.0,
        "staff_price": _to_inclusive(_number(values.get("staff_price"), "Staff Rate"), tax_rate, "Staff Rate"),
        "tax_rate": tax_rate,
        "reorder_level": int(reorder) if reorder is not None else None,
        "batch_tracking": bool(_flag(values.get("batch_tracking"), "Batch Tracking")),
        "expiry_tracking": bool(_flag(values.get("expiry_tracking"), "Expiry Tracking")),
        "active": bool(_flag(values.get("active"), "Active")),
        "category": _text(values.get("category")),
    }


def _pick_sheet(workbook, sheet_name: str | None):
    if sheet_name:
        if sheet_name not in workbook.sheetnames:
            sys.exit(f"Sheet {sheet_name!r} not found. Available: {', '.join(workbook.sheetnames)}")
        return workbook[sheet_name]
    for sheet in workbook.worksheets:
        header = next(sheet.iter_rows(max_row=1, values_only=True), ())
        if SKU_HEADER in {_normalize_header(cell) for cell in header}:
            return sheet
    sys.exit("No sheet has a SKU header in its first row; pass --sheet.")


def read_excel(path: Path, sheet_name: str | None) -> tuple[str, list[ExcelRow], int]:
    """Return (sheet title, data rows, number of ignored columns)."""
    workbook = openpyxl.load_workbook(path, data_only=True, read_only=True)
    try:
        sheet = _pick_sheet(workbook, sheet_name)
        rows = sheet.iter_rows(values_only=True)
        header = [_normalize_header(cell) for cell in next(rows, ())]
        if SKU_HEADER not in header:
            sys.exit(f"Sheet {sheet.title!r} has no SKU column.")
        missing = [h for h in HEADER_TO_FIELD if h not in header]
        if missing:
            sys.exit(f"Sheet {sheet.title!r} is missing columns: {', '.join(missing)}")
        column_index = {name: index for index, name in enumerate(header) if name}
        ignored = len([h for h in header if h and h != SKU_HEADER and h not in HEADER_TO_FIELD])

        excel_rows: list[ExcelRow] = []
        for row_number, cells in enumerate(rows, start=2):
            if all(_blank(cell) for cell in cells):
                continue

            def cell_at(header_name: str) -> Any:
                index = column_index[header_name]
                return cells[index] if index < len(cells) else None

            excel_rows.append(
                ExcelRow(
                    row_number=row_number,
                    sku=_sku_text(cell_at(SKU_HEADER)),
                    values={field_name: cell_at(h) for h, field_name in HEADER_TO_FIELD.items()},
                )
            )
        return sheet.title, excel_rows, ignored
    finally:
        workbook.close()


def normalize_database_url(raw: str) -> str:
    """Rewrite the app's async driver URLs to the sync drivers this script uses."""
    if raw.startswith("postgresql+asyncpg://"):
        return "postgresql+psycopg2://" + raw[len("postgresql+asyncpg://") :]
    if raw.startswith("sqlite+aiosqlite://"):
        return "sqlite://" + raw[len("sqlite+aiosqlite://") :]
    return raw


def _same(old: Any, new: Any) -> bool:
    if old is None or new is None:
        return old is None and new is None
    if isinstance(new, float) and isinstance(old, (int, float)) and not isinstance(old, bool):
        return math.isclose(old, new, rel_tol=0, abs_tol=1e-9)
    return old == new


def _resolve_category(
    conn: Connection,
    categories: Table,
    category_ids: dict[str, str],
    name: str | None,
    report: Report,
) -> str | None:
    if name is None:
        return None
    key = name.strip().lower()
    if key not in category_ids:
        # Mirrors the import route: unknown category names are created on the fly.
        new_id = f"cat-{uuid.uuid4().hex[:8]}"
        conn.execute(categories.insert().values(id=new_id, name=name, icon="📦"))
        category_ids[key] = new_id
        report.categories_created.append(name)
    return category_ids[key]


def sync_items(conn: Connection, excel_rows: list[ExcelRow], report: Report, verbose: bool) -> None:
    metadata = MetaData()
    items = Table("items", metadata, autoload_with=conn)
    categories = Table("categories", metadata, autoload_with=conn)

    db_items: dict[str, list[dict]] = defaultdict(list)
    for row in conn.execute(select(items)).mappings():
        if row["sku"] is not None:
            db_items[str(row["sku"]).strip()].append(dict(row))

    category_ids: dict[str, str] = {}
    for category in conn.execute(select(categories.c.id, categories.c.name)):
        category_ids.setdefault(category.name.strip().lower(), category.id)

    workbook_sku_counts = Counter(row.sku for row in excel_rows if row.sku)
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    for excel_row in excel_rows:
        where = f"row {excel_row.row_number}"
        if excel_row.sku is None:
            report.errors.append(f"{where}: SKU is blank")
            continue
        sku = excel_row.sku
        if workbook_sku_counts[sku] > 1:
            report.errors.append(f"{where}: SKU {sku} appears more than once in the workbook")
            continue
        matches = db_items.get(sku, [])
        if not matches:
            report.not_found.append(f"{where}: SKU {sku}")
            continue
        if len(matches) > 1:
            report.errors.append(f"{where}: SKU {sku} matches {len(matches)} database rows")
            continue
        try:
            changes = item_changes(excel_row.values)
        except ValueError as exc:
            report.errors.append(f"{where} (SKU {sku}): {exc}")
            continue

        if "category" in changes:
            category_name = changes.pop("category")
            changes["category_id"] = _resolve_category(conn, categories, category_ids, category_name, report)

        db_row = matches[0]
        diff = {column: new for column, new in changes.items() if not _same(db_row.get(column), new)}
        if not diff:
            report.unchanged += 1
            continue

        for column, new in diff.items():
            report.field_counts[column] += 1
            if verbose:
                report.change_lines.append(
                    f"SKU {sku} ({changes['name']}): {column}: {db_row.get(column)!r} -> {new!r}"
                )
        if "updated_at" in items.c:
            diff["updated_at"] = now
        conn.execute(items.update().where(items.c.id == db_row["id"]).values(**diff))
        report.updated += 1


def _print_report(report: Report, sheet_title: str, ignored: int, apply: bool) -> None:
    mode = "APPLIED" if apply else "DRY RUN - nothing written (pass --apply to commit)"
    print(f"Mode: {mode}")
    print(f"Sheet: {sheet_title}")
    print(f"Excel rows: {report.excel_rows}  (ignored non-item columns: {ignored})")
    print(
        f"Updated: {report.updated}  Unchanged: {report.unchanged}  "
        f"Not found: {len(report.not_found)}  Errors: {len(report.errors)}"
    )
    if report.field_counts:
        print("Field changes: " + ", ".join(f"{k}={v}" for k, v in sorted(report.field_counts.items())))
    if report.categories_created:
        print("Categories created: " + ", ".join(report.categories_created))
    for title, lines in (
        ("Changes", report.change_lines),
        ("Not found in database (skipped)", report.not_found),
        ("Errors (skipped)", report.errors),
    ):
        if lines:
            print(f"{title}:")
            for line in lines:
                print(f"  {line}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Update item rows in the database from an Excel item master, matched by SKU."
    )
    parser.add_argument("excel", type=Path, help="Path to the .xlsx file")
    parser.add_argument(
        "--database-url", default=os.getenv("DATABASE_URL"), help="SQLAlchemy URL (defaults to $DATABASE_URL)"
    )
    parser.add_argument("--sheet", help="Worksheet name (default: first sheet with a SKU header)")
    parser.add_argument(
        "--apply", action="store_true", help="Commit the changes. Without this flag the run is a dry run."
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Print every field change")
    args = parser.parse_args(argv)

    if not args.database_url:
        parser.error("provide --database-url or set DATABASE_URL")
    if not args.excel.is_file():
        parser.error(f"file not found: {args.excel}")

    sheet_title, excel_rows, ignored = read_excel(args.excel, args.sheet)
    report = Report(excel_rows=len(excel_rows))

    engine = create_engine(normalize_database_url(args.database_url))
    try:
        with engine.connect() as conn:
            try:
                with conn.begin():
                    sync_items(conn, excel_rows, report, args.verbose)
                    if not args.apply:
                        raise _DryRunRollback()
            except _DryRunRollback:
                pass
    finally:
        engine.dispose()

    _print_report(report, sheet_title, ignored, args.apply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
