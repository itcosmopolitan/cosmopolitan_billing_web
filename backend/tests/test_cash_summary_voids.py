from src.models import CashEntry
from src.routes.cash import _build_summary


def test_voided_cash_entry_and_its_reversal_net_to_zero():
    original = CashEntry(type="in", category="Sale — Cash", amount=100.0,
                         is_voided=True, source_type="customer_payment")
    reversal = CashEntry(type="out", category="Sale — Cash", amount=100.0,
                         is_voided=False, source_type="void")

    summary = _build_summary([original, reversal], 0, None)

    assert summary["expected_balance"] == 0
    assert summary["cash_in"] == 0
    assert summary["cash_out"] == 0


def test_live_cash_entry_still_counts_alongside_voided_pair():
    original = CashEntry(type="in", category="Sale — Cash", amount=100.0,
                         is_voided=True, source_type="customer_payment")
    reversal = CashEntry(type="out", category="Sale — Cash", amount=100.0,
                         is_voided=False, source_type="void")
    live = CashEntry(type="in", category="Sale — Cash", amount=50.0,
                     is_voided=False, source_type="customer_payment")

    summary = _build_summary([original, reversal, live], 0, None)

    assert summary["expected_balance"] == 50.0
