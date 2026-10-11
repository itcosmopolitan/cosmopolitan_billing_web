"""Void sales cash entries left behind by customer payments deleted before the bulk-delete fix.

Dry run by default. Pass --apply to write. Entries on locked cash days are skipped,
matching the void endpoint's rule.

Entries are marked voided without a reversal row. The cash summary sums non-voided
rows, so a reversal left active would subtract the amount again.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime
from pathlib import Path

from sqlalchemy import exists, select

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src import config  # noqa: E402
from src.database import get_async_session  # noqa: E402
from src.models import CashDayClose, CashEntry, CustomerPayment  # noqa: E402
from src.routes._payment_ledger import void_payment_record  # noqa: E402

VOIDED_BY = "Cleanup: deleted payment"
VOID_REASON = "Payment deleted before bulk-delete fix"


def _signed(entry: CashEntry) -> float:
    amount = float(entry.amount or 0)
    return amount if entry.type == "in" else -amount


async def run(apply: bool) -> None:
    async with get_async_session()() as db:
        orphans = (await db.execute(
            select(CashEntry)
            .where(
                CashEntry.source_type == "customer_payment",
                CashEntry.is_voided == False,  # noqa: E712
                ~exists().where(CustomerPayment.id == CashEntry.source_id),
            )
            .order_by(CashEntry.date, CashEntry.entry_number)
        )).scalars().all()

        if not orphans:
            print("No orphaned customer-payment cash entries found.")
            return

        to_void: list[CashEntry] = []
        skipped: list[CashEntry] = []
        for entry in orphans:
            close = (await db.execute(
                select(CashDayClose).where(
                    CashDayClose.branch_id == entry.branch_id,
                    CashDayClose.date == entry.date,
                )
            )).scalar_one_or_none()
            if close is not None and close.is_locked:
                skipped.append(entry)
            else:
                to_void.append(entry)

        print(f"{'entry':<16} {'date':<11} {'type':<4} {'amount':>10}  {'description'}")
        for entry in orphans:
            status = "SKIP (locked)" if entry in skipped else ""
            print(
                f"{entry.entry_number or entry.id:<16} {entry.date:<11} {entry.type:<4} "
                f"{float(entry.amount or 0):>10.2f}  {(entry.description or '')[:45]} {status}"
            )
        net = sum(_signed(e) for e in to_void)
        print(f"\nTo void: {len(to_void)} entries, net cash effect {net:.2f}. Skipped (locked day): {len(skipped)}.")

        if not apply:
            print("Dry run: nothing written. Re-run with --apply to void.")
            return

        now = datetime.now()
        for entry in to_void:
            entry.is_voided = True
            entry.voided_at = now
            entry.voided_by = VOIDED_BY
            entry.void_reason = VOID_REASON
            await void_payment_record(
                db,
                source_document_type="customer_payment",
                source_document_id=entry.source_id,
                voided_at=now.strftime("%Y-%m-%d"),
            )
        await db.commit()
        print(f"Voided {len(to_void)} entries.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Write changes (default is dry run)")
    args = parser.parse_args()
    config.load()
    asyncio.run(run(apply=args.apply))


if __name__ == "__main__":
    main()
