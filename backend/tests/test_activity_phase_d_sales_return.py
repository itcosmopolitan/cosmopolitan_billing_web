import asyncio
import json
from pathlib import Path
import sys

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.models import AuditLog, Branch, Customer, SaleLineItem, SaleInvoice, User  # noqa: E402
from src.routes.sales import (  # noqa: E402
    BulkDeleteIn,
    SaleCreate,
    SalesReturnCreate,
    SalesReturnLineIn,
    bulk_delete_returns,
    create_invoice,
    create_return,
    undo_void_return,
    void_return,
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
        Customer(id="c1", name="Acme Customer", credit_balance=0),
    ])
    await db.commit()


async def _create_invoice(
    db: AsyncSession,
    *,
    number: str,
    item_name: str,
    price: float,
    actor: User,
) -> str:
    created = await create_invoice(
        SaleCreate(
            number=number,
            customer_id="c1",
            customer_name="Acme Customer",
            branch_id="b1",
            branch_name="Main",
            cashier="Staff",
            items=[
                {
                    "item_id": None,
                    "name": item_name,
                    "qty": 2,
                    "price": price,
                    "tax_rate": 0,
                }
            ],
            discount=0,
            payment_mode="cash",
            notes="sales return activity test",
        ),
        user=actor,
        db=db,
    )
    return created["id"]


async def _first_line_id(db: AsyncSession, invoice_id: str) -> str:
    line = (
        await db.execute(select(SaleLineItem).where(SaleLineItem.invoice_id == invoice_id))
    ).scalars().first()
    assert line is not None
    return line.id


async def _run_sales_return_activity_proof() -> None:
    db = await _build_session()
    try:
        await _seed(db)

        actor = User(
            id="u-sales-return-test",
            name="Sales Return Tester",
            email="sales-return-test@example.com",
            hashed_password="x",
            all_branches=True,
        )

        inv1_id = await _create_invoice(
            db,
            number="INV-SR-0001",
            item_name="Return Item A",
            price=120,
            actor=actor,
        )
        inv1_line = await _first_line_id(db, inv1_id)

        created_ret = await create_return(
            SalesReturnCreate(
                invoice_id=inv1_id,
                reason="Damaged pack",
                refund_method="cash",
                items=[
                    SalesReturnLineIn(
                        invoice_line_id=inv1_line,
                        item_id=None,
                        name="Return Item A",
                        return_qty=1,
                    )
                ],
                notes="sales return create",
                created_by="Staff",
            ),
            db=db,
        )
        ret_id = created_ret["id"]

        await void_return(ret_id, db=db)
        await undo_void_return(ret_id, db=db)

        inv2_id = await _create_invoice(
            db,
            number="INV-SR-0002",
            item_name="Return Item B",
            price=80,
            actor=actor,
        )
        inv2_line = await _first_line_id(db, inv2_id)
        created_ret_2 = await create_return(
            SalesReturnCreate(
                invoice_id=inv2_id,
                reason="Wrong size",
                refund_method="credit",
                items=[
                    SalesReturnLineIn(
                        invoice_line_id=inv2_line,
                        item_id=None,
                        name="Return Item B",
                        return_qty=1,
                    )
                ],
                notes="sales return delete",
                created_by="Staff",
            ),
            db=db,
        )
        ret_2_id = created_ret_2["id"]
        await bulk_delete_returns(BulkDeleteIn(ids=[ret_2_id]), db=db)

        rows = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "sales_return",
                    AuditLog.record_id == ret_id,
                )
            )
        ).scalars().all()
        event_types = {r.event_type for r in rows}
        assert "created" in event_types, "Expected created event for sales_return"
        assert "reason_set" in event_types, "Expected reason_set event for sales_return"
        assert "stock_returned" in event_types, "Expected stock_returned event for sales_return"
        assert "refund_issued" in event_types, "Expected refund_issued event for sales_return"
        assert "voided" in event_types, "Expected voided event for sales_return"
        assert "unvoided" in event_types, "Expected unvoided event for sales_return"

        created_row = next((r for r in rows if r.event_type == "created"), None)
        assert created_row is not None
        created_meta = json.loads(created_row.event_metadata or "{}")
        assert created_meta.get("target_record_type") == "sales_invoice"
        assert created_meta.get("target_record_id") == inv1_id

        reason_row = next((r for r in rows if r.event_type == "reason_set"), None)
        assert reason_row is not None
        reason_meta = json.loads(reason_row.event_metadata or "{}")
        assert reason_meta.get("reason") == "Damaged pack"

        stock_row = next((r for r in rows if r.event_type == "stock_returned"), None)
        assert stock_row is not None
        stock_meta = json.loads(stock_row.event_metadata or "{}")
        assert stock_meta.get("total_qty") == 1

        refund_row = next((r for r in rows if r.event_type == "refund_issued"), None)
        assert refund_row is not None
        refund_meta = json.loads(refund_row.event_metadata or "{}")
        assert refund_meta.get("refund_method") == "cash"

        cancelled_rows = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "sales_return",
                    AuditLog.record_id == ret_2_id,
                    AuditLog.event_type == "cancelled",
                )
            )
        ).scalars().all()
        assert len(cancelled_rows) >= 1, "Expected cancelled event for sales_return bulk-delete"
        cancelled_meta = json.loads(cancelled_rows[0].event_metadata or "{}")
        assert cancelled_meta.get("reason") == "bulk_delete"

        inv_row = (
            await db.execute(select(SaleInvoice).where(SaleInvoice.id == inv1_id))
        ).scalar_one()
        assert inv_row is not None
    finally:
        await db.close()


def test_sales_return_activity_catalogue() -> None:
    asyncio.run(_run_sales_return_activity_proof())


if __name__ == "__main__":
    asyncio.run(_run_sales_return_activity_proof())
    print("sales_return_activity_catalogue: PASS")
