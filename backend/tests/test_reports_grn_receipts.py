"""GRN Receipts report filters and exports inventory additions by receipt date."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.database import Base  # noqa: E402
from src.column_catalog import COLUMN_CATALOG  # noqa: E402
from src.models import Branch, GoodsReceiptNote, GRNLineItem, GRNStatus, Vendor  # noqa: E402
from src.report_catalog import REPORT_CATEGORIES  # noqa: E402
from src.report_export import REPORT_EXPORT_PATHS, resolve_report_handler  # noqa: E402
from src.routes.reports import grn_receipts  # noqa: E402


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)()


async def _run_grn_receipts_report() -> None:
    db = await _build_session()
    try:
        db.add_all([
            Branch(id="b1", name="Main", code="MAIN"),
            Vendor(id="v1", name="Acme Supplies"),
            GoodsReceiptNote(
                id="grn-1",
                number="GRN-001",
                vendor_id="v1",
                vendor_name="Acme Supplies",
                branch_id="b1",
                branch_name="Main",
                purchase_order_id="po-1",
                po_number="PO-001",
                date="2026-10-10",
                status=GRNStatus.received,
            ),
            GoodsReceiptNote(
                id="grn-draft",
                number="GRN-DRAFT",
                vendor_id="v1",
                vendor_name="Acme Supplies",
                branch_id="b1",
                branch_name="Main",
                date="2026-10-10",
                status=GRNStatus.draft,
            ),
            GoodsReceiptNote(
                id="grn-old",
                number="GRN-OLD",
                vendor_id="v1",
                vendor_name="Acme Supplies",
                branch_id="b1",
                branch_name="Main",
                date="2026-09-30",
                status=GRNStatus.received,
            ),
            GRNLineItem(
                id="line-1",
                grn_id="grn-1",
                name="Rice",
                received_qty=10,
                cost=5,
                tax_rate=10,
                line_total=50,
            ),
            GRNLineItem(
                id="line-2",
                grn_id="grn-1",
                name="Lentils",
                received_qty=4,
                cost=8,
                line_total=32,
            ),
            GRNLineItem(
                id="line-draft",
                grn_id="grn-draft",
                name="Not received",
                received_qty=10,
                cost=5,
                line_total=50,
            ),
            GRNLineItem(
                id="line-old",
                grn_id="grn-old",
                name="Old stock",
                received_qty=1,
                cost=1,
                line_total=1,
            ),
        ])
        await db.commit()

        first_page = await grn_receipts(
            date_from="2026-10-01",
            date_to="2026-10-31",
            skip=0,
            limit=1,
            db=db,
        )
        second_page = await grn_receipts(
            date_from="2026-10-01",
            date_to="2026-10-31",
            skip=1,
            limit=1,
            db=db,
        )

        assert first_page["total"] == second_page["total"] == 2
        rows = first_page["items"] + second_page["items"]
        assert {row["product"] for row in rows} == {"Rice", "Lentils"}
        rice = next(row for row in rows if row["product"] == "Rice")
        assert rice["unit_cost"] == 4.55
        assert rice["line_total"] == 45.45
        assert rice["grn_id"] == "grn-1"
        assert rice["purchase_order_id"] == "po-1"
        assert all(row["grn_number"] == "GRN-001" for row in rows)
        assert all(row["status"] == "received" for row in rows)
        assert REPORT_EXPORT_PATHS["grnReceipts"] == "grn-receipts"
        assert resolve_report_handler("grnReceipts") is grn_receipts

        report = next(
            report
            for category in REPORT_CATEGORIES
            for report in category["reports"]
            if report["id"] == "grn-receipts"
        )
        assert report["api"] == "grnReceipts"
        assert {column["key"] for column in report["columns"]} >= {
            "date",
            "grn_number",
            "vendor",
            "branch",
            "product_code",
            "product",
            "quantity",
        }
        assert {
            column["label"]
            for column in report["columns"]
            if column["key"] in {"unit_cost", "line_total"}
        } == {"Unit Cost (Excl. GST)", "Line Total (Excl. GST)"}
        assert [column["id"] for column in COLUMN_CATALOG["reports.grn-receipts"]] == [
            column["key"] for column in report["columns"]
        ]
    finally:
        await db.close()


def test_grn_receipts_report():
    asyncio.run(_run_grn_receipts_report())


if __name__ == "__main__":
    test_grn_receipts_report()
    print("grn_receipts: PASS")
