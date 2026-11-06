from __future__ import annotations

import asyncio
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.models import Branch, InvoiceStatus, Item, SaleInvoice, SaleLineItem, User
from src.routes.dashboard import DashboardFilters, Period, _line_profit_summary
from src.routes.reports import category_sales, customer_sales, product_sales


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)()


async def _seed(db: AsyncSession) -> User:
    actor = User(
        id="cogs-report-user",
        name="COGS Tester",
        email="cogs@example.com",
        hashed_password="x",
        all_branches=True,
    )
    db.add_all([
        actor,
        Branch(id="cogs-branch", name="Main", code="MAIN"),
        Item(
            id="cogs-item",
            name="Test item",
            sku="COGS-ITEM",
            cost_price=5,
            selling_price=10,
        ),
    ])
    for invoice_id, status in (
        ("draft-invoice", InvoiceStatus.draft),
        ("pending-invoice", InvoiceStatus.pending_approval),
        ("approved-invoice", InvoiceStatus.paid),
    ):
        db.add(
            SaleInvoice(
                id=invoice_id,
                number=invoice_id,
                customer_name="Customer",
                branch_id="cogs-branch",
                branch_name="Main",
                date="2026-11-01",
                subtotal=20,
                tax_total=0,
                discount=0,
                total=20,
                paid_amount=20 if status == InvoiceStatus.paid else 0,
                payment_mode="cash",
                status=status,
            )
        )
        db.add(
            SaleLineItem(
                id=f"{invoice_id}-line",
                invoice_id=invoice_id,
                item_id="cogs-item",
                name="Test item",
                sku="COGS-ITEM",
                qty=2,
                price=10,
                tax_rate=0,
                line_total=20,
            )
        )
    await db.commit()
    return actor


def test_unposted_invoices_are_excluded_from_report_and_dashboard_cogs_by_default():
    async def scenario():
        db = await _build_session()
        try:
            actor = await _seed(db)
            default_product = await product_sales(
                date_from="2026-11-01",
                date_to="2026-11-01",
                db=db,
                user=actor,
            )
            legacy_product = await product_sales(
                date_from="2026-11-01",
                date_to="2026-11-01",
                include_unposted=True,
                db=db,
                user=actor,
            )
            default_category = await category_sales(
                date_from="2026-11-01",
                date_to="2026-11-01",
                db=db,
                user=actor,
            )
            default_customer = await customer_sales(
                date_from="2026-11-01",
                date_to="2026-11-01",
                db=db,
                user=actor,
            )
            period = Period(date(2026, 11, 1), date(2026, 11, 1))
            default_dashboard = await _line_profit_summary(
                db, DashboardFilters(from_date="2026-11-01", to="2026-11-01"), None, period
            )
            legacy_dashboard = await _line_profit_summary(
                db,
                DashboardFilters(from_date="2026-11-01", to="2026-11-01", include_unposted=True),
                None,
                period,
            )
            return (
                default_product,
                legacy_product,
                default_category,
                default_customer,
                default_dashboard,
                legacy_dashboard,
            )
        finally:
            await db.close()

    (
        default_product,
        legacy_product,
        default_category,
        default_customer,
        default_dashboard,
        legacy_dashboard,
    ) = asyncio.run(scenario())

    assert default_product["items"][0]["cost_value"] == 10
    assert legacy_product["items"][0]["cost_value"] == 30
    assert default_category["items"][0]["cost_value"] == 10
    assert default_customer["items"][0]["cost_of_sales"] == 10
    assert default_dashboard["profit"] == 50
    assert legacy_dashboard["profit"] == 30
