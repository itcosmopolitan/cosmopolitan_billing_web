import asyncio
from datetime import datetime
from pathlib import Path
import sys
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base
from src.models import ActivityComment, AuditLog, Branch, Role, User
from src.routes.activity import delete_comment, get_timeline, post_comment


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _seed_users_and_comment(db: AsyncSession):
    branch = Branch(id="b1", name="Main", code="MAIN")
    role_owner = Role(
        id="r-owner",
        key="owner-role",
        label="Owner",
        permissions=["comments.edit_own"],
    )
    role_staff = Role(
        id="r-staff",
        key="staff-role",
        label="Staff",
        permissions=["comments.edit_own", "history.view"],
    )

    owner = User(
        id="u-owner",
        name="Owner User",
        email="owner@example.com",
        hashed_password="x",
        role_id=role_owner.id,
        branch_id=branch.id,
    )
    attacker = User(
        id="u-staff",
        name="Staff User",
        email="staff@example.com",
        hashed_password="x",
        role_id=role_staff.id,
        branch_id=branch.id,
    )

    comment = ActivityComment(
        id=str(uuid4()),
        record_type="purchase",
        record_id="PUR-001",
        author_id=owner.id,
        body="seed comment",
        created_at=datetime.utcnow(),
    )

    db.add_all([branch, role_owner, role_staff, owner, attacker, comment])
    await db.commit()
    return owner, attacker, comment


async def _run_phase_c_proofs() -> None:
    db = await _build_session()
    try:
        _owner, attacker, comment = await _seed_users_and_comment(db)

        # Proof (1): forged client can_delete flag is ignored; server-side
        # permissions are re-derived and non-owner staff cannot delete.
        try:
            await delete_comment(comment.id, can_delete=True, user=attacker, db=db)
            raise AssertionError("Expected 403 when staff deletes another user's comment")
        except HTTPException as exc:
            assert exc.status_code == 403

        # Proof (2): excluded record_type purchase_payment is rejected.
        try:
            await get_timeline(
                record_type="purchase_payment",
                record_id="PP-001",
                limit=10,
                user=attacker,
                db=db,
            )
            raise AssertionError("Expected 400 for excluded record_type purchase_payment")
        except HTTPException as exc:
            assert exc.status_code == 400

        # Proof (3): invoice-only audit actions should be hidden from sales_invoice timelines.
        invoice_log = AuditLog(
            id=str(uuid4()),
            record_type="sales_invoice",
            record_id="INV-001",
            event_type="payment_recorded",
            action="record_invoice_payment",
            detail="Recorded payment for INV-001",
            module="sales",
            ref="INV-001",
            user_id=_owner.id,
            user_name=_owner.name,
            created_at=datetime.utcnow(),
        )
        create_log = AuditLog(
            id=str(uuid4()),
            record_type="sales_invoice",
            record_id="INV-001",
            event_type="created",
            action="create_invoice",
            detail="Created INV-001",
            module="sales",
            ref="INV-001",
            user_id=_owner.id,
            user_name=_owner.name,
            created_at=datetime.utcnow(),
        )
        status_log = AuditLog(
            id=str(uuid4()),
            record_type="sales_invoice",
            record_id="INV-001",
            event_type="status_changed",
            action="update_invoice_status",
            detail="Updated status for INV-001",
            module="sales",
            ref="INV-001",
            user_id=_owner.id,
            user_name=_owner.name,
            created_at=datetime.utcnow(),
        )
        visible_log = AuditLog(
            id=str(uuid4()),
            record_type="sales_invoice",
            record_id="INV-001",
            event_type="converted",
            action="converted",
            detail="Converted INV-001",
            module="sales",
            ref="INV-001",
            user_id=_owner.id,
            user_name=_owner.name,
            created_at=datetime.utcnow(),
        )
        db.add_all([invoice_log, create_log, status_log, visible_log])
        await db.commit()

        timeline = await get_timeline(
            record_type="sales_invoice",
            record_id="INV-001",
            limit=10,
            user=attacker,
            db=db,
        )
        event_actions = {event["action"] for event in timeline["events"] if event["kind"] == "history"}
        assert "record_invoice_payment" in event_actions
        assert "create_invoice" in event_actions
        assert "update_invoice_status" in event_actions
        assert "converted" in event_actions
    finally:
        await db.close()


def test_phase_c_security_proofs() -> None:
    asyncio.run(_run_phase_c_proofs())


if __name__ == "__main__":
    asyncio.run(_run_phase_c_proofs())
    print("phase_c_security_proofs: PASS")
