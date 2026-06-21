import asyncio
import json
from pathlib import Path
import sys

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.models import AuditLog, Branch, PurchaseOrder, Vendor, User  # noqa: E402
from src.routes.purchases import (  # noqa: E402
    ConvertPOToBillIn,
    PurchaseOrderCreate,
    PurchaseOrderLineIn,
    convert_order_to_bill,
    create_order,
    update_order,
)


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _seed_vendor_branch(db: AsyncSession) -> None:
    db.add_all(
        [
            Branch(id="b1", name="Main", code="MAIN"),
            Vendor(id="v1", name="Acme Vendor"),
        ]
    )
    db.add(User(id="u-test", name="Test User", email="test@example.com", hashed_password="x", all_branches=True))
    await db.commit()


async def _run_purchase_order_conversion_proof() -> None:
    db = await _build_session()
    try:
        await _seed_vendor_branch(db)

        create_res = await create_order(
            PurchaseOrderCreate(
                vendor_id="v1",
                vendor_name="Acme Vendor",
                branch_id="b1",
                branch_name="Main",
                items=[
                    PurchaseOrderLineIn(
                        item_id="item-1",
                        name="Order Item A",
                        qty=2,
                        cost=50,
                        tax_rate=0,
                        discount=0,
                    )
                ],
                discount=0,
                notes="PO for conversion test",
            ),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )
        order_id = create_res["id"]

        await update_order(
            order_id,
            PurchaseOrderCreate(
                vendor_id="v1",
                vendor_name="Acme Vendor",
                branch_id="b1",
                branch_name="Main",
                items=[
                    PurchaseOrderLineIn(
                        item_id="item-1",
                        name="Order Item A",
                        qty=5,
                        cost=65,
                        tax_rate=0,
                        discount=0,
                    )
                ],
                discount=0,
                notes="PO updated",
            ),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )

        item_changed = (
            await db.execute(
                select(AuditLog)
                .where(
                    AuditLog.record_type == "purchase_order",
                    AuditLog.record_id == order_id,
                    AuditLog.event_type == "item_changed",
                )
            )
        ).scalars().first()
        assert item_changed is not None, "Expected item_changed activity entry for purchase_order"
        item_meta = json.loads(item_changed.event_metadata or "{}")
        first_change = (item_meta.get("changes") or [])[0]
        assert first_change.get("item_name") == "Order Item A"
        structured = first_change.get("changes") or []
        qty_change = next((c for c in structured if c.get("field") == "qty"), None)
        rate_change = next((c for c in structured if c.get("field") == "rate"), None)
        assert qty_change == {"field": "qty", "old": 2, "new": 5}
        assert rate_change == {"field": "rate", "old": 50.0, "new": 65.0}

        convert_res = await convert_order_to_bill(
            order_id,
            ConvertPOToBillIn(payment_received=False, notes="convert now"),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )
        bill_id = convert_res["bill_id"]

        converted_logs = (
            await db.execute(
                select(AuditLog)
                .where(
                    AuditLog.record_type == "purchase_order",
                    AuditLog.record_id == order_id,
                    AuditLog.event_type == "converted",
                )
            )
        ).scalars().all()
        assert len(converted_logs) >= 1, "Expected converted activity entry for purchase_order"

        converted_meta_matches = []
        for log in converted_logs:
            meta = json.loads(log.event_metadata or "{}")
            if meta.get("target_record_type") == "purchase_bill" and meta.get("target_record_id") == bill_id:
                converted_meta_matches.append(log)

        assert len(converted_meta_matches) >= 1, "Expected converted metadata to include purchase_bill cross-link"

        po_row = (
            await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == order_id))
        ).scalar_one()
        assert po_row.converted_bill_id == bill_id
    finally:
        await db.close()


def test_purchase_order_converted_cross_link_metadata() -> None:
    asyncio.run(_run_purchase_order_conversion_proof())


if __name__ == "__main__":
    asyncio.run(_run_purchase_order_conversion_proof())
    print("purchase_order_converted_cross_link_metadata: PASS")
