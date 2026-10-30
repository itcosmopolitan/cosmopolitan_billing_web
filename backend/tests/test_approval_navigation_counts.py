import asyncio
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.models import Branch, Notification, Role, User
from src.notifications.store import approval_counts_for_user


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return session_factory()


def test_approval_counts_are_permission_and_branch_scoped():
    async def run_test():
        db = await _build_session()
        try:
            branch_permissions = [
                "transfers.approve",
                "item_master.approve",
                "invoices.approve",
            ]
            role = Role(
                id="role-approver",
                key="approver",
                label="Approver",
                permissions=branch_permissions,
            )
            user = User(
                id="user-approver",
                name="Approver",
                email="approver@example.com",
                hashed_password="x",
                role_id=role.id,
                all_branches=True,
            )
            db.add_all([
                role,
                user,
                Branch(id="b1", name="Main", code="MAIN"),
                Branch(id="b2", name="Other", code="OTHER"),
                Notification(
                    id="transfer-b1",
                    dedupe_key="approval.transfer_pending:transfer-b1",
                    kind="approval.transfer_pending",
                    title="Transfer awaiting approval",
                    branch_id="b1",
                ),
                Notification(
                    id="transfer-b2",
                    dedupe_key="approval.transfer_pending:transfer-b2",
                    kind="approval.transfer_pending",
                    title="Transfer awaiting approval",
                    branch_id="b2",
                ),
                Notification(
                    id="transfer-own",
                    dedupe_key="approval.transfer_pending:transfer-own",
                    kind="approval.transfer_pending",
                    title="Transfer awaiting approval",
                    branch_id="b1",
                    exclude_user_name="Approver",
                ),
                Notification(
                    id="item-master",
                    dedupe_key="approval.item_master_pending:item-master",
                    kind="approval.item_master_pending",
                    title="Item awaiting approval",
                ),
                Notification(
                    id="invoice",
                    dedupe_key="approval.invoice_pending:invoice",
                    kind="approval.invoice_pending",
                    title="Invoice awaiting approval",
                    branch_id="b1",
                ),
                Notification(
                    id="adjustment",
                    dedupe_key="approval.adjustment_pending:adjustment",
                    kind="approval.adjustment_pending",
                    title="Adjustment awaiting approval",
                    branch_id="b1",
                ),
                Notification(
                    id="resolved",
                    dedupe_key="approval.transfer_pending:resolved",
                    kind="approval.transfer_pending",
                    title="Resolved transfer",
                    branch_id="b1",
                    resolved_at=datetime.utcnow(),
                ),
            ])
            await db.commit()

            counts = await approval_counts_for_user(db, user, branch_id="b1")
            assert counts["approval.transfer_pending"] == 1
            assert counts["approval.item_master_pending"] == 1
            assert counts["approval.invoice_pending"] == 1
            assert counts["approval.adjustment_pending"] == 0

            all_branch_counts = await approval_counts_for_user(db, user)
            assert all_branch_counts["approval.transfer_pending"] == 2
        finally:
            await db.close()

    asyncio.run(run_test())
