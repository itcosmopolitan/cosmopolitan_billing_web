import asyncio
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import and_, case, distinct, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import aliased, sessionmaker

from src.database import Base
from src.models import (
    AuditLog,
    Branch,
    Category,
    Customer,
    CustomerPayment,
    CustomerPaymentAllocation,
    InvoiceStatus,
    Item,
    ItemBatch,
    ItemStock,
    SaleInvoice,
    SaleLineItem,
    SalesReturn,
    SalesReturnLineItem,
    SalesReturnStatus,
    StockMovement,
    User,
)
from src.routes.dashboard import (
    _DASHBOARD_CACHE,
    DashboardFilters,
    Period,
    _activity_logs,
    _billing_payload,
    _branch_condition,
    _cache_key,
    _cached_dashboard_payload,
    _can_use_sales_mvs,
    _collection_efficiency,
    _daily_revenue_components,
    _database_supports_materialized_views,
    _hourly_heatmap,
    _inventory_payload,
    _invoice_summary,
    _kam_invoice_condition,
    _kam_snapshot_values,
    _kam_staff_options,
    _kam_unknown_uuid_condition,
    _kam_uuid_shaped,
    _line_conditions,
    _operations_payload,
    _pct_delta,
    _pending_payments,
    _reconciled_mix,
    _refund_summary,
    _return_line_conditions,
    _return_line_source,
    _returned_revenue,
    _sale_line_source,
    _sales_dashboard_payload,
    _sales_pulse_periods,
    _staff_sales,
    _stock_by_category,
)


def test_dashboard_uses_finalized_invoice_kam_snapshot_and_real_returns():
    asyncio.run(_run_dashboard_financial_filters())


def test_sales_revenue_and_bill_values_exclude_gst():
    asyncio.run(_run_sales_revenue_excludes_gst())


async def _run_sales_revenue_excludes_gst() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    try:
        async with session_factory() as db:
            db.add_all(
                [
                    Branch(id="branch-1", name="Shop Male'", code="SM"),
                    Category(id="category-1", name="Taxed category"),
                    Item(
                        id="item-taxed",
                        name="Taxed item",
                        category_id="category-1",
                        brand="Taxed brand",
                        cost_price=50,
                    ),
                    SaleInvoice(
                        id="invoice-taxed",
                        number="INV-TAXED",
                        customer_name="Walk-in",
                        branch_id="branch-1",
                        date="2026-10-05",
                        total=110,
                        paid_amount=110,
                        status=InvoiceStatus.paid,
                    ),
                    SaleLineItem(
                        id="line-taxed",
                        invoice_id="invoice-taxed",
                        item_id="item-taxed",
                        name="Taxed item",
                        qty=1,
                        line_total=110,
                        tax_rate=10,
                    ),
                    SalesReturn(
                        id="return-taxed",
                        number="CN-TAXED",
                        invoice_id="invoice-taxed",
                        invoice_number="INV-TAXED",
                        customer_name="Walk-in",
                        branch_id="branch-1",
                        date="2026-10-06",
                        total=11,
                        credited_amount=11,
                        status=SalesReturnStatus.processed,
                    ),
                    SalesReturnLineItem(
                        id="return-line-taxed",
                        return_id="return-taxed",
                        item_id="item-taxed",
                        name="Taxed item",
                        return_qty=0.1,
                        line_total=11,
                        tax_rate=10,
                    ),
                ]
            )
            await db.commit()

            filters = SimpleNamespace(
                from_date="2026-10-01",
                to="2026-10-31",
                branch_id="branch-1",
                staff_id="",
                category_id="",
                cursor_date=None,
                limit=20,
            )
            period = Period(date(2026, 10, 1), date(2026, 10, 31))
            summary = await _invoice_summary(db, filters, ["branch-1"], period)
            daily = await _daily_revenue_components(db, filters, ["branch-1"], period)
            payload = await _sales_dashboard_payload(db, filters, ["branch-1"])

            assert summary["gross_revenue"] == 110
            assert summary["returned_revenue"] == 11
            assert summary["revenue"] == pytest.approx(90)
            assert summary["average_bill_value"] == pytest.approx(90)
            assert summary["median_bill_value"] == pytest.approx(100)
            assert sum(row["sales"] for row in daily) == pytest.approx(90)
            assert payload["kpis"]["total_revenue"] == pytest.approx(90)
            assert sum(row["sales"] for row in payload["charts"]["sales_trend"]) == pytest.approx(90)
            assert sum(row["revenue"] for row in payload["charts"]["revenue_vs_profit"]) == pytest.approx(90)
            assert sum(row["revenue"] for row in payload["charts"]["category_pie"]) == pytest.approx(90)
            assert sum(row["revenue"] for row in payload["charts"]["brand_donut"]) == pytest.approx(90)
            assert sum(row["sales"] for row in payload["analytics"]["branch_wise_sales"]) == pytest.approx(90)
            assert payload["tables"]["top_products"]["items"][0]["revenue"] == pytest.approx(90)
            assert payload["tables"]["top_customers"]["items"][0]["revenue"] == pytest.approx(90)

            category_filters = SimpleNamespace(**vars(filters))
            category_filters.category_id = "category-1"
            category_payload = await _sales_dashboard_payload(
                db, category_filters, ["branch-1"]
            )
            assert category_payload["kpis"]["total_revenue"] == pytest.approx(90)
            assert sum(
                row["sales"] for row in category_payload["charts"]["sales_trend"]
            ) == pytest.approx(90)
            assert sum(
                row["revenue"] for row in category_payload["charts"]["category_pie"]
            ) == pytest.approx(90)
            assert sum(
                row["sales"]
                for row in category_payload["analytics"]["branch_wise_sales"]
            ) == pytest.approx(90)
    finally:
        await engine.dispose()


def test_dashboard_kam_staff_options_dedupe_same_person_across_id_and_name_snapshots():
    asyncio.run(_run_dashboard_kam_canonicalization())


def test_dashboard_kam_unknown_ids_duplicate_user_names_and_case_whitespace():
    asyncio.run(_run_dashboard_kam_edge_cases())


def test_stock_by_category_includes_reconciled_others_bucket():
    asyncio.run(_run_stock_by_category_others())


def test_dashboard_cache_scope_and_refresh_bypass():
    asyncio.run(_run_dashboard_cache_scope_and_refresh())


def test_sales_cache_is_scoped_per_user_and_refresh_is_throttled():
    asyncio.run(_run_sales_cache_scope_and_refresh_throttle())


def _legacy_kam_expressions():
    raw_snapshot, name_snapshot = _kam_snapshot_values()
    candidate_name = func.coalesce(name_snapshot, raw_snapshot)
    raw_user = aliased(User)
    named_user = aliased(User)
    candidate_user = aliased(User)
    count_user = aliased(User)
    raw_user_id = (
        select(raw_user.id)
        .where(raw_user.id == raw_snapshot)
        .correlate(SaleInvoice)
        .scalar_subquery()
    )
    name_user_id = (
        select(named_user.id)
        .where(named_user.id == name_snapshot)
        .correlate(SaleInvoice)
        .scalar_subquery()
    )
    matching_user_count = (
        select(func.count(count_user.id))
        .where(
            func.lower(func.trim(count_user.name))
            == func.lower(func.trim(candidate_name))
        )
        .correlate(SaleInvoice)
        .scalar_subquery()
    )
    matching_user_id = (
        select(candidate_user.id)
        .where(
            func.lower(func.trim(candidate_user.name))
            == func.lower(func.trim(candidate_name))
        )
        .limit(1)
        .correlate(SaleInvoice)
        .scalar_subquery()
    )
    unique_name_user_id = case(
        (matching_user_count == 1, matching_user_id),
        else_=None,
    )
    name_resolved_user_id = case(
        (~_kam_unknown_uuid_condition(raw_snapshot), name_user_id),
        else_=None,
    )
    unique_name_resolved_user_id = case(
        (~_kam_unknown_uuid_condition(raw_snapshot), unique_name_user_id),
        else_=None,
    )
    resolved_user_id = func.coalesce(
        raw_user_id,
        name_resolved_user_id,
        unique_name_resolved_user_id,
    )
    identity_name = case(
        (_kam_unknown_uuid_condition(raw_snapshot), raw_snapshot),
        else_=candidate_name,
    )
    identity = case(
        (resolved_user_id.is_not(None), literal("user:") + resolved_user_id),
        (
            identity_name.is_not(None),
            literal("name:") + func.lower(func.trim(identity_name)),
        ),
        else_="unassigned",
    )
    display_user = aliased(User)
    resolved_user_name = (
        select(display_user.name)
        .where(display_user.id == resolved_user_id)
        .correlate(SaleInvoice)
        .scalar_subquery()
    )
    display = func.coalesce(
        resolved_user_name,
        case(
            (
                and_(
                    resolved_user_id.is_(None),
                    or_(
                        _kam_uuid_shaped(raw_snapshot),
                        _kam_uuid_shaped(name_snapshot),
                    ),
                ),
                "Unknown KAM",
            ),
            else_=candidate_name,
        ),
        "Unassigned",
    )
    return identity, display


async def _legacy_staff_sales_reference(db, filters, allowed, period):
    conditions = _line_conditions(filters, allowed, period)
    source, sales_amount = _sale_line_source()
    identity, display = _legacy_kam_expressions()
    result = await db.execute(
        select(
            identity.label("kam_key"),
            func.min(display).label("staff"),
            func.count(distinct(SaleInvoice.id)).label("bill_count"),
            func.coalesce(func.sum(sales_amount), 0).label("sales"),
        )
        .select_from(source)
        .where(and_(*conditions))
        .group_by(identity)
    )
    sales = {
        row.kam_key: {
            "kam_key": row.kam_key,
            "staff": row.staff,
            "bill_count": int(row.bill_count or 0),
            "sales": float(row.sales or 0),
        }
        for row in result.fetchall()
    }

    return_conditions = _return_line_conditions(filters, allowed, period)
    return_source, return_amount = _return_line_source()
    return_identity, return_display = _legacy_kam_expressions()
    return_result = await db.execute(
        select(
            return_identity.label("kam_key"),
            func.min(return_display).label("staff"),
            func.coalesce(func.sum(return_amount), 0).label("returned"),
        )
        .select_from(
            return_source.join(
                SaleInvoice.__table__,
                SaleInvoice.id == SalesReturn.invoice_id,
            )
        )
        .where(and_(*return_conditions))
        .group_by(return_identity)
    )
    for row in return_result.fetchall():
        staff = sales.setdefault(
            row.kam_key,
            {
                "kam_key": row.kam_key,
                "staff": row.staff,
                "bill_count": 0,
                "sales": 0.0,
            },
        )
        staff["sales"] -= float(row.returned or 0)
    return sorted(sales.values(), key=lambda row: row["sales"], reverse=True)


async def _run_dashboard_kam_canonicalization() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    try:
        async with session_factory() as db:
            db.add_all([
                Branch(id="branch-1", name="Shop Male'", code="SM"),
                User(id="u-hanifa", name="Hanifa", hashed_password="test-hash"),
                User(id="u-ali", name="Ali", hashed_password="test-hash"),
                SaleInvoice(
                    id="invoice-id",
                    number="INV-ID",
                    branch_id="branch-1",
                    customer_name="Customer A",
                    date="2026-10-05",
                    total=100,
                    paid_amount=100,
                    status=InvoiceStatus.paid,
                    customer_key_account_manager_snapshot="u-hanifa",
                    customer_key_account_manager_name_snapshot="Hanifa",
                ),
                SaleInvoice(
                    id="invoice-name",
                    number="INV-NAME",
                    branch_id="branch-1",
                    customer_name="Customer B",
                    date="2026-10-06",
                    total=120,
                    paid_amount=120,
                    status=InvoiceStatus.paid,
                    customer_key_account_manager_snapshot="",
                    customer_key_account_manager_name_snapshot="Hanifa",
                ),
                SaleInvoice(
                    id="invoice-other",
                    number="INV-OTHER",
                    branch_id="branch-1",
                    customer_name="Customer C",
                    date="2026-10-07",
                    total=80,
                    paid_amount=80,
                    status=InvoiceStatus.paid,
                    customer_key_account_manager_snapshot="u-ali",
                    customer_key_account_manager_name_snapshot="Ali",
                ),
            ])
            await db.commit()

            filters = DashboardFilters(from_date="2026-10-01", to="2026-10-31", branch_id="branch-1")
            period = Period(date(2026, 10, 1), date(2026, 10, 31))
            options = await _kam_staff_options(db, filters, ["branch-1"], period)
            assert {option["id"]: option["name"] for option in options if option["id"] != "__unassigned__"} == {
                "u-hanifa": "Hanifa",
                "u-ali": "Ali",
            }
            count_by_id = (await db.execute(select(func.count(SaleInvoice.id)).where(_kam_invoice_condition("u-hanifa")))).scalar()
            count_by_name = (await db.execute(select(func.count(SaleInvoice.id)).where(_kam_invoice_condition("Hanifa")))).scalar()
            assert count_by_id == 2
            assert count_by_name == 2
    finally:
        await engine.dispose()


async def _run_dashboard_kam_edge_cases() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    try:
        async with session_factory() as db:
            db.add_all([
                Branch(id="branch-1", name="Shop Male'", code="SM"),
                User(id="user-shared-a", name="Shared Name", hashed_password="test-hash"),
                User(id="user-shared-b", name="Shared Name", hashed_password="test-hash"),
                User(id="user-amina", name="Amina", hashed_password="test-hash"),
                SaleInvoice(
                    id="invoice-unknown-kam",
                    number="INV-UNKNOWN",
                    branch_id="branch-1",
                    date="2026-10-01",
                    total=10,
                    status=InvoiceStatus.paid,
                    customer_key_account_manager_snapshot="123e4567-e89b-42d3-a456-426614174000",
                    customer_key_account_manager_name_snapshot="Amina",
                ),
                SaleInvoice(
                    id="invoice-shared-a",
                    number="INV-SHARED-A",
                    branch_id="branch-1",
                    date="2026-10-02",
                    total=10,
                    status=InvoiceStatus.paid,
                    customer_key_account_manager_snapshot="user-shared-a",
                    customer_key_account_manager_name_snapshot="Shared Name",
                ),
                SaleInvoice(
                    id="invoice-shared-b",
                    number="INV-SHARED-B",
                    branch_id="branch-1",
                    date="2026-10-03",
                    total=10,
                    status=InvoiceStatus.paid,
                    customer_key_account_manager_snapshot="user-shared-b",
                    customer_key_account_manager_name_snapshot="Shared Name",
                ),
                SaleInvoice(
                    id="invoice-velu",
                    number="INV-VELU",
                    branch_id="branch-1",
                    date="2026-10-04",
                    total=10,
                    status=InvoiceStatus.paid,
                    customer_key_account_manager_snapshot="Velu",
                    customer_key_account_manager_name_snapshot="Velu",
                ),
                SaleInvoice(
                    id="invoice-velu-lower",
                    number="INV-VELU-LOWER",
                    branch_id="branch-1",
                    date="2026-10-05",
                    total=10,
                    status=InvoiceStatus.paid,
                    customer_key_account_manager_snapshot="velu ",
                    customer_key_account_manager_name_snapshot=" velu",
                ),
            ])
            await db.commit()

            filters = DashboardFilters(from_date="2026-10-01", to="2026-10-31", branch_id="branch-1")
            options = await _kam_staff_options(
                db,
                filters,
                ["branch-1"],
                Period(date(2026, 10, 1), date(2026, 10, 31)),
            )
            option_by_id = {option["id"]: option["name"] for option in options}
            assert option_by_id["123e4567-e89b-42d3-a456-426614174000"] == "Unknown KAM"
            assert option_by_id["user-shared-a"] == "Shared Name (ared-a)"
            assert option_by_id["user-shared-b"] == "Shared Name (ared-b)"
            assert option_by_id["user-shared-a"] != option_by_id["user-shared-b"]
            assert sum(option["name"].casefold() == "velu" for option in options) == 1

            unknown_count = (
                await db.execute(
                    select(func.count(func.distinct(SaleInvoice.id))).where(
                        _kam_invoice_condition("123e4567-e89b-42d3-a456-426614174000")
                    )
                )
            ).scalar_one()
            amina_count = (
                await db.execute(
                    select(func.count(func.distinct(SaleInvoice.id))).where(
                        _kam_invoice_condition("user-amina")
                    )
                )
            ).scalar_one()
            assert unknown_count == 1
            assert amina_count == 0

            for staff_id in ("user-shared-a", "user-shared-b"):
                count = (
                    await db.execute(
                        select(func.count(func.distinct(SaleInvoice.id))).where(
                            _kam_invoice_condition(staff_id)
                        )
                    )
                ).scalar_one()
                assert count == 1

            velu_count = (
                await db.execute(
                    select(func.count(func.distinct(SaleInvoice.id))).where(
                        _kam_invoice_condition("Velu")
                    )
                )
            ).scalar_one()
            assert velu_count == 2
    finally:
        await engine.dispose()


async def _run_dashboard_cache_scope_and_refresh() -> None:
    from src.routes.dashboard import (
        _DASHBOARD_REFRESH_GUARD,
        _DASHBOARD_REFRESH_LOCKS,
    )

    _DASHBOARD_CACHE.clear()
    _DASHBOARD_REFRESH_GUARD.clear()
    _DASHBOARD_REFRESH_LOCKS.clear()
    base = {
        "branch_id": "branch-1",
        "from": "2026-10-01",
        "to": "2026-10-31",
        "staff_id": "kam-1",
        "category_id": "category-1",
    }
    key = _cache_key("billing", "user-1", base)
    for changed_key, changed_value in (
        ("branch_id", "branch-2"),
        ("from", "2026-09-01"),
        ("to", "2026-11-01"),
        ("staff_id", "kam-2"),
        ("category_id", "category-2"),
    ):
        changed = {**base, changed_key: changed_value}
        assert _cache_key("billing", "user-1", changed) != key
    assert _cache_key("billing", "user-1", base) != _cache_key("billing", "user-2", base)

    calls = 0

    async def loader():
        nonlocal calls
        calls += 1
        return {"calls": calls}

    first = await _cached_dashboard_payload(
        "billing", "user-1", base, 60, loader, ["branch-1"]
    )
    cached = await _cached_dashboard_payload(
        "billing", "user-1", base, 60, loader, ["branch-1"]
    )
    refreshed = await _cached_dashboard_payload(
        "billing", "user-1", base, 60, loader, ["branch-1"], bypass_cache=True
    )
    restricted_scope = await _cached_dashboard_payload(
        "billing", "user-1", base, 60, loader, ["branch-1", "branch-2"]
    )

    assert first["cache"]["hit"] is False
    assert cached["cache"]["hit"] is True
    assert refreshed["cache"]["hit"] is False
    assert restricted_scope["cache"]["key"] != first["cache"]["key"]
    assert calls == 3
    _DASHBOARD_CACHE.clear()
    _DASHBOARD_REFRESH_GUARD.clear()
    _DASHBOARD_REFRESH_LOCKS.clear()


async def _run_sales_cache_scope_and_refresh_throttle() -> None:
    from src.routes.dashboard import (
        _DASHBOARD_REFRESH_GUARD,
        _DASHBOARD_REFRESH_LOCKS,
    )

    _DASHBOARD_CACHE.clear()
    _DASHBOARD_REFRESH_GUARD.clear()
    _DASHBOARD_REFRESH_LOCKS.clear()
    filters = {
        "branch_id": "branch-1",
        "from": "2026-10-01",
        "to": "2026-10-31",
        "staff_id": "kam-1",
        "category_id": "category-1",
    }
    calls = {"user-a": 0, "user-b": 0}

    async def loader_for(user_id):
        async def loader():
            calls[user_id] += 1
            return {"loaded_for": user_id, "call": calls[user_id]}

        return loader

    first = await _cached_dashboard_payload(
        "sales",
        "user-a",
        filters,
        120,
        await loader_for("user-a"),
        ["branch-1"],
        bypass_cache=True,
    )
    throttled = await _cached_dashboard_payload(
        "sales",
        "user-a",
        filters,
        120,
        await loader_for("user-a"),
        ["branch-1"],
        bypass_cache=True,
    )
    user_b = await _cached_dashboard_payload(
        "sales",
        "user-b",
        filters,
        120,
        await loader_for("user-b"),
        ["branch-1", "branch-2"],
        bypass_cache=True,
    )

    assert first["cache"]["key"] != user_b["cache"]["key"]
    assert first["loaded_for"] == "user-a"
    assert user_b["loaded_for"] == "user-b"
    assert throttled["cache"]["hit"] is True
    assert throttled["cache"]["refresh_throttled"] is True
    assert calls == {"user-a": 1, "user-b": 1}

    guarded_key = first["cache"]["key"]
    _DASHBOARD_REFRESH_GUARD[guarded_key] = datetime.utcnow() - timedelta(seconds=11)
    refreshed = await _cached_dashboard_payload(
        "sales",
        "user-a",
        filters,
        120,
        await loader_for("user-a"),
        ["branch-1"],
        bypass_cache=True,
    )
    assert refreshed["cache"]["hit"] is False
    assert calls == {"user-a": 2, "user-b": 1}

    concurrent_calls = 0

    async def concurrent_loader():
        nonlocal concurrent_calls
        concurrent_calls += 1
        await asyncio.sleep(0.01)
        return {"calls": concurrent_calls}

    concurrent_results = await asyncio.gather(
        *(
            _cached_dashboard_payload(
                "sales",
                "user-concurrent",
                filters,
                120,
                concurrent_loader,
                ["branch-1"],
                bypass_cache=True,
            )
            for _ in range(4)
        )
    )
    assert concurrent_calls == 1
    assert sum(not result["cache"]["hit"] for result in concurrent_results) == 1
    assert sum(
        result["cache"].get("refresh_throttled") is True
        for result in concurrent_results
    ) == 3

    _DASHBOARD_CACHE.clear()
    _DASHBOARD_REFRESH_GUARD.clear()
    _DASHBOARD_REFRESH_LOCKS.clear()


async def _run_stock_by_category_others() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    try:
        async with session_factory() as db:
            for index in range(9):
                db.add_all([
                    Category(id=f"category-{index}", name=f"Category {index}"),
                    Item(
                        id=f"item-{index}",
                        name=f"Item {index}",
                        category_id=f"category-{index}",
                        cost_price=index + 1.006,
                    ),
                    ItemStock(
                        id=f"stock-{index}",
                        item_id=f"item-{index}",
                        branch_id="branch-1",
                        quantity=1,
                    ),
                ])
            await db.commit()
            filters = DashboardFilters(branch_id="branch-1")
            rows = await _stock_by_category(db, filters, ["branch-1"])
            assert len(rows) == 9
            assert rows[-1] == {"category": "Others", "value": 0.97}
            assert round(sum(row["value"] for row in rows), 2) == 45.05
    finally:
        await engine.dispose()


async def _run_dashboard_financial_filters() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    try:
        async with session_factory() as db:
            db.add_all([
                Branch(id="branch-1", name="Shop Male'", code="SM"),
                Branch(id="branch-2", name="Other Branch", code="OB"),
                User(id="kam-1", name="Amina", hashed_password="test-hash"),
                User(id="kam-2", name="Ali", hashed_password="test-hash"),
                Customer(id="customer-1", name="Customer One"),
                Category(id="category-1", name="Grocery"),
                Item(id="item-1", name="Test Item", category_id="category-1", cost_price=10),
                AuditLog(
                    id="activity-1",
                    action="Invoice created",
                    user_role="cashier",
                    branch_id="branch-1",
                    created_at=datetime(2026, 10, 5, 21, 30),
                ),
                AuditLog(
                    id="activity-2",
                    action="Invoice created",
                    user_role="cashier",
                    branch_id="branch-2",
                    created_at=datetime(2026, 10, 5, 21, 30),
                ),
                SaleInvoice(
                    id="invoice-valid",
                    number="INV-1",
                    customer_id="customer-1",
                    customer_name="Customer One",
                    branch_id="branch-1",
                    cashier="Cashier Name",
                    date="2026-10-05",
                    total=100,
                    paid_amount=20,
                    credited_amount=25,
                    status=InvoiceStatus.paid,
                    due_date="2026-10-15",
                    customer_key_account_manager_snapshot="kam-1",
                    customer_key_account_manager_name_snapshot="Amina",
                    created_at=datetime(2026, 10, 5, 21, 30),
                ),
                SaleInvoice(
                    id="invoice-unassigned",
                    number="INV-8",
                    customer_name="Unassigned",
                    branch_id="branch-1",
                    date="2026-10-06",
                    total=30,
                    paid_amount=30,
                    status=InvoiceStatus.paid,
                ),
                SaleInvoice(
                    id="invoice-kam-not-user",
                    number="INV-9",
                    customer_name="KAM snapshot not in users",
                    branch_id="branch-1",
                    date="2026-10-07",
                    total=40,
                    paid_amount=40,
                    status=InvoiceStatus.paid,
                    customer_key_account_manager_snapshot="Velu",
                    customer_key_account_manager_name_snapshot="Velu",
                ),
                SaleInvoice(
                    id="outside-short-range",
                    number="INV-6",
                    customer_name="Outside short range",
                    branch_id="branch-2",
                    date="2026-10-29",
                    total=250,
                    paid_amount=250,
                    status=InvoiceStatus.paid,
                ),
                SaleInvoice(
                    id="inside-short-range",
                    number="INV-7",
                    customer_name="Inside short range",
                    branch_id="branch-2",
                    date="2026-10-30",
                    total=50,
                    paid_amount=50,
                    status=InvoiceStatus.paid,
                ),
                SaleLineItem(
                    id="sale-line-1",
                    invoice_id="invoice-valid",
                    item_id="item-1",
                    name="Test Item",
                    qty=1,
                    line_total=100,
                ),
                SaleInvoice(
                    id="invoice-other-kam",
                    number="INV-2",
                    customer_name="Other Customer",
                    branch_id="branch-1",
                    date="2026-10-05",
                    total=500,
                    paid_amount=500,
                    status=InvoiceStatus.paid,
                    customer_key_account_manager_snapshot="kam-2",
                    customer_key_account_manager_name_snapshot="Ali",
                ),
                SaleInvoice(
                    id="invoice-draft",
                    number="INV-3",
                    customer_name="Draft",
                    branch_id="branch-1",
                    date="2026-10-05",
                    total=900,
                    paid_amount=0,
                    status=InvoiceStatus.draft,
                    customer_key_account_manager_snapshot="kam-1",
                ),
                SaleInvoice(
                    id="invoice-cancelled",
                    number="INV-4",
                    customer_name="Cancelled",
                    branch_id="branch-1",
                    date="2026-10-05",
                    total=700,
                    paid_amount=0,
                    status=InvoiceStatus.cancelled,
                    customer_key_account_manager_snapshot="kam-1",
                ),
                SaleInvoice(
                    id="invoice-pending-approval",
                    number="INV-5",
                    customer_name="Awaiting approval",
                    branch_id="branch-1",
                    date="2026-10-05",
                    total=300,
                    paid_amount=0,
                    status=InvoiceStatus.pending_approval,
                    customer_key_account_manager_snapshot="kam-1",
                ),
                SalesReturn(
                    id="return-processed",
                    number="CN-1",
                    invoice_id="invoice-valid",
                    invoice_number="INV-1",
                    customer_name="Customer One",
                    branch_id="branch-1",
                    date="2026-10-12",
                    total=25,
                    credited_amount=10,
                    status=SalesReturnStatus.processed,
                ),
                SalesReturnLineItem(
                    id="return-line-1",
                    return_id="return-processed",
                    item_id="item-1",
                    name="Test Item",
                    return_qty=1,
                    line_total=25,
                ),
                SalesReturn(
                    id="return-void",
                    number="CN-2",
                    invoice_id="invoice-valid",
                    invoice_number="INV-1",
                    customer_name="Customer One",
                    branch_id="branch-1",
                    date="2026-10-13",
                    total=90,
                    credited_amount=90,
                    status=SalesReturnStatus.void,
                ),
            ])
            await db.commit()

            filters = SimpleNamespace(
                from_date="2026-10-01",
                to="2026-10-31",
                branch_id="branch-1",
                staff_id="kam-1",
                category_id="",
                cursor_date=None,
                limit=20,
            )
            period = Period(date(2026, 10, 1), date(2026, 10, 31))

            summary = await _invoice_summary(db, filters, ["branch-1"], period)
            assert summary["gross_revenue"] == 100
            assert summary["returned_revenue"] == 25
            assert summary["revenue"] == 75
            assert summary["average_bill_value"] == 75
            assert summary["bill_count"] == 1

            refunds = await _refund_summary(db, filters, ["branch-1"], period)
            assert refunds == {"amount": 25, "credited_amount": 10, "count": 1}

            pending = await _pending_payments(db, filters, ["branch-1"], period)
            assert pending["total"] == 1
            assert pending["items"][0]["balance"] == 55
            assert pending["items"][0]["overdue"] is True

            heatmap = await _hourly_heatmap(db, filters, ["branch-1"], period)
            assert heatmap == [{"day": "Tue", "hour": "02:00", "value": 100}]

            activity = await _activity_logs(db, filters, period, ["branch-1"])
            assert [item["id"] for item in activity["items"]] == ["activity-1"]
            no_branch_filters = SimpleNamespace(**vars(filters))
            no_branch_filters.branch_id = ""
            all_allowed_activity = await _activity_logs(
                db,
                no_branch_filters,
                period,
                ["branch-1", "branch-2"],
            )
            assert {item["id"] for item in all_allowed_activity["items"]} == {
                "activity-1",
                "activity-2",
            }

            staff_options = await _kam_staff_options(db, filters, ["branch-1"], period)
            assert staff_options == [
                {"id": "kam-2", "name": "Ali"},
                {"id": "kam-1", "name": "Amina"},
                {"id": "Velu", "name": "Velu"},
                {"id": "__unassigned__", "name": "Unassigned"},
            ]
            all_staff_filters = SimpleNamespace(**vars(filters))
            all_staff_filters.staff_id = ""
            legacy_staff_sales = await _legacy_staff_sales_reference(
                db, all_staff_filters, ["branch-1"], period
            )
            optimized_staff_sales = await _staff_sales(
                db, all_staff_filters, ["branch-1"], period
            )
            assert optimized_staff_sales == legacy_staff_sales
            velu_filters = SimpleNamespace(**vars(filters))
            velu_filters.staff_id = "Velu"
            velu_summary = await _invoice_summary(db, velu_filters, ["branch-1"], period)
            assert velu_summary["bill_count"] == 1
            unassigned_filters = SimpleNamespace(**vars(filters))
            unassigned_filters.staff_id = "__unassigned__"
            unassigned_summary = await _invoice_summary(db, unassigned_filters, ["branch-1"], period)
            assert unassigned_summary["bill_count"] == 1

            category_filters = SimpleNamespace(**vars(filters))
            category_filters.category_id = "category-1"
            category_refund, category_credit = await _returned_revenue(
                db, category_filters, ["branch-1"], period
            )
            assert category_refund == 25
            assert category_credit is None

            short_range_filters = SimpleNamespace(**vars(filters))
            short_range_filters.branch_id = "branch-2"
            short_range_filters.staff_id = ""
            all_branch_filters = SimpleNamespace(**vars(short_range_filters))
            all_branch_filters.branch_id = ""
            no_branch_staff_options = await _kam_staff_options(
                db,
                all_branch_filters,
                ["branch-1", "branch-2"],
                period,
            )
            assert {"id": "kam-1", "name": "Amina"} in no_branch_staff_options
            branch_only_options = await _kam_staff_options(
                db,
                short_range_filters,
                ["branch-2"],
                period,
            )
            assert branch_only_options == [{"id": "__unassigned__", "name": "Unassigned"}]
    finally:
        await engine.dispose()


def test_inventory_and_billing_use_branch_scoped_live_definitions(monkeypatch):
    asyncio.run(_run_inventory_and_billing_definitions(monkeypatch))


async def _run_inventory_and_billing_definitions(monkeypatch) -> None:
    monkeypatch.setattr("src.routes.dashboard.business_today", lambda: date(2026, 11, 3))
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    try:
        async with session_factory() as db:
            db.add_all([
                Branch(id="branch-1", name="Shop Male'", code="SM"),
                Branch(id="branch-2", name="Other Branch", code="OB"),
                Category(id="category-1", name="Grocery"),
                Item(id="item-sold", name="Sold Low Item", category_id="category-1", cost_price=10, reorder_level=5),
                Item(id="item-slow", name="Slow Item", category_id="category-1", cost_price=4, reorder_level=5),
                Item(id="item-out", name="Out Item", category_id="category-1", cost_price=8, reorder_level=5),
                Item(id="item-other-branch", name="Other Branch Item", category_id="category-1", cost_price=2, reorder_level=5),
                ItemStock(id="stock-sold", item_id="item-sold", branch_id="branch-1", quantity=2),
                ItemStock(id="stock-slow", item_id="item-slow", branch_id="branch-1", quantity=7),
                ItemStock(id="stock-out", item_id="item-out", branch_id="branch-1", quantity=0),
                ItemStock(id="stock-other", item_id="item-other-branch", branch_id="branch-2", quantity=0),
                SaleInvoice(
                    id="invoice-valid",
                    number="INV-VALID",
                    branch_id="branch-1",
                    date="2026-10-05",
                    total=110,
                    paid_amount=80,
                    status=InvoiceStatus.paid,
                    customer_key_account_manager_snapshot="Velu",
                ),
                SaleInvoice(
                    id="invoice-other-kam",
                    number="INV-OTHER-KAM",
                    branch_id="branch-1",
                    date="2026-10-05",
                    total=0,
                    paid_amount=0,
                    status=InvoiceStatus.paid,
                    customer_key_account_manager_snapshot="Other KAM",
                ),
                SaleLineItem(
                    id="line-valid",
                    invoice_id="invoice-valid",
                    item_id="item-sold",
                    name="Sold Low Item",
                    qty=2,
                    line_total=110,
                    tax_rate=10,
                ),
                SaleInvoice(
                    id="invoice-pending-approval",
                    number="INV-PENDING",
                    branch_id="branch-1",
                    date="2026-10-06",
                    total=55,
                    paid_amount=0,
                    status=InvoiceStatus.pending_approval,
                ),
                SaleLineItem(
                    id="line-pending",
                    invoice_id="invoice-pending-approval",
                    item_id="item-sold",
                    name="Sold Low Item",
                    qty=1,
                    line_total=55,
                    tax_rate=10,
                ),
                SalesReturn(
                    id="return-valid",
                    number="CN-VALID",
                    invoice_id="invoice-valid",
                    invoice_number="INV-VALID",
                    branch_id="branch-1",
                    date="2026-10-08",
                    total=22,
                    credited_amount=22,
                    status=SalesReturnStatus.processed,
                ),
                SalesReturnLineItem(
                    id="return-line-valid",
                    return_id="return-valid",
                    item_id="item-sold",
                    name="Sold Low Item",
                    return_qty=0.2,
                    line_total=22,
                    tax_rate=10,
                ),
                CustomerPayment(
                    id="payment-cash",
                    number="PAY-CASH",
                    branch_id="branch-1",
                    date="2026-10-06",
                    total_amount=40,
                    payment_mode="cash",
                ),
                CustomerPayment(
                    id="payment-multi-kam",
                    number="PAY-MULTI-KAM",
                    branch_id="branch-1",
                    date="2026-10-06",
                    total_amount=100,
                    payment_mode="cash",
                ),
                CustomerPayment(
                    id="payment-card",
                    number="PAY-CARD",
                    branch_id="branch-1",
                    date="2026-10-06",
                    total_amount=10,
                    payment_mode="card",
                ),
                CustomerPayment(
                    id="payment-upi",
                    number="PAY-UPI",
                    branch_id="branch-1",
                    date="2026-10-06",
                    total_amount=20,
                    payment_mode="upi",
                ),
                CustomerPayment(
                    id="payment-bank",
                    number="PAY-BANK",
                    branch_id="branch-1",
                    date="2026-10-06",
                    total_amount=30,
                    payment_mode="bank_transfer",
                ),
                CustomerPayment(
                    id="payment-credit",
                    number="PAY-CREDIT",
                    branch_id="branch-1",
                    date="2026-10-06",
                    total_amount=5,
                    payment_mode="credit",
                ),
                CustomerPayment(
                    id="payment-other",
                    number="PAY-OTHER",
                    branch_id="branch-1",
                    date="2026-10-06",
                    total_amount=7,
                    payment_mode="cheque",
                ),
                CustomerPayment(
                    id="payment-void",
                    number="PAY-VOID",
                    branch_id="branch-1",
                    date="2026-10-06",
                    total_amount=1000,
                    payment_mode="cash",
                    voided=True,
                ),
                CustomerPayment(
                    id="payment-other-branch",
                    number="PAY-OTHER-BRANCH",
                    branch_id="branch-2",
                    date="2026-10-06",
                    total_amount=100,
                    payment_mode="cash",
                ),
                CustomerPayment(
                    id="payment-outside-range",
                    number="PAY-OUTSIDE",
                    branch_id="branch-1",
                    date="2026-09-30",
                    total_amount=200,
                    payment_mode="cash",
                ),
                CustomerPaymentAllocation(
                    id="allocation-cash",
                    payment_id="payment-cash",
                    invoice_id="invoice-valid",
                    amount=40,
                ),
                CustomerPaymentAllocation(
                    id="allocation-multi-kam-velu",
                    payment_id="payment-multi-kam",
                    invoice_id="invoice-valid",
                    amount=40,
                ),
                CustomerPaymentAllocation(
                    id="allocation-multi-kam-other",
                    payment_id="payment-multi-kam",
                    invoice_id="invoice-other-kam",
                    amount=60,
                ),
                CustomerPaymentAllocation(
                    id="allocation-card",
                    payment_id="payment-card",
                    invoice_id="invoice-valid",
                    amount=10,
                ),
                CustomerPaymentAllocation(
                    id="allocation-upi",
                    payment_id="payment-upi",
                    invoice_id="invoice-valid",
                    amount=20,
                ),
                CustomerPaymentAllocation(
                    id="allocation-bank",
                    payment_id="payment-bank",
                    invoice_id="invoice-valid",
                    amount=30,
                ),
                CustomerPaymentAllocation(
                    id="allocation-credit",
                    payment_id="payment-credit",
                    invoice_id="invoice-valid",
                    amount=5,
                ),
                CustomerPaymentAllocation(
                    id="allocation-other",
                    payment_id="payment-other",
                    invoice_id="invoice-valid",
                    amount=7,
                ),
                ItemBatch(
                    id="batch-expired",
                    item_id="item-sold",
                    branch_id="branch-1",
                    batch_number="B-OLD",
                    expiry_date="2026-11-02",
                    quantity=1,
                    initial_qty=2,
                    received_date="2026-10-05",
                ),
                ItemBatch(
                    id="batch-today",
                    item_id="item-slow",
                    branch_id="branch-1",
                    batch_number="B-TODAY",
                    expiry_date="2026-11-03",
                    quantity=2,
                    initial_qty=2,
                    received_date="2026-10-05",
                ),
                ItemBatch(
                    id="batch-last-day",
                    item_id="item-slow",
                    branch_id="branch-1",
                    batch_number="B-LAST",
                    expiry_date="2026-12-03",
                    quantity=1,
                    initial_qty=1,
                    received_date="2026-10-05",
                ),
                ItemBatch(
                    id="batch-outside",
                    item_id="item-slow",
                    branch_id="branch-1",
                    batch_number="B-OUTSIDE",
                    expiry_date="2026-12-04",
                    quantity=1,
                    initial_qty=1,
                    received_date="2026-10-05",
                ),
                StockMovement(
                    id="movement-in",
                    item_id="item-sold",
                    branch_id="branch-1",
                    delta=2,
                    movement_type="grn",
                    created_at=datetime(2026, 10, 5, 10),
                ),
                StockMovement(
                    id="movement-out",
                    item_id="item-sold",
                    branch_id="branch-1",
                    delta=-1,
                    movement_type="sale",
                    batch_id="batch-expired",
                    created_at=datetime(2026, 10, 5, 11),
                ),
                StockMovement(
                    id="movement-other-branch",
                    item_id="item-other-branch",
                    branch_id="branch-2",
                    delta=-1,
                    movement_type="sale",
                    created_at=datetime(2026, 10, 5, 11),
                ),
            ])
            await db.commit()
            filters = SimpleNamespace(
                from_date="2026-10-01",
                to="2026-10-31",
                branch_id="branch-1",
                staff_id="",
                category_id="",
                cursor_date=None,
                limit=20,
            )
            allowed = ["branch-1"]

            inventory = await _inventory_payload(db, filters, allowed)
            assert inventory["kpis"]["inventory_value"] == 48
            assert inventory["kpis"]["low_stock"] == 1
            assert inventory["kpis"]["out_of_stock"] == 1
            assert len(inventory["tables"]["low_stock"]["items"]) == 1
            assert len(inventory["tables"]["out_of_stock"]["items"]) == 1
            assert inventory["tables"]["low_stock"]["items"][0]["qty"] > 0
            assert inventory["tables"]["out_of_stock"]["items"][0]["qty"] <= 0
            assert len(inventory["tables"]["expired"]["items"]) == 1
            assert len(inventory["tables"]["expiring_30_days"]["items"]) == 2
            fast, slow = inventory["charts"]["fast_vs_slow_moving"]
            assert (fast["count"], slow["count"]) == (1, 1)
            assert fast["count"] + slow["count"] == 2
            assert inventory["charts"]["inventory_value_trend"] == []
            assert inventory["analytics"]["batch_movement"]["received_batches"] == 4
            assert inventory["analytics"]["batch_movement"]["consumed_batches"] == 1
            assert inventory["analytics"]["batch_movement"]["stock_out_movements"] == 1

            billing = await _billing_payload(db, filters, allowed)
            assert billing["kpis"]["tax_collected"] == 8
            assert billing["kpis"]["cash"] == 140
            assert billing["kpis"]["card"] == 10
            assert billing["kpis"]["upi"] == 20
            assert billing["kpis"]["transfer"] == 30
            assert billing["kpis"]["credit"] == 5
            assert billing["kpis"]["other"] == 7
            assert {row["method"] for row in billing["charts"]["payment_distribution"]} == {
                "CASH",
                "CARD",
                "UPI",
                "BANK TRANSFER",
                "CREDIT",
                "OTHER",
            }
            assert billing["analytics"]["collection_efficiency"] == 65.9
            assert (
                billing["kpis"]["collected"]
                - billing["kpis"]["credited_refunds"]
                + billing["kpis"]["pending_payments"]
                == billing["kpis"]["collected"] - 22 + 30
                == 88
            )

            category_filters = SimpleNamespace(**vars(filters))
            category_filters.category_id = "category-1"
            category_billing = await _billing_payload(db, category_filters, allowed)
            assert category_billing["kpis"]["cash"] is None
            assert category_billing["kpis"]["tax_collected"] == 8
            other_staff_filters = SimpleNamespace(**vars(filters))
            other_staff_filters.staff_id = "Velu"
            velu_billing = await _billing_payload(db, other_staff_filters, allowed)
            assert velu_billing["kpis"]["cash"] == 80
            other_staff_filters.staff_id = "Other KAM"
            other_staff_billing = await _billing_payload(db, other_staff_filters, allowed)
            assert other_staff_billing["kpis"]["cash"] == 60
            assert other_staff_billing["kpis"]["tax_collected"] == 0
            with pytest.raises(HTTPException) as error:
                _branch_condition(
                    ItemStock.branch_id,
                    SimpleNamespace(branch_id="branch-2"),
                    allowed,
                )
            assert error.value.status_code == 403
            assert _database_supports_materialized_views(db) is False
    finally:
        await engine.dispose()


def test_dashboard_delta_is_na_when_previous_period_is_zero_or_missing():
    assert _pct_delta(100, 0) is None
    assert _pct_delta(100, None) is None
    assert _pct_delta(0, 100) == -100


def test_collection_efficiency_nets_refunds_and_matches_outstanding_identity():
    revenue = 88
    collected = 80
    refunded = 22
    outstanding = 30

    assert _collection_efficiency(collected, refunded, revenue) == 65.9
    assert round((1 - outstanding / revenue) * 100, 1) == 65.9
    assert _collection_efficiency(None, refunded, revenue) is None


def test_reconciled_mix_omits_zero_value_others():
    assert _reconciled_mix({"grocery": 100}, {"grocery": "Grocery"}, 100, "category") == [
        {"category": "Grocery", "revenue": 100.0, "percentage": 100.0}
    ]


def test_sales_pulse_periods_are_anchored_and_clamp_previous_month():
    periods = _sales_pulse_periods(date(2026, 11, 2))
    assert periods["daily_current"] == Period(date(2026, 11, 2), date(2026, 11, 2))
    assert periods["daily_previous"] == Period(date(2026, 11, 1), date(2026, 11, 1))
    assert periods["weekly_current"] == Period(date(2026, 10, 27), date(2026, 11, 2))
    assert periods["weekly_previous"] == Period(date(2026, 10, 20), date(2026, 10, 26))
    assert periods["monthly_current"] == Period(date(2026, 11, 1), date(2026, 11, 2))
    assert periods["monthly_previous"] == Period(date(2026, 10, 1), date(2026, 10, 2))

    february_periods = _sales_pulse_periods(date(2025, 3, 31))
    assert february_periods["monthly_previous"] == Period(date(2025, 2, 1), date(2025, 2, 28))


def test_dashboard_category_revenue_reconciles_and_billing_headers_are_unavailable():
    asyncio.run(_run_dashboard_category_reconciliation())


async def _run_dashboard_category_reconciliation() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    try:
        async with session_factory() as db:
            db.add_all([
                Branch(id="branch-1", name="Shop Male'", code="SM"),
                Category(id="category-grocery", name="Grocery"),
                Category(id="category-other", name="Other"),
                Item(
                    id="item-grocery-1",
                    name="Grocery One",
                    category_id="category-grocery",
                    brand="  Brand X ",
                    cost_price=5,
                ),
                Item(
                    id="item-grocery-2",
                    name="Grocery Two",
                    category_id="category-grocery",
                    brand="brand x",
                    cost_price=5,
                ),
                Item(
                    id="item-other",
                    name="Other Item",
                    category_id="category-other",
                    brand=" ",
                    cost_price=0,
                ),
                SaleInvoice(
                    id="invoice-1",
                    number="INV-1",
                    customer_name="Walk-in",
                    branch_id="branch-1",
                    date="2026-10-04",
                    total=100,
                    paid_amount=100,
                    payment_mode="cash",
                    discount=5,
                    status=InvoiceStatus.paid,
                ),
                SaleInvoice(
                    id="invoice-2",
                    number="INV-2",
                    customer_name="Walk-in",
                    branch_id="branch-1",
                    date="2026-10-05",
                    total=30,
                    paid_amount=0,
                    payment_mode="cash",
                    discount=3,
                    status=InvoiceStatus.paid,
                ),
                CustomerPayment(
                    id="payment-1",
                    number="PAY-1",
                    branch_id="branch-1",
                    date="2026-10-04",
                    total_amount=100,
                    payment_mode="cash",
                ),
                SaleLineItem(
                    id="sale-1",
                    invoice_id="invoice-1",
                    item_id="item-grocery-1",
                    name="Grocery One",
                    qty=2,
                    line_total=60,
                ),
                SaleLineItem(
                    id="sale-2",
                    invoice_id="invoice-1",
                    item_id="item-grocery-2",
                    name="Grocery Two",
                    qty=0.5,
                    line_total=20,
                ),
                SaleLineItem(
                    id="sale-3",
                    invoice_id="invoice-1",
                    item_id="item-other",
                    name="Other Item",
                    qty=1,
                    line_total=20,
                ),
                SaleLineItem(
                    id="sale-4",
                    invoice_id="invoice-2",
                    item_id="item-grocery-1",
                    name="Grocery One",
                    qty=1.5,
                    line_total=30,
                ),
                SalesReturn(
                    id="return-1",
                    number="CN-1",
                    invoice_id="invoice-1",
                    invoice_number="INV-1",
                    customer_name="Walk-in",
                    branch_id="branch-1",
                    date="2026-10-08",
                    total=15,
                    credited_amount=2,
                    status=SalesReturnStatus.processed,
                ),
                SalesReturnLineItem(
                    id="return-line-1",
                    return_id="return-1",
                    item_id="item-grocery-1",
                    name="Grocery One",
                    return_qty=0.25,
                    line_total=10,
                ),
                SalesReturnLineItem(
                    id="return-line-2",
                    return_id="return-1",
                    item_id="item-other",
                    name="Other Item",
                    return_qty=0.5,
                    line_total=5,
                ),
            ])
            await db.commit()

            filters = SimpleNamespace(
                from_date="2026-10-01",
                to="2026-10-31",
                branch_id="branch-1",
                staff_id="",
                category_id="",
                cursor_date=None,
                limit=20,
            )
            all_branch_ids = ["branch-1"]
            all_payload = await _sales_dashboard_payload(db, filters, all_branch_ids)
            assert _can_use_sales_mvs(db, filters) is False
            assert all_payload["kpis"]["total_revenue"] == 115
            assert all_payload["kpis"]["median_bill_value"] == 65
            assert sum(row["sales"] for row in all_payload["charts"]["sales_trend"]) == 115
            assert sum(row["revenue"] for row in all_payload["charts"]["revenue_vs_profit"]) == 115
            assert sum(row["revenue"] for row in all_payload["charts"]["category_pie"]) == 115
            assert sum(row["revenue"] for row in all_payload["charts"]["brand_donut"]) == 115
            assert sum(row["sales"] for row in all_payload["analytics"]["branch_wise_sales"]) == 115
            assert {
                row["brand"]
                for row in all_payload["charts"]["brand_donut"]
                if row["brand"] != "Others"
            } == {"Brand X", "Unbranded"}
            assert all_payload["tables"]["top_customers"]["items"][0]["name"] == "Walk-in"
            assert all_payload["tables"]["top_customers"]["items"][0]["bill_count"] == 2
            product = next(
                row for row in all_payload["tables"]["top_products"]["items"]
                if row["product_id"] == "item-grocery-1"
            )
            assert product["qty"] == 3.25
            assert all_payload["kpis"]["cost_coverage_pct"] < 95
            assert all_payload["analytics"]["target_vs_achievement"]["target_period"].startswith("Full-month target")

            category_filters = SimpleNamespace(**vars(filters))
            category_filters.category_id = "category-grocery"
            category_payload = await _sales_dashboard_payload(db, category_filters, all_branch_ids)
            assert category_payload["kpis"]["total_revenue"] == 100
            assert category_payload["kpis"]["average_bill_value"] == 50
            assert category_payload["kpis"]["cost_coverage_pct"] == 100
            assert sum(row["sales"] for row in category_payload["charts"]["sales_trend"]) == 100
            assert sum(row["revenue"] for row in category_payload["charts"]["revenue_vs_profit"]) == 100
            assert sum(row["revenue"] for row in category_payload["charts"]["category_pie"]) == 100
            assert sum(row["revenue"] for row in category_payload["charts"]["brand_donut"]) == 100
            assert sum(row["sales"] for row in category_payload["analytics"]["branch_wise_sales"]) == 100
            all_operations = await _operations_payload(db, filters, all_branch_ids)
            assert sum(row["sales"] for row in all_operations["charts"]["staff_sales"]) == all_payload["kpis"]["total_revenue"]
            assert sum(row["bill_count"] for row in all_operations["charts"]["staff_sales"]) == 2
            assert len(all_operations["charts"]["staff_sales"]) == 1
            assert all_operations["charts"]["staff_sales"][0]["staff"] == "Unassigned"
            operations_payload = await _operations_payload(db, category_filters, all_branch_ids)
            assert sum(row["sales"] for row in operations_payload["charts"]["branch_performance"]) == 100
            assert sum(row["sales"] for row in operations_payload["charts"]["staff_sales"]) == 100
            assert sum(
                row["bill_count"] for row in operations_payload["tables"]["staff_performance"]["items"]
            ) == 2

            category_billing = await _billing_payload(db, category_filters, all_branch_ids)
            assert category_billing["kpis"]["cash"] is None
            assert category_billing["kpis"]["card"] is None
            assert category_billing["kpis"]["upi"] is None
            assert category_billing["kpis"]["transfer"] is None
            assert category_billing["kpis"]["credit"] is None
            assert category_billing["kpis"]["collected"] is None
            assert category_billing["kpis"]["pending_payments"] is None
            assert category_billing["kpis"]["discounts"] is None
            assert category_billing["kpis"]["credited_refunds"] is None
            assert category_billing["kpis"]["refunds"] == 10
            assert category_billing["charts"]["payment_distribution"] is None
            assert category_billing["analytics"]["collection_efficiency"] is None
            assert category_billing["analytics"]["pending_invoice_count"] == 1
            assert all(row["balance"] is None for row in category_billing["tables"]["pending_payments"]["items"])
            assert category_billing["tables"]["recent_refunds"]["items"][0]["amount"] == 10
            assert category_billing["tables"]["recent_refunds"]["items"][0]["credited_amount"] is None
            assert all(row["discount"] is None for row in category_billing["tables"]["discounted_bills"]["items"])
            assert sum(row["count"] for row in category_billing["charts"]["daily_billing_count"]) == 2

            all_billing = await _billing_payload(db, filters, all_branch_ids)
            assert all_billing["kpis"]["cash"] == 100
            assert all_billing["kpis"]["upi"] == 0
            assert all_billing["kpis"]["transfer"] == 0
            assert all_billing["kpis"]["credit"] == 0
            assert all_billing["kpis"]["collected"] == 100
            assert all_billing["kpis"]["pending_payments"] == 30
            assert all_billing["kpis"]["discounts"] == 8
            assert all_billing["kpis"]["credited_refunds"] == 2
            assert all_billing["analytics"]["collection_efficiency"] is not None
            assert all(row["balance"] is not None for row in all_billing["tables"]["pending_payments"]["items"])
            assert all(row["discount"] is not None for row in all_billing["tables"]["discounted_bills"]["items"])
    finally:
        await engine.dispose()
