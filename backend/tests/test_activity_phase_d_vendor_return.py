import asyncio
import json
from pathlib import Path
import sys

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.models import AuditLog, Branch, PurchaseBill, PurchaseLineItem, Vendor  # noqa: E402
from src.routes.purchases import (  # noqa: E402
    BulkDeleteIn,
    ReturnLine,
    VendorReturnCreate,
    bulk_delete_returns,
    create_return,
    undo_void_vendor_return,
    void_return,
)


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _seed(db: AsyncSession) -> None:
    branch = Branch(id="b1", name="Main", code="MAIN")
    vendor = Vendor(id="v1", name="Acme Vendor")
    bill = PurchaseBill(
        id="pb-vr-1",
        number="PB-VR-1001",
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        branch_id=branch.id,
        branch_name=branch.name,
        date="2026-06-20",
        subtotal=200,
        tax_total=0,
        total=200,
        paid_amount=0,
        status="pending",
    )
    line = PurchaseLineItem(
        id="pbl-vr-1",
        bill_id=bill.id,
        item_id=None,
        name="Returnable Item",
        qty=10,
        cost=20,
        tax_rate=0,
        discount=0,
        line_total=200,
    )
    db.add_all([branch, vendor, bill, line])
    await db.commit()


async def _run_vendor_return_activity_proof() -> None:
    db = await _build_session()
    try:
        await _seed(db)

        created = await create_return(
            VendorReturnCreate(
                bill_id="pb-vr-1",
                vendor_id="v1",
                reason="Damaged units",
                items=[
                    ReturnLine(
                        bill_line_id="pbl-vr-1",
                        item_id=None,
                        name="Returnable Item",
                        original_qty=10,
                        return_qty=2,
                        cost=20,
                        tax_rate=0,
                    )
                ],
                notes="vendor return activity test",
            ),
            db=db,
        )
        return_id = created["id"]

        await void_return(return_id, db=db)
        await undo_void_vendor_return(return_id, db=db)
        await bulk_delete_returns(BulkDeleteIn(ids=[return_id]), db=db)

        rows = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "vendor_return",
                    AuditLog.record_id == return_id,
                )
            )
        ).scalars().all()

        event_types = {r.event_type for r in rows}
        assert "created" in event_types, "Expected created event for vendor_return"
        assert "voided" in event_types, "Expected voided event for vendor_return"
        assert "unvoided" in event_types, "Expected unvoided event for vendor_return"
        assert "cancelled" in event_types, "Expected cancelled event for vendor_return bulk-delete"

        created_rows = [r for r in rows if r.event_type == "created"]
        assert len(created_rows) >= 1, "Expected at least one created row"
        created_meta = json.loads(created_rows[0].event_metadata or "{}")
        assert created_meta.get("target_record_type") == "purchase_bill"
        assert created_meta.get("target_record_id") == "pb-vr-1"

        cancelled_rows = [r for r in rows if r.event_type == "cancelled"]
        assert len(cancelled_rows) >= 1, "Expected at least one cancelled row"
        cancelled_meta = json.loads(cancelled_rows[0].event_metadata or "{}")
        assert cancelled_meta.get("reason") == "bulk_delete"
        assert cancelled_meta.get("target_record_type") == "purchase_bill"
        assert cancelled_meta.get("target_record_id") == "pb-vr-1"
    finally:
        await db.close()


def test_vendor_return_activity_catalogue() -> None:
    asyncio.run(_run_vendor_return_activity_proof())


if __name__ == "__main__":
    asyncio.run(_run_vendor_return_activity_proof())
    print("vendor_return_activity_catalogue: PASS")
