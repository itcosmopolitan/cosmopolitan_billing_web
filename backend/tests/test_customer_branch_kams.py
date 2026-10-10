import asyncio
from io import BytesIO
from types import SimpleNamespace

import openpyxl
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.customer_import_worker import process_customer_import
from src.customer_kam import (
    attach_branch_kam_names,
    branch_kam_label,
    load_branch_kams,
    merge_legacy_kam,
    save_branch_kams,
)
from src.database import Base, _backfill_customer_branch_kams
from src.models import Branch, Customer, CustomerBranchKam, User


async def _build_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return engine, session_factory


async def _seed_branches_and_customer(db: AsyncSession):
    db.add_all([
        Branch(id="b1", name="Main", code="MAIN", active=True),
        Branch(id="b2", name="Second", code="SM", active=True),
        User(id="u-kam", name="Asha Kam", username="asha", hashed_password="test-hash"),
        Customer(id="c1", name="Acme", branch_id="b1", customer_code="CUST-1"),
    ])
    await db.commit()


def test_merge_legacy_kam_applies_only_to_home_branch_when_unset():
    assert merge_legacy_kam({}, "b1", "Legacy") == {"b1": "Legacy"}
    assert merge_legacy_kam({"b1": "Explicit"}, "b1", "Legacy") == {"b1": "Explicit"}
    assert merge_legacy_kam({"b2": "Other"}, None, "Legacy") == {"b2": "Other"}


def test_save_branch_kams_upserts_partially_and_clears_blank_values():
    async def scenario():
        engine, session_factory = await _build_session()
        try:
            async with session_factory() as db:
                await _seed_branches_and_customer(db)
                customer = await db.get(Customer, "c1")

                await save_branch_kams(db, customer, {"b1": "Alice", "b2": "Bob"})
                await db.commit()
                assert await load_branch_kams(db, ["c1"]) == {"c1": {"b1": "Alice", "b2": "Bob"}}

                # Branches missing from the map are untouched; blank clears that branch.
                await save_branch_kams(db, customer, {"b2": "  ", "b1": "Alicia"})
                await db.commit()
                assert await load_branch_kams(db, ["c1"]) == {"c1": {"b1": "Alicia"}}
                assert customer.key_account_manager == "Alicia"
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_attach_names_resolves_legacy_user_ids_and_labels_per_branch():
    async def scenario():
        engine, session_factory = await _build_session()
        try:
            async with session_factory() as db:
                await _seed_branches_and_customer(db)
                customer = await db.get(Customer, "c1")
                await save_branch_kams(db, customer, {"b1": "u-kam", "b2": "Walk-in Rep"})
                await db.commit()

                await attach_branch_kam_names(db, [customer])
                assert branch_kam_label(customer, "b1") == "Asha Kam"
                assert branch_kam_label(customer, "b2") == "Walk-in Rep"
                assert branch_kam_label(customer, "b9") is None
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_backfill_copies_legacy_kam_once_and_is_idempotent():
    async def scenario():
        engine, session_factory = await _build_session()
        try:
            async with session_factory() as db:
                await _seed_branches_and_customer(db)
                legacy = await db.get(Customer, "c1")
                legacy.key_account_manager = "Legacy Rep"
                await db.commit()

            async with engine.begin() as conn:
                await _backfill_customer_branch_kams(conn)
            async with engine.begin() as conn:
                await _backfill_customer_branch_kams(conn)

            async with session_factory() as db:
                rows = (await db.execute(select(CustomerBranchKam))).scalars().all()
                assert [(r.customer_id, r.branch_id, r.key_account_manager) for r in rows] == [
                    ("c1", "b1", "Legacy Rep"),
                ]
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def _import_job(branch_id: str, file_bytes: bytes):
    return SimpleNamespace(branch_id=branch_id, file_data=file_bytes)


def test_import_reads_per_branch_kam_columns_and_precedence():
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append([
        "Name", "City", "Key Account Manager", "Key Account Manager - MAIN", "Key Account Manager - SM",
    ])
    sheet.append(["Plain Only", "Male", "Plain Rep", None, "Sales Rep"])
    sheet.append(["Override", "Male", "Plain Rep", "Specific Rep", None])
    buffer = BytesIO()
    workbook.save(buffer)

    async def scenario():
        engine, session_factory = await _build_session()
        try:
            async with session_factory() as db:
                await _seed_branches_and_customer(db)
                job = _import_job("b1", buffer.getvalue())

                async def progress_callback(**_values):
                    return None

                result = await process_customer_import(job, db, progress_callback)
                assert result["created"] == 2, result
                assert result["errors"] == []

                created = (
                    await db.execute(select(Customer).where(Customer.name.in_(["Plain Only", "Override"])))
                ).scalars().all()
                by_name = {c.name: c.id for c in created}
                kams = await load_branch_kams(db, list(by_name.values()))
                assert kams[by_name["Plain Only"]] == {"b1": "Plain Rep", "b2": "Sales Rep"}
                assert kams[by_name["Override"]] == {"b1": "Specific Rep"}
        finally:
            await engine.dispose()

    asyncio.run(scenario())
