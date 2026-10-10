import asyncio
from io import BytesIO
from types import SimpleNamespace

import openpyxl
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker
from starlette.datastructures import UploadFile

from src.customer_import_worker import process_customer_import
from src.database import Base
from src.models import AuditLog, Branch, Customer, User, Vendor
from src.routes.customers import CustomerCreate, CustomerUpdate, create_customer, delete_customer, patch_customer, update_customer
from src.routes.vendors import VendorCreate, VendorUpdate, create_vendor, delete_vendor, import_vendors, patch_vendor, update_vendor


async def _build_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return engine, session_factory


async def _seed(db: AsyncSession) -> User:
    actor = User(id="u-admin", name="Admin User", username="admin", hashed_password="test-hash", all_branches=True)
    db.add_all([
        Branch(id="b1", name="Main", code="MAIN", active=True),
        Branch(id="b2", name="Second", code="SM", active=True),
        actor,
    ])
    await db.commit()
    return actor


async def _audit_rows(db: AsyncSession, reference_id: str) -> list[AuditLog]:
    result = await db.execute(
        select(AuditLog).where(AuditLog.reference_id == reference_id).order_by(AuditLog.created_at)
    )
    return list(result.scalars().all())


def _metadata(row: AuditLog) -> dict:
    return row.metadata_ or {}


def _run(scenario):
    async def wrapper():
        engine, session_factory = await _build_session()
        try:
            async with session_factory() as db:
                await scenario(db)
        finally:
            await engine.dispose()

    asyncio.run(wrapper())


def test_customer_create_update_deactivate_delete_are_audited():
    async def scenario(db: AsyncSession):
        actor = await _seed(db)

        created = await create_customer(
            CustomerCreate(
                name="Acme", branch_id="b1", street1="1 Road", city="Chennai", country="India",
                key_account_managers={"b1": "Alice"},
            ),
            db=db, user=actor, request=None,
        )
        customer_id = created["id"]
        stored = await db.get(Customer, customer_id)
        ref = stored.customer_code or customer_id
        rows = await _audit_rows(db, ref)
        assert [r.action for r in rows] == ["Customer Created"]
        assert rows[0].module == "Sales"
        assert rows[0].user_id == actor.id
        assert _metadata(rows[0])["name"] == "Acme"

        await update_customer(
            customer_id,
            CustomerUpdate(name="Acme Ltd", key_account_manager="Bob"),
            db=db, user=actor, request=None,
        )
        rows = await _audit_rows(db, ref)
        assert rows[-1].action == "Customer Updated"
        changes = _metadata(rows[-1])["changes"]
        assert changes["name"] == {"before": "Acme", "after": "Acme Ltd"}
        assert "branch_kams" in changes
        assert _metadata(rows[-1])["updated_fields"] == sorted(changes)

        count_before_noop = len(rows)
        await update_customer(customer_id, CustomerUpdate(name="Acme Ltd"), db=db, user=actor, request=None)
        assert len(await _audit_rows(db, ref)) == count_before_noop

        await patch_customer(customer_id, CustomerUpdate(active=False), db=db, user=actor, request=None)
        rows = await _audit_rows(db, ref)
        assert rows[-1].action == "Customer Deactivated"
        assert _metadata(rows[-1])["changes"]["active"] == {"before": True, "after": False}

        await delete_customer(customer_id, db=db, user=actor, request=None)
        rows = await _audit_rows(db, ref)
        assert rows[-1].action == "Customer Deleted"
        assert await db.get(Customer, customer_id) is None

    _run(scenario)


def test_vendor_create_update_deactivate_delete_are_audited():
    async def scenario(db: AsyncSession):
        actor = await _seed(db)

        created = await create_vendor(VendorCreate(name="Supplier Co"), db=db, user=actor, request=None)
        vendor_id = created["id"]
        rows = await _audit_rows(db, vendor_id)
        assert [r.action for r in rows] == ["Vendor Created"]
        assert rows[0].module == "Purchases"
        assert _metadata(rows[0])["name"] == "Supplier Co"

        await update_vendor(vendor_id, VendorUpdate(phone="555-0100"), db=db, user=actor, request=None)
        rows = await _audit_rows(db, vendor_id)
        assert rows[-1].action == "Vendor Updated"
        assert _metadata(rows[-1])["changes"]["phone"] == {"before": None, "after": "555-0100"}

        await patch_vendor(vendor_id, VendorUpdate(active=False), db=db, user=actor, request=None)
        rows = await _audit_rows(db, vendor_id)
        assert rows[-1].action == "Vendor Deactivated"

        await patch_vendor(vendor_id, VendorUpdate(active=True), db=db, user=actor, request=None)
        rows = await _audit_rows(db, vendor_id)
        assert rows[-1].action == "Vendor Reactivated"

        await delete_vendor(vendor_id, db=db, user=actor, request=None)
        rows = await _audit_rows(db, vendor_id)
        assert rows[-1].action == "Vendor Deleted"
        assert await db.get(Vendor, vendor_id) is None

    _run(scenario)


def test_customer_import_worker_audits_each_created_row():
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(["Name", "City", "Key Account Manager - MAIN"])
    sheet.append(["Imported One", "Male", "Rep A"])
    sheet.append(["Imported Two", "Male", None])
    buffer = BytesIO()
    workbook.save(buffer)

    async def scenario(db: AsyncSession):
        await _seed(db)
        job = SimpleNamespace(id="job-1", user_id="u-admin", branch_id="b1", file_data=buffer.getvalue())

        async def progress_callback(**_values):
            return None

        result = await process_customer_import(job, db, progress_callback)
        assert result["created"] == 2

        rows = (await db.execute(select(AuditLog).where(AuditLog.action == "Customer Imported"))).scalars().all()
        assert len(rows) == 2
        for row in rows:
            meta = _metadata(row)
            assert row.module == "Sales"
            assert row.user_id == "u-admin"
            assert meta["source"] == "import"
            assert meta["import_job_id"] == "job-1"
            assert meta["name"] in {"Imported One", "Imported Two"}

    _run(scenario)


def test_vendor_import_audits_each_created_row():
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(["Name", "Contact Person", "Email"])
    sheet.append(["Vendor Alpha", "Ann", "ann@example.com"])
    sheet.append(["Vendor Beta", None, None])
    buffer = BytesIO()
    workbook.save(buffer)

    async def scenario(db: AsyncSession):
        actor = await _seed(db)
        upload = UploadFile(filename="vendors.xlsx", file=BytesIO(buffer.getvalue()))

        await import_vendors(file=upload, db=db, user=actor)

        rows = (await db.execute(select(AuditLog).where(AuditLog.action == "Vendor Imported"))).scalars().all()
        assert len(rows) == 2
        for row in rows:
            meta = _metadata(row)
            assert row.module == "Purchases"
            assert row.user_id == "u-admin"
            assert meta["source"] == "import"
            assert meta["name"] in {"Vendor Alpha", "Vendor Beta"}

    _run(scenario)
