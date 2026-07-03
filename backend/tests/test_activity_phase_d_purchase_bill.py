import asyncio
import json
from datetime import datetime
from pathlib import Path
import sys
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base
from src.models import (  # noqa: E402
    AuditLog,
    Branch,
    PurchaseBill,
    User,
    Vendor,
    VendorPayment,
    VendorPaymentAllocation,
)
from src.routes.purchases import (  # noqa: E402
    BillLineUpdate,
    BillUpdate,
    PaymentAllocationIn,
    PurchaseCreate,
    VendorPaymentCreate,
    cancel_bill,
    create_bill,
    create_payment,
    update_bill,
    void_payment,
)


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _assert_audit_log_defaults_user_role() -> None:
    db = await _build_session()
    try:
        log = AuditLog(id="audit-default", action="test_action", detail="test detail")
        db.add(log)
        await db.commit()
        saved = await db.get(AuditLog, "audit-default")
        assert saved is not None
        assert saved.user_role == "unknown"
        assert getattr(saved, "reference_id", None) in (None, "")
    finally:
        await db.close()


def test_audit_log_defaults_user_role_when_missing() -> None:
    asyncio.run(_assert_audit_log_defaults_user_role())


async def _seed(db: AsyncSession):
    branch = Branch(id="b1", name="Main", code="MAIN")
    vendor = Vendor(id="v1", name="Acme Vendor")

    bill_cancel = PurchaseBill(
        id="pb-cancel",
        number="PB-1001",
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        branch_id=branch.id,
        branch_name=branch.name,
        date="2026-06-20",
        total=100,
        paid_amount=0,
        status="pending",
    )

    bill_payment = PurchaseBill(
        id="pb-pay",
        number="PB-1002",
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        branch_id=branch.id,
        branch_name=branch.name,
        date="2026-06-20",
        total=100,
        paid_amount=40,
        status="partial",
    )

    bill_multi_a = PurchaseBill(
        id="pb-m1",
        number="PB-2001",
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        branch_id=branch.id,
        branch_name=branch.name,
        date="2026-06-20",
        total=150,
        paid_amount=0,
        status="pending",
    )

    bill_multi_b = PurchaseBill(
        id="pb-m2",
        number="PB-2002",
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        branch_id=branch.id,
        branch_name=branch.name,
        date="2026-06-20",
        total=150,
        paid_amount=0,
        status="pending",
    )

    payment = VendorPayment(
        id="vp-1",
        number="VPAY-2026-2001",
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        branch_id=branch.id,
        branch_name=branch.name,
        date="2026-06-20",
        total_amount=40,
        payment_mode="bank_transfer",
        payment_ref="UTR-1",
        voided=False,
        created_at=datetime.utcnow(),
    )
    alloc = VendorPaymentAllocation(
        id=str(uuid4()),
        payment_id=payment.id,
        bill_id=bill_payment.id,
        bill_number=bill_payment.number,
        amount=40,
    )

    db.add_all([branch, vendor, bill_cancel, bill_payment, bill_multi_a, bill_multi_b, payment, alloc])
    db.add(User(id="u-test", name="Test User", email="test@example.com", hashed_password="x", all_branches=True))
    await db.commit()


async def _run_phase_d_proof() -> None:
    db = await _build_session()
    try:
        await _seed(db)

        actor = (await db.execute(select(User).where(User.id == 'u-test'))).scalar_one()
        await cancel_bill("pb-cancel", db=db, user=actor)
        await void_payment("vp-1", db=db, user=actor)

        status_logs = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "purchase_bill",
                    AuditLog.record_id == "pb-cancel",
                    AuditLog.event_type == "status_changed",
                )
            )
        ).scalars().all()
        assert len(status_logs) >= 1, "Expected status_changed for cancelled purchase bill"

        payment_void_logs = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "purchase_bill",
                    AuditLog.record_id == "pb-pay",
                    AuditLog.event_type == "payment_voided",
                )
            )
        ).scalars().all()
        assert len(payment_void_logs) >= 1, "Expected payment_voided for affected purchase bill"

        wrong_target_logs = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.event_type == "payment_voided",
                    AuditLog.record_id == "vp-1",
                )
            )
        ).scalars().all()
        assert len(wrong_target_logs) == 0, "payment_voided must target bill record_id, not payment id"

        await create_payment(
            VendorPaymentCreate(
                vendor_id="v1",
                payment_mode="bank_transfer",
                payment_ref="UTR-MULTI",
                allocations=[
                    PaymentAllocationIn(bill_id="pb-m1", amount=30),
                    PaymentAllocationIn(bill_id="pb-m2", amount=70),
                ],
                branch_id="b1",
                branch_name="Main",
                created_by="Staff",
            ),
            db=db,
            user=actor,
        )

        multi_logs = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "purchase_bill",
                    AuditLog.event_type == "payment_recorded",
                    AuditLog.record_id.in_(["pb-m1", "pb-m2"]),
                )
            )
        ).scalars().all()
        assert len(multi_logs) == 2, "Expected one payment_recorded entry per allocated bill"

        expected_amounts = {"pb-m1": 30.0, "pb-m2": 70.0}
        observed_amounts = {}
        for row in multi_logs:
            meta = json.loads(row.event_metadata or "{}")
            observed_amounts[row.record_id] = float(meta.get("amount") or 0)
            assert str(expected_amounts[row.record_id]) in (row.detail or "")

        assert observed_amounts == expected_amounts, "Each bill must log only its own allocated amount"
        assert 100.0 not in observed_amounts.values(), "Full payment total must not be repeated on each bill"

        created_bill = await create_bill(
            PurchaseCreate(
                vendor_id="v1",
                vendor_name="Acme Vendor",
                branch_id="b1",
                branch_name="Main",
                items=[
                    {
                        "item_id": "item-1",
                        "name": "Bill Item A",
                        "qty": 2,
                        "cost": 50,
                        "tax_rate": 0,
                        "discount": 0,
                    }
                ],
                discount=0,
                notes="seed bill",
            ),
            db=db,
            user=actor,
        )

        await update_bill(
            created_bill["id"],
            BillUpdate(
                items=[
                    BillLineUpdate(
                        item_id="item-1",
                        name="Bill Item A",
                        qty=5,
                        cost=65,
                        tax_rate=0,
                        discount=0,
                    )
                ],
                discount=0,
                notes="bill changed",
            ),
            db=db,
            user=actor,
        )

        bill_item_log = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "purchase_bill",
                    AuditLog.user_id == actor.id,
                    AuditLog.record_id == created_bill["id"],
                    AuditLog.event_type == "item_changed",
                )
            )
        ).scalars().first()
        assert bill_item_log is not None, "Expected purchase_bill item_changed entry"
        bill_meta = json.loads(bill_item_log.event_metadata or "{}")
        first_change = (bill_meta.get("changes") or [])[0]
        assert first_change.get("item_name") == "Bill Item A"
        structured = first_change.get("changes") or []
        qty_change = next((c for c in structured if c.get("field") == "qty"), None)
        rate_change = next((c for c in structured if c.get("field") == "rate"), None)
        assert qty_change == {"field": "qty", "old": 2, "new": 5}
        assert rate_change == {"field": "rate", "old": 50.0, "new": 65.0}
    finally:
        await db.close()


def test_phase_d_purchase_bill_activity_proof() -> None:
    asyncio.run(_run_phase_d_proof())


if __name__ == "__main__":
    asyncio.run(_run_phase_d_proof())
    print("phase_d_purchase_bill_activity_proof: PASS")
