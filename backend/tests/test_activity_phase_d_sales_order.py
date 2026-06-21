import asyncio
import json
from pathlib import Path
import sys

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.models import AuditLog, Branch, SalesOrder, User  # noqa: E402
from src.routes.sales import (  # noqa: E402
    ConvertToInvoiceIn,
    SalesOrderCreate,
    SalesOrderLineIn,
    convert_order_to_invoice,
    create_order,
    update_order,
    update_order_status,
)


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _seed(db: AsyncSession) -> None:
    db.add(Branch(id="b1", name="Main", code="MAIN"))
    db.add(User(id="u-test", name="Test User", email="test@example.com", hashed_password="x", all_branches=True))
    await db.commit()


async def _run_sales_order_activity_proof() -> None:
    db = await _build_session()
    try:
        await _seed(db)

        create_res = await create_order(
            SalesOrderCreate(
                customer_name="Walk-in",
                branch_id="b1",
                branch_name="Main",
                items=[
                    SalesOrderLineIn(
                        item_id=None,
                        name="SO Item A",
                        qty=2,
                        price=50,
                        tax_rate=0,
                        discount=0,
                    )
                ],
                discount=0,
                notes="SO activity test",
            ),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )
        order_id = create_res["id"]

        await update_order(
            order_id,
            SalesOrderCreate(
                customer_name="Walk-in",
                branch_id="b1",
                branch_name="Main",
                items=[
                    SalesOrderLineIn(
                        item_id=None,
                        name="SO Item A",
                        qty=5,
                        price=65,
                        tax_rate=0,
                        discount=0,
                    )
                ],
                discount=0,
                notes="SO updated",
            ),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )

        converted = await convert_order_to_invoice(
            order_id,
            ConvertToInvoiceIn(payment_received=False, notes="convert now"),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )
        invoice_id = converted["invoice_id"]

        created_logs = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "sales_order",
                    AuditLog.record_id == order_id,
                )
            )
        ).scalars().all()
        event_types = {r.event_type for r in created_logs}
        assert "created" in event_types, "Expected created activity entry for sales_order"
        assert "confirmed" in event_types, "Expected confirmed activity entry for sales_order"
        assert "item_changed" in event_types, "Expected item_changed activity entry for sales_order"
        assert "converted" in event_types, "Expected converted activity entry for sales_order"

        item_changed = next((r for r in created_logs if r.event_type == "item_changed"), None)
        assert item_changed is not None
        item_meta = json.loads(item_changed.event_metadata or "{}")
        first_change = (item_meta.get("changes") or [])[0]
        assert first_change.get("item_name") == "SO Item A"
        structured = first_change.get("changes") or []
        qty_change = next((c for c in structured if c.get("field") == "qty"), None)
        price_change = next((c for c in structured if c.get("field") == "price"), None)
        assert qty_change == {"field": "qty", "old": 2, "new": 5}
        assert price_change == {"field": "price", "old": 50.0, "new": 65.0}

        converted_logs = [r for r in created_logs if r.event_type == "converted"]
        assert len(converted_logs) >= 1, "Expected converted entry for sales_order"
        converted_meta = json.loads(converted_logs[0].event_metadata or "{}")
        assert converted_meta.get("target_record_type") == "sales_invoice"
        assert converted_meta.get("target_record_id") == invoice_id

        cancelled_res = await create_order(
            SalesOrderCreate(
                customer_name="Walk-in",
                branch_id="b1",
                branch_name="Main",
                items=[
                    SalesOrderLineIn(
                        item_id=None,
                        name="SO Item B",
                        qty=1,
                        price=25,
                        tax_rate=0,
                        discount=0,
                    )
                ],
                discount=0,
                notes="SO cancel test",
            ),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )
        cancelled_order_id = cancelled_res["id"]
        await update_order_status(cancelled_order_id, status="cancelled", db=db, user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one())

        cancelled_logs = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "sales_order",
                    AuditLog.record_id == cancelled_order_id,
                    AuditLog.event_type == "cancelled",
                )
            )
        ).scalars().all()
        assert len(cancelled_logs) >= 1, "Expected cancelled activity entry for sales_order"

        so_row = (
            await db.execute(select(SalesOrder).where(SalesOrder.id == order_id))
        ).scalar_one()
        assert so_row.converted_invoice_id == invoice_id
    finally:
        await db.close()


def test_sales_order_activity_catalogue() -> None:
    asyncio.run(_run_sales_order_activity_proof())


if __name__ == "__main__":
    asyncio.run(_run_sales_order_activity_proof())
    print("sales_order_activity_catalogue: PASS")
