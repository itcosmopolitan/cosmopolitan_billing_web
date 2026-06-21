import asyncio
import json
from pathlib import Path
import sys

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.models import AuditLog, Branch, Vendor, User  # noqa: E402
from src.routes.purchases import (  # noqa: E402
    BillFromGRNIn,
    ConvertPOToBillLine,
    GRNFromPOIn,
    PurchaseOrderCreate,
    PurchaseOrderLineIn,
    create_bill_from_grn,
    create_order,
    receive_from_po,
)


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _seed(db: AsyncSession) -> None:
    db.add_all([
        Branch(id="b1", name="Main", code="MAIN"),
        Vendor(id="v1", name="Acme Vendor"),
    ])
    db.add(User(id="u-test", name="Test User", email="test@example.com", hashed_password="x", all_branches=True))
    await db.commit()


async def _run_grn_proof() -> None:
    db = await _build_session()
    try:
        await _seed(db)

        created_po = await create_order(
            PurchaseOrderCreate(
                vendor_id="v1",
                vendor_name="Acme Vendor",
                branch_id="b1",
                branch_name="Main",
                items=[
                    PurchaseOrderLineIn(
                        item_id="item-1",
                        name="PO Item",
                        qty=3,
                        cost=40,
                        tax_rate=0,
                        discount=0,
                    )
                ],
                discount=0,
                notes="PO seed for GRN",
            ),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )

        grn_resp = await receive_from_po(
            created_po["id"],
            GRNFromPOIn(
                line_receipts=[ConvertPOToBillLine(item_id="item-1")],
                notes="received",
                created_by="Staff",
            ),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )
        grn_id = grn_resp["id"]

        bill_resp = await create_bill_from_grn(
            grn_id,
            BillFromGRNIn(payment_received=False),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )
        bill_id = bill_resp["bill_id"]

        rows = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "grn",
                    AuditLog.record_id == grn_id,
                )
            )
        ).scalars().all()

        assert any(r.event_type == "created" for r in rows), "Expected GRN created event"
        assert any(r.event_type == "qty_received_recorded" for r in rows), "Expected qty_received_recorded event"
        assert any(r.event_type == "verified" for r in rows), "Expected verified event"

        link_rows = [r for r in rows if r.event_type == "linked_to_source"]
        assert len(link_rows) >= 2, "Expected linked_to_source entries for PO and purchase_bill"

        found_po_link = False
        found_bill_link = False
        for row in link_rows:
            meta = json.loads(row.event_metadata or "{}")
            if meta.get("target_record_type") == "purchase_order" and meta.get("target_record_id") == created_po["id"]:
                found_po_link = True
            if meta.get("target_record_type") == "purchase_bill" and meta.get("target_record_id") == bill_id:
                found_bill_link = True

        assert found_po_link, "Expected queryable linked_to_source metadata for purchase_order"
        assert found_bill_link, "Expected queryable linked_to_source metadata for purchase_bill"
    finally:
        await db.close()


def test_grn_activity_catalogue_links() -> None:
    asyncio.run(_run_grn_proof())


if __name__ == "__main__":
    asyncio.run(_run_grn_proof())
    print("grn_activity_catalogue_links: PASS")
