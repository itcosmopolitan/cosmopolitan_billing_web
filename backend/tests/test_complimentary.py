import asyncio
import sys
from pathlib import Path

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.document_numbering import DEFAULT_NUMBERING  # noqa: E402
from src.models import (  # noqa: E402
    Branch,
    ComplimentaryEntry,
    Customer,
    ComplimentaryLineItem,
    DocumentNumbering,
    Item,
    ItemStock,
    Notification,
    Role,
    SaleInvoice,
    SaleLineItem,
    StockMovement,
    User,
    UserBranch,
)
from src.routes.complimentary import (  # noqa: E402
    ComplimentaryCreate,
    ComplimentaryLineIn,
    ComplimentaryReasonCreate,
    ComplimentaryReject,
    approve_complimentary,
    create_complimentary,
    create_complimentary_reason,
    delete_complimentary,
    delete_complimentary_reason,
    get_complimentary,
    list_complimentary,
    list_complimentary_reasons,
    reject_complimentary,
    submit_complimentary,
)
from src.routes.reports import complimentary_issues  # noqa: E402
from src.routes.summaries import _complimentary_summary  # noqa: E402


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _seed(db: AsyncSession) -> User:
    db.add(Branch(id="b1", name="Main", code="MAIN"))
    user = User(id="u-test", name="Test User", username="tester", email="t@example.com",
                hashed_password="x", all_branches=True)
    db.add(user)
    db.add(Item(id="i1", name="Rice 5kg", unit="Bag", cost_price=40, selling_price=75, packaging="Carton"))
    db.add(ItemStock(id="s1", item_id="i1", branch_id="b1", quantity=10))
    for entry in DEFAULT_NUMBERING:
        db.add(DocumentNumbering(**entry))
    await db.commit()
    return user


async def _stock(db: AsyncSession) -> float:
    return float((await db.execute(
        select(ItemStock.quantity).where(ItemStock.item_id == "i1", ItemStock.branch_id == "b1")
    )).scalar_one())


async def _run_complimentary_flow() -> None:
    db = await _build_session()
    try:
        user = await _seed(db)

        created = await create_complimentary(
            ComplimentaryCreate(
                reason="Sample",
                branch_id="b1",
                items=[ComplimentaryLineIn(item_id="i1", qty=3)],
                notes="Trade sample",
            ),
            request=None,
            db=db,
            user=user,
        )
        assert created["number"].startswith("CMP-"), created
        assert created["cost_value"] == 120.0

        assert await _stock(db) == 7

        movement = (await db.execute(
            select(StockMovement).where(StockMovement.source_type == "complimentary_entry")
        )).scalar_one()
        assert movement.movement_type == "complimentary"
        assert movement.delta == -3

        line = (await db.execute(select(ComplimentaryLineItem))).scalar_one()
        assert line.cost_price == 40
        assert line.cost_total == 120

        assert (await db.execute(select(func.count(SaleInvoice.id)))).scalar() == 0
        assert (await db.execute(select(func.count(SaleLineItem.id)))).scalar() == 0

        detail = await get_complimentary(created["id"], db=db, user=user)
        assert detail["reason"] == "Sample"
        assert detail["taxable_amount"] == 0.0
        assert detail["total"] == 0.0
        assert detail["items"][0]["cost_price"] == 40
        assert detail["items"][0]["unit"] == "Bag"
        assert detail["items"][0]["packaging"] == "Carton"

        listing = await list_complimentary(
            branch_id=None, reason=None, search=None, date_from=None, date_to=None,
            skip=0, limit=50, db=db, user=user,
        )
        assert listing["total"] == 1

        deleted = await delete_complimentary(created["id"], request=None, db=db, user=user)
        assert deleted["restored_qty"] == 3
        assert await _stock(db) == 10
        restore = (await db.execute(
            select(StockMovement).where(StockMovement.movement_type == "complimentary_reversal")
        )).scalar_one()
        assert restore.delta == 3
        assert (await db.execute(select(func.count(ComplimentaryEntry.id)))).scalar() == 0
        assert (await db.execute(select(func.count(ComplimentaryLineItem.id)))).scalar() == 0
    finally:
        await db.close()


async def _run_complimentary_list_sort_and_filter() -> None:
    db = await _build_session()
    try:
        user = await _seed(db)
        db.add(Customer(id="c1", name="Acme Traders"))
        await db.commit()

        sample = await create_complimentary(
            ComplimentaryCreate(reason="Sample", branch_id="b1",
                                items=[ComplimentaryLineIn(item_id="i1", qty=1)]),
            request=None, db=db, user=user,
        )
        gift = await create_complimentary(
            ComplimentaryCreate(reason="Complimentary", branch_id="b1", customer_id="c1",
                                items=[ComplimentaryLineIn(item_id="i1", qty=3)]),
            request=None, db=db, user=user,
        )

        async def ids(**kwargs):
            base = dict(branch_id=None, reason=None, search=None, customer_id=None,
                        date_from=None, date_to=None, sort_by=None, sort_order="desc",
                        skip=0, limit=50, db=db, user=user)
            base.update(kwargs)
            return [row["id"] for row in (await list_complimentary(**base))["items"]]

        assert await ids(sort_by="total", sort_order="asc") == [sample["id"], gift["id"]]
        assert await ids(sort_by="total", sort_order="desc") == [gift["id"], sample["id"]]
        assert await ids(reason="Complimentary") == [gift["id"]]
        assert await ids(customer_id="c1") == [gift["id"]]
        assert len(await ids(sort_by="not_a_column")) == 2
    finally:
        await db.close()


async def _run_complimentary_child_counter() -> None:
    db = await _build_session()
    try:
        user = await _seed(db)
        branch = await db.get(Branch, "b1")
        branch.has_child_counters = True
        branch.child_counters = [
            {"id": "cc1", "name": "Counter 1"},
            {"id": "cc2", "name": "Counter 2"},
        ]
        await db.commit()

        def payload(**kwargs):
            return ComplimentaryCreate(
                reason="Sample", branch_id="b1",
                items=[ComplimentaryLineIn(item_id="i1", qty=1)], **kwargs,
            )

        for bad in ({}, {"child_counter_id": "cc9"}):
            try:
                await create_complimentary(payload(**bad), request=None, db=db, user=user)
            except HTTPException as exc:
                assert exc.status_code == 400
            else:
                raise AssertionError(f"expected 400 for {bad}")

        saved = await create_complimentary(
            payload(child_counter_id="cc1"), request=None, db=db, user=user,
        )
        entry = await get_complimentary(saved["id"], db=db, user=user)
        assert entry["child_counter_id"] == "cc1"
        assert entry["child_counter_name"] == "Counter 1"

        other = await create_complimentary(
            payload(child_counter_id="cc2"), request=None, db=db, user=user,
        )

        async def ids(**kwargs):
            base = dict(branch_id=None, reason=None, search=None, customer_id=None,
                        child_counter_id=None, date_from=None, date_to=None, sort_by=None,
                        sort_order="desc", skip=0, limit=50, db=db, user=user)
            base.update(kwargs)
            return sorted(row["id"] for row in (await list_complimentary(**base))["items"])

        assert await ids(child_counter_id="cc1") == [saved["id"]]
        assert await ids(child_counter_id="cc2") == [other["id"]]
        assert len(await ids()) == 2
    finally:
        await db.close()


def test_complimentary_child_counter() -> None:
    asyncio.run(_run_complimentary_child_counter())


def test_complimentary_list_sort_and_filter() -> None:
    asyncio.run(_run_complimentary_list_sort_and_filter())


def test_complimentary_stock_flow() -> None:
    asyncio.run(_run_complimentary_flow())


async def _run_complimentary_custom_reasons() -> None:
    db = await _build_session()
    try:
        user = await _seed(db)

        assert (await list_complimentary_reasons(branch_id="b1", db=db, user=user))["reasons"] == [
            "Complimentary", "Sample",
        ]

        added = await create_complimentary_reason(
            ComplimentaryReasonCreate(branch_id="b1", reason="  Staff tasting  "),
            request=None, db=db, user=user,
        )
        assert added["reason"] == "Staff tasting"
        assert (await list_complimentary_reasons(branch_id="b1", db=db, user=user))["reasons"] == [
            "Complimentary", "Sample", "Staff tasting",
        ]

        for duplicate in ("staff TASTING", "sample"):
            try:
                await create_complimentary_reason(
                    ComplimentaryReasonCreate(branch_id="b1", reason=duplicate),
                    request=None, db=db, user=user,
                )
            except HTTPException as exc:
                assert exc.status_code == 400
            else:
                raise AssertionError(f"duplicate reason {duplicate!r} was accepted")

        try:
            ComplimentaryReasonCreate(branch_id="b1", reason="   ")
        except ValidationError:
            pass
        else:
            raise AssertionError("blank reason was accepted")

        created = await create_complimentary(
            ComplimentaryCreate(
                reason="Staff tasting",
                branch_id="b1",
                items=[ComplimentaryLineIn(item_id="i1", qty=1)],
            ),
            request=None,
            db=db,
            user=user,
        )
        detail = await get_complimentary(created["id"], db=db, user=user)
        assert detail["reason"] == "Staff tasting"

        listing = await list_complimentary(
            branch_id=None, reason="Staff tasting", search=None, date_from=None, date_to=None,
            skip=0, limit=50, db=db, user=user,
        )
        assert [row["id"] for row in listing["items"]] == [created["id"]]
    finally:
        await db.close()


def test_complimentary_custom_reasons() -> None:
    asyncio.run(_run_complimentary_custom_reasons())


async def _run_complimentary_reason_delete() -> None:
    db = await _build_session()
    try:
        user = await _seed(db)
        await create_complimentary_reason(
            ComplimentaryReasonCreate(branch_id="b1", reason="Staff tasting"),
            request=None, db=db, user=user,
        )
        created = await create_complimentary(
            ComplimentaryCreate(
                reason="Staff tasting",
                branch_id="b1",
                items=[ComplimentaryLineIn(item_id="i1", qty=1)],
            ),
            request=None,
            db=db,
            user=user,
        )

        for builtin in ("Complimentary", "sample"):
            try:
                await delete_complimentary_reason(request=None, branch_id="b1", reason=builtin, db=db, user=user)
            except HTTPException as exc:
                assert exc.status_code == 400
            else:
                raise AssertionError(f"built-in reason {builtin!r} was deleted")

        try:
            await delete_complimentary_reason(request=None, branch_id="b1", reason="Unknown", db=db, user=user)
        except HTTPException as exc:
            assert exc.status_code == 404
        else:
            raise AssertionError("missing reason did not return 404")

        result = await delete_complimentary_reason(
            request=None, branch_id="b1", reason="  staff TASTING ", db=db, user=user,
        )
        assert result == {"message": "Reason deleted"}
        assert (await list_complimentary_reasons(branch_id="b1", db=db, user=user))["reasons"] == [
            "Complimentary", "Sample",
        ]

        detail = await get_complimentary(created["id"], db=db, user=user)
        assert detail["reason"] == "Staff tasting"
    finally:
        await db.close()


def test_complimentary_reason_delete() -> None:
    asyncio.run(_run_complimentary_reason_delete())


async def _seed_approval_users(db: AsyncSession) -> dict:
    db.add(Branch(id="b1", name="Main", code="MAIN"))
    db.add(Role(id="role-creator", key="creator", label="Creator",
                permissions=["invoices.create", "invoices.view"]))
    db.add(Role(id="role-approver", key="approver", label="Approver",
                permissions=["invoices.create", "invoices.view", "complimentary.approve"]))
    db.add(Item(id="i1", name="Rice 5kg", unit="Bag", cost_price=40, selling_price=75, packaging="Carton"))
    db.add(ItemStock(id="s1", item_id="i1", branch_id="b1", quantity=10))
    for entry in DEFAULT_NUMBERING:
        db.add(DocumentNumbering(**entry))
    creator = User(id="u-creator", name="Creator User", username="creator", email="c@example.com",
                   hashed_password="x", role_id="role-creator", all_branches=False)
    approver = User(id="u-approver", name="Approver User", username="approver", email="a@example.com",
                    hashed_password="x", role_id="role-approver", all_branches=False)
    db.add_all([creator, approver])
    db.add_all([UserBranch(user_id="u-creator", branch_id="b1"),
                UserBranch(user_id="u-approver", branch_id="b1")])
    await db.commit()
    return {"creator": creator, "approver": approver}


async def _draft(db: AsyncSession, user: User, qty: int = 3) -> dict:
    return await create_complimentary(
        ComplimentaryCreate(reason="Sample", branch_id="b1",
                            items=[ComplimentaryLineIn(item_id="i1", qty=qty)]),
        request=None, db=db, user=user,
    )


async def _run_complimentary_approval_approve() -> None:
    db = await _build_session()
    try:
        users = await _seed_approval_users(db)
        creator, approver = users["creator"], users["approver"]

        created = await _draft(db, creator)
        assert created["status"] == "draft", created
        assert await _stock(db) == 10
        assert (await db.execute(select(func.count(StockMovement.id)))).scalar() == 0

        submitted = await submit_complimentary(created["id"], request=None, db=db, user=creator)
        assert submitted["status"] == "pending", submitted
        assert await _stock(db) == 10
        pending_row = (await db.execute(
            select(Notification).where(Notification.dedupe_key == f"approval.complimentary_pending:{created['id']}")
        )).scalar_one()
        assert pending_row.resolved_at is None

        try:
            await approve_complimentary(created["id"], request=None, db=db, user=creator)
        except HTTPException as exc:
            assert exc.status_code == 403
        else:
            raise AssertionError("creator approved their own entry")
        assert await _stock(db) == 10

        approved = await approve_complimentary(created["id"], request=None, db=db, user=approver)
        assert approved["status"] == "approved", approved
        assert approved["approved_by"] == "Approver User"
        assert await _stock(db) == 7

        movement = (await db.execute(
            select(StockMovement).where(StockMovement.source_type == "complimentary_entry")
        )).scalar_one()
        assert movement.movement_type == "complimentary"
        assert movement.delta == -3

        detail = await get_complimentary(created["id"], db=db, user=approver)
        assert detail["status"] == "approved"
        assert detail["requested_by"] == "Creator User"
        assert detail["approved_by"] == "Approver User"
        assert detail["resolved_at"] is not None
        assert detail["cost_value"] == 120.0

        await db.refresh(pending_row)
        assert pending_row.resolved_at is not None

        again = await approve_complimentary(created["id"], request=None, db=db, user=approver)
        assert again["already_processed"] is True
        assert await _stock(db) == 7
    finally:
        await db.close()


def test_complimentary_approval_approve() -> None:
    asyncio.run(_run_complimentary_approval_approve())


async def _run_complimentary_approval_reject_and_delete() -> None:
    db = await _build_session()
    try:
        users = await _seed_approval_users(db)
        creator, approver = users["creator"], users["approver"]

        rejected_entry = await _draft(db, creator)
        await submit_complimentary(rejected_entry["id"], request=None, db=db, user=creator)
        rejected = await reject_complimentary(
            rejected_entry["id"], request=None,
            body=ComplimentaryReject(rejection_notes="Not a valid sample"),
            db=db, user=approver,
        )
        assert rejected["status"] == "rejected", rejected
        assert await _stock(db) == 10
        detail = await get_complimentary(rejected_entry["id"], db=db, user=approver)
        assert detail["status"] == "rejected"
        assert detail["rejected_by"] == "Approver User"
        assert detail["rejection_notes"] == "Not a valid sample"

        try:
            await approve_complimentary(rejected_entry["id"], request=None, db=db, user=approver)
        except HTTPException as exc:
            assert exc.status_code == 400
        else:
            raise AssertionError("rejected entry was approved")

        draft = await _draft(db, creator, qty=2)
        result = await delete_complimentary(draft["id"], request=None, db=db, user=creator)
        assert result["restored_qty"] == 0
        assert await _stock(db) == 10

        pending = await _draft(db, creator, qty=4)
        await submit_complimentary(pending["id"], request=None, db=db, user=creator)
        await delete_complimentary(pending["id"], request=None, db=db, user=creator)
        assert await _stock(db) == 10
        pending_row = (await db.execute(
            select(Notification).where(Notification.dedupe_key == f"approval.complimentary_pending:{pending['id']}")
        )).scalar_one()
        assert pending_row.resolved_at is not None

        to_approve = await _draft(db, creator, qty=2)
        await submit_complimentary(to_approve["id"], request=None, db=db, user=creator)
        await approve_complimentary(to_approve["id"], request=None, db=db, user=approver)
        assert await _stock(db) == 8
        await delete_complimentary(to_approve["id"], request=None, db=db, user=approver)
        assert await _stock(db) == 10
    finally:
        await db.close()


def test_complimentary_approval_reject_and_delete() -> None:
    asyncio.run(_run_complimentary_approval_reject_and_delete())


async def _run_complimentary_direct_commit() -> None:
    db = await _build_session()
    try:
        user = await _seed(db)
        direct = await _draft_direct(db, user)
        assert direct["status"] == "approved", direct
        assert await _stock(db) == 7
    finally:
        await db.close()


async def _run_complimentary_approval_filter() -> None:
    db = await _build_session()
    try:
        users = await _seed_approval_users(db)
        draft = await _draft(db, users["creator"])
        direct_user = users["approver"]
        direct = await _draft(db, direct_user, qty=1)
        assert direct["status"] == "approved", direct
        drafts = await list_complimentary(
            branch_id=None, reason=None, status="draft", search=None, date_from=None, date_to=None,
            skip=0, limit=50, db=db, user=users["creator"],
        )
        assert [row["id"] for row in drafts["items"]] == [draft["id"]]
        await submit_complimentary(draft["id"], request=None, db=db, user=users["creator"])
        pending = await list_complimentary(
            branch_id=None, reason=None, status="pending", search=None, date_from=None, date_to=None,
            skip=0, limit=50, db=db, user=users["creator"],
        )
        assert [row["id"] for row in pending["items"]] == [draft["id"]]
    finally:
        await db.close()


async def _draft_direct(db: AsyncSession, user: User) -> dict:
    return await create_complimentary(
        ComplimentaryCreate(reason="Sample", branch_id="b1",
                            items=[ComplimentaryLineIn(item_id="i1", qty=3)]),
        request=None, db=db, user=user,
    )


def test_complimentary_direct_commit() -> None:
    asyncio.run(_run_complimentary_direct_commit())


def test_complimentary_approval_filter() -> None:
    asyncio.run(_run_complimentary_approval_filter())


async def _run_complimentary_summary_counts() -> None:
    db = await _build_session()
    try:
        users = await _seed_approval_users(db)
        creator, approver = users["creator"], users["approver"]

        await _draft(db, creator)
        pending = await _draft(db, creator)
        await submit_complimentary(pending["id"], request=None, db=db, user=creator)
        approved = await _draft(db, creator)
        await submit_complimentary(approved["id"], request=None, db=db, user=creator)
        await approve_complimentary(approved["id"], request=None, db=db, user=approver)

        counts = await _complimentary_summary(db, user=approver)
        assert counts == {"draft": 1, "pending": 1, "approved": 1, "rejected": 0, "total": 3}, counts

        scoped = await _complimentary_summary(db, user=approver, branch_id="b1")
        assert scoped == counts, scoped

        assert (await _complimentary_summary(db, user=approver, branch_id="missing"))["total"] == 0
    finally:
        await db.close()


def test_complimentary_summary_counts() -> None:
    asyncio.run(_run_complimentary_summary_counts())


async def _run_complimentary_issues_report() -> None:
    db = await _build_session()
    try:
        users = await _seed_approval_users(db)
        creator, approver = users["creator"], users["approver"]

        approved = await _draft(db, creator, qty=2)
        await submit_complimentary(approved["id"], request=None, db=db, user=creator)
        await approve_complimentary(approved["id"], request=None, db=db, user=approver)
        await _draft(db, creator)
        pending = await _draft(db, creator)
        await submit_complimentary(pending["id"], request=None, db=db, user=creator)

        def report(**kwargs):
            base = dict(branch_id=None, search=None, sort_by=None, sort_order="desc",
                        skip=0, limit=50, date_from=None, date_to=None, db=db, user=approver)
            base.update(kwargs)
            return complimentary_issues(**base)

        result = await report()
        assert result["total"] == 1, result
        row = result["items"][0]
        assert row["entry_number"] == approved["number"], row
        assert row["product"] == "Rice 5kg" and row["quantity"] == 2, row
        assert row["unit_cost"] == 40 and row["cost_value"] == 80, row
        assert row["customer"] == "Walk-in", row
        assert row["approved_by"] == "Approver User" and row["requested_by"] == "Creator User", row

        assert (await report(search="Rice"))["total"] == 1
        assert (await report(search="no-such-item"))["total"] == 0
        assert (await report(branch_id="b1"))["total"] == 1
    finally:
        await db.close()


def test_complimentary_issues_report() -> None:
    asyncio.run(_run_complimentary_issues_report())
