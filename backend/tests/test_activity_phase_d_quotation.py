import asyncio
import json
from pathlib import Path
import sys

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.models import AuditLog, Branch, User  # noqa: E402
from src.routes.sales import (  # noqa: E402
    BulkDeleteIn,
    ConvertToInvoiceIn,
    LineItemIn,
    QuotationCreate,
    bulk_delete_quotations,
    convert_quote_to_invoice,
    convert_quote_to_order,
    create_quotation,
    update_quotation,
    update_quotation_status,
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


async def _run_quotation_activity_proof() -> None:
    db = await _build_session()
    try:
        await _seed(db)

        q1 = await create_quotation(
            QuotationCreate(
                customer_name="Walk-in",
                branch_id="b1",
                branch_name="Main",
                number="Q-ACT-0001",
                items=[
                    LineItemIn(
                        item_id=None,
                        name="Quote Item A",
                        qty=2,
                        price=50,
                        tax_rate=0,
                        line_discount=0,
                    )
                ],
                discount=0,
                notes="quotation activity test",
            ),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )
        q1_id = q1["id"]

        await update_quotation(
            q1_id,
            QuotationCreate(
                customer_name="Walk-in",
                branch_id="b1",
                branch_name="Main",
                items=[
                    LineItemIn(
                        item_id=None,
                        name="Quote Item A",
                        qty=5,
                        price=65,
                        tax_rate=0,
                        line_discount=0,
                    )
                ],
                discount=0,
                notes="quotation revised",
            ),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )

        await update_quotation_status(q1_id, status="sent", db=db, user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one())
        await update_quotation_status(q1_id, status="accepted", db=db, user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one())

        order_conv = await convert_quote_to_order(q1_id, db=db, user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one())
        order_id = order_conv["order_id"]

        q2 = await create_quotation(
            QuotationCreate(
                customer_name="Walk-in",
                branch_id="b1",
                branch_name="Main",
                number="Q-ACT-0002",
                items=[
                    LineItemIn(
                        item_id=None,
                        name="Quote Item B",
                        qty=1,
                        price=120,
                        tax_rate=0,
                        line_discount=0,
                    )
                ],
                discount=0,
                notes="quote to invoice",
            ),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )
        q2_id = q2["id"]
        invoice_conv = await convert_quote_to_invoice(
            q2_id,
            ConvertToInvoiceIn(payment_received=False, notes="convert direct"),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )
        invoice_id = invoice_conv["invoice_id"]

        q3 = await create_quotation(
            QuotationCreate(
                customer_name="Walk-in",
                branch_id="b1",
                branch_name="Main",
                number="Q-ACT-0003",
                items=[
                    LineItemIn(
                        item_id=None,
                        name="Quote Item C",
                        qty=1,
                        price=30,
                        tax_rate=0,
                        line_discount=0,
                    )
                ],
                discount=0,
                notes="quote rejected",
            ),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )
        q3_id = q3["id"]
        await update_quotation_status(q3_id, status="rejected", db=db, user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one())

        q4 = await create_quotation(
            QuotationCreate(
                customer_name="Walk-in",
                branch_id="b1",
                branch_name="Main",
                number="Q-ACT-0004",
                items=[
                    LineItemIn(
                        item_id=None,
                        name="Quote Item D",
                        qty=1,
                        price=40,
                        tax_rate=0,
                        line_discount=0,
                    )
                ],
                discount=0,
                notes="quote expired",
            ),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )
        q4_id = q4["id"]
        await update_quotation_status(q4_id, status="expired", db=db, user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one())

        q5 = await create_quotation(
            QuotationCreate(
                customer_name="Walk-in",
                branch_id="b1",
                branch_name="Main",
                number="Q-ACT-0005",
                items=[
                    LineItemIn(
                        item_id=None,
                        name="Quote Item E",
                        qty=1,
                        price=15,
                        tax_rate=0,
                        line_discount=0,
                    )
                ],
                discount=0,
                notes="quote cancelled",
            ),
            db=db,
            user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one(),
        )
        q5_id = q5["id"]
        await bulk_delete_quotations(BulkDeleteIn(ids=[q5_id]), db=db, user=(await db.execute(select(User).where(User.id == 'u-test'))).scalar_one())

        q1_logs = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "quotation",
                    AuditLog.record_id == q1_id,
                )
            )
        ).scalars().all()
        q1_events = {r.event_type for r in q1_logs}
        assert "created" in q1_events, "Expected created event for quotation"
        assert "revised" in q1_events, "Expected revised event for quotation"
        assert "sent" in q1_events, "Expected sent event for quotation"
        assert "accepted" in q1_events, "Expected accepted event for quotation"
        assert "converted" in q1_events, "Expected converted event for quotation"

        revised_row = next((r for r in q1_logs if r.event_type == "revised"), None)
        assert revised_row is not None
        revised_meta = json.loads(revised_row.event_metadata or "{}")
        first_change = (revised_meta.get("changes") or [])[0]
        assert first_change.get("item_name") == "Quote Item A"
        structured = first_change.get("changes") or []
        qty_change = next((c for c in structured if c.get("field") == "qty"), None)
        price_change = next((c for c in structured if c.get("field") == "price"), None)
        assert qty_change == {"field": "qty", "old": 2, "new": 5}
        assert price_change == {"field": "price", "old": 50.0, "new": 65.0}

        q1_converted = [r for r in q1_logs if r.event_type == "converted"]
        assert len(q1_converted) >= 1
        q1_conv_meta = json.loads(q1_converted[0].event_metadata or "{}")
        assert q1_conv_meta.get("target_record_type") == "sales_order"
        assert q1_conv_meta.get("target_record_id") == order_id

        q2_logs = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "quotation",
                    AuditLog.record_id == q2_id,
                )
            )
        ).scalars().all()
        q2_conv = next((r for r in q2_logs if r.event_type == "converted"), None)
        assert q2_conv is not None
        q2_conv_meta = json.loads(q2_conv.event_metadata or "{}")
        assert q2_conv_meta.get("target_record_type") == "sales_invoice"
        assert q2_conv_meta.get("target_record_id") == invoice_id

        q3_logs = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "quotation",
                    AuditLog.record_id == q3_id,
                    AuditLog.event_type == "rejected",
                )
            )
        ).scalars().all()
        assert len(q3_logs) >= 1, "Expected rejected event for quotation"

        q4_logs = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "quotation",
                    AuditLog.record_id == q4_id,
                    AuditLog.event_type == "expired",
                )
            )
        ).scalars().all()
        assert len(q4_logs) >= 1, "Expected expired event for quotation"

        q5_logs = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "quotation",
                    AuditLog.record_id == q5_id,
                    AuditLog.event_type == "cancelled",
                )
            )
        ).scalars().all()
        assert len(q5_logs) >= 1, "Expected cancelled event for quotation bulk-delete"
        q5_meta = json.loads(q5_logs[0].event_metadata or "{}")
        assert q5_meta.get("reason") == "bulk_delete"
    finally:
        await db.close()


def test_quotation_activity_catalogue() -> None:
    asyncio.run(_run_quotation_activity_proof())


if __name__ == "__main__":
    asyncio.run(_run_quotation_activity_proof())
    print("quotation_activity_catalogue: PASS")
