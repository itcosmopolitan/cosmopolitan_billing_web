from __future__ import annotations

import asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from src.database import _backfill_cash_entry_child_counters


def test_backfill_cash_entry_counters_from_sales_sources():
    asyncio.run(_run_backfill_cash_entry_counter_test())


async def _run_backfill_cash_entry_counter_test():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as conn:
            await conn.execute(text("""
                CREATE TABLE cash_entries (
                    id VARCHAR PRIMARY KEY,
                    source_type VARCHAR,
                    source_id VARCHAR,
                    child_counter_id VARCHAR,
                    child_counter_name VARCHAR
                )
            """))
            await conn.execute(text("""
                CREATE TABLE sale_invoices (
                    id VARCHAR PRIMARY KEY,
                    child_counter_id VARCHAR,
                    child_counter_name VARCHAR
                )
            """))
            await conn.execute(text("""
                CREATE TABLE sales_returns (
                    id VARCHAR PRIMARY KEY,
                    invoice_id VARCHAR
                )
            """))
            await conn.execute(text("""
                CREATE TABLE customer_payment_allocations (
                    payment_id VARCHAR,
                    invoice_id VARCHAR
                )
            """))
            await conn.execute(text("""
                INSERT INTO sale_invoices (id, child_counter_id, child_counter_name) VALUES
                    ('invoice-a', 'counter-1', 'Counter 1'),
                    ('invoice-b', 'counter-1', 'Counter 1'),
                    ('invoice-c', 'counter-2', 'Counter 2')
            """))
            await conn.execute(text("""
                INSERT INTO sales_returns (id, invoice_id) VALUES ('return-a', 'invoice-a')
            """))
            await conn.execute(text("""
                INSERT INTO customer_payment_allocations (payment_id, invoice_id) VALUES
                    ('payment-one-counter', 'invoice-a'),
                    ('payment-one-counter', 'invoice-b'),
                    ('payment-multiple-counters', 'invoice-a'),
                    ('payment-multiple-counters', 'invoice-c')
            """))
            await conn.execute(text("""
                INSERT INTO cash_entries (id, source_type, source_id) VALUES
                    ('sale-entry', 'sale_invoice', 'invoice-a'),
                    ('return-entry', 'sale_return', 'return-a'),
                    ('payment-entry', 'customer_payment', 'payment-one-counter'),
                    ('mixed-payment-entry', 'customer_payment', 'payment-multiple-counters'),
                    ('void-entry', 'void', 'sale-entry')
            """))

            await _backfill_cash_entry_child_counters(conn)
            rows = (
                await conn.execute(
                    text("SELECT id, child_counter_id, child_counter_name FROM cash_entries")
                )
            ).all()

        by_id = {row.id: (row.child_counter_id, row.child_counter_name) for row in rows}
        assert by_id["sale-entry"] == ("counter-1", "Counter 1")
        assert by_id["return-entry"] == ("counter-1", "Counter 1")
        assert by_id["payment-entry"] == ("counter-1", "Counter 1")
        assert by_id["mixed-payment-entry"] == (None, None)
        assert by_id["void-entry"] == ("counter-1", "Counter 1")
    finally:
        await engine.dispose()
