#!/usr/bin/env python3
"""End-to-end lifecycle smoke tests for sales + purchase flows (Phase 0–3).

Usage (from backend/ with venv active):
    python scripts/test_lifecycle.py [--base http://localhost:8080/api/v1]
"""
from __future__ import annotations

import argparse
import sys
from typing import Any, Optional

import httpx

# ─── Seed fixtures (Render stage / local seed) ───────────────────────────────
BRANCH = "br-001"
VENDOR = "vn-001"
VENDOR_NAME = "Sri Krishna Traders"
CUSTOMER = "cu-001"
CUSTOMER_NAME = "Priya Sharma"
ITEM_TRACKED = "pr-008"       # Surf Excel — untracked aggregate stock
ITEM_TRACKED_NAME = "Surf Excel 1kg"
ITEM_BATCH = "pr-002"         # Toor Dal — batch tracked
ITEM_BATCH_NAME = "Toor Dal 1kg"

DEFAULT_EMAIL = "suresh@srimurugan.com"
DEFAULT_PASSWORD = "admin123"


class LifecycleTester:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.client = httpx.Client(timeout=60.0)
        self.token: Optional[str] = None
        self.passed: list[str] = []
        self.failed: list[tuple[str, str]] = []

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def req(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        expect: int | tuple[int, ...] = 200,
    ) -> Any:
        url = f"{self.base}{path}"
        r = self.client.request(method, url, headers=self._headers(), json=json)
        codes = (expect,) if isinstance(expect, int) else expect
        if r.status_code not in codes:
            detail = r.text[:500]
            raise AssertionError(f"{method} {path} → {r.status_code} (expected {codes}): {detail}")
        if r.status_code == 204:
            return None
        if r.headers.get("content-type", "").startswith("application/json"):
            return r.json()
        return r.text

    def ok(self, name: str) -> None:
        self.passed.append(name)
        print(f"  ✓ {name}")

    def run(self, name: str, fn) -> None:
        print(f"\n▶ {name}")
        try:
            fn()
            self.ok(name)
        except Exception as e:
            self.failed.append((name, str(e)))
            print(f"  ✗ {name}: {e}")

    # ─── Auth / settings ───────────────────────────────────────────────────
    def test_login(self) -> None:
        data = self.req(
            "POST", "/auth/login",
            json={"email": DEFAULT_EMAIL, "password": DEFAULT_PASSWORD},
            expect=200,
        )
        self.token = data["token"]

    def test_settings(self) -> None:
        org = self.req("GET", "/settings/organisation")
        assert "allowOverselling" in org or "allow_overselling" in org
        self.req("PATCH", "/settings/organisation", json={"allow_overselling": True})

    # ─── Purchase lifecycles ─────────────────────────────────────────────────
    def test_po_convert_to_bill(self) -> dict:
        """PO → GRN + Bill in one step (the path that had the FK bug)."""
        po = self.req("POST", "/purchases/orders/", json={
            "vendor_id": VENDOR, "vendor_name": VENDOR_NAME,
            "branch_id": BRANCH, "branch_name": "Male",
            "items": [{"item_id": ITEM_TRACKED, "name": ITEM_TRACKED_NAME,
                       "qty": 2, "cost": 128, "tax_rate": 18}],
            "notes": "lifecycle-test po→bill",
        }, expect=201)
        conv = self.req("POST", f"/purchases/orders/{po['id']}/convert", json={
            "payment_received": False,
            "notes": "converted",
        }, expect=200)
        assert conv.get("bill_id") and conv.get("grn_id")
        bill = self.req("GET", f"/purchases/{conv['bill_id']}")
        assert bill.get("grnId") == conv["grn_id"]
        grn = self.req("GET", f"/purchases/grns/{conv['grn_id']}")
        assert grn.get("convertedBillId") == conv["bill_id"]
        po_row = self.req("GET", f"/purchases/orders/{po['id']}")
        assert po_row["status"] == "converted"
        return {"po": po, "bill": bill, "grn": grn, "conv": conv}

    def test_po_grn_then_bill(self) -> dict:
        """PO → GRN (receive only) → Bill from GRN."""
        po = self.req("POST", "/purchases/orders/", json={
            "vendor_id": VENDOR, "vendor_name": VENDOR_NAME,
            "branch_id": BRANCH,
            "items": [{"item_id": ITEM_BATCH, "name": ITEM_BATCH_NAME,
                       "qty": 3, "cost": 120, "tax_rate": 5}],
            "notes": "lifecycle-test po→grn→bill",
        }, expect=201)
        grn = self.req("POST", f"/purchases/grns/from-po/{po['id']}", json={
            "notes": "partial receive path",
        }, expect=201)
        assert grn.get("id")
        po_row = self.req("GET", f"/purchases/orders/{po['id']}")
        assert po_row["status"] in ("partially_received", "converted")
        bill = self.req("POST", f"/purchases/grns/{grn['id']}/bill", json={
            "payment_received": True, "payment_mode": "cash",
        }, expect=201)
        assert bill.get("bill_id") or bill.get("id")
        bill_id = bill.get("bill_id") or bill.get("id")
        grn_row = self.req("GET", f"/purchases/grns/{grn['id']}")
        assert grn_row.get("convertedBillId") == bill_id
        return {"po": po, "grn": grn, "bill_id": bill_id}

    def test_manual_grn_to_bill(self) -> dict:
        """Manual GRN → Bill."""
        grn = self.req("POST", "/purchases/grns/", json={
            "vendor_id": VENDOR, "vendor_name": VENDOR_NAME,
            "branch_id": BRANCH,
            "items": [{"item_id": ITEM_TRACKED, "name": ITEM_TRACKED_NAME,
                       "qty": 1, "cost": 128, "tax_rate": 18}],
            "notes": "manual grn",
        }, expect=201)
        bill = self.req("POST", f"/purchases/grns/{grn['id']}/bill", json={
            "payment_received": False,
        }, expect=201)
        bill_id = bill.get("bill_id") or bill.get("id")
        return {"grn": grn, "bill_id": bill_id}

    def test_direct_bill(self) -> dict:
        """Direct bill create (auto-GRN)."""
        bill = self.req("POST", "/purchases/", json={
            "vendor_id": VENDOR, "vendor_name": VENDOR_NAME,
            "branch_id": BRANCH,
            "items": [{"item_id": ITEM_TRACKED, "name": ITEM_TRACKED_NAME,
                       "qty": 1, "cost": 128, "tax_rate": 18}],
            "notes": "direct bill",
        }, expect=201)
        detail = self.req("GET", f"/purchases/{bill['id']}")
        assert detail.get("grnId"), "Direct bill must link to auto-GRN"
        return {"bill": detail}

    def test_grn_batch_capture(self) -> dict:
        """Batch-tracked GRN with explicit lot # creates an ItemBatch."""
        lot = "LC-LIFE-001"
        grn = self.req("POST", "/purchases/grns/", json={
            "vendor_id": VENDOR, "vendor_name": VENDOR_NAME,
            "branch_id": BRANCH,
            "items": [{
                "item_id": ITEM_BATCH, "name": ITEM_BATCH_NAME,
                "qty": 5, "cost": 120, "tax_rate": 5,
                "batch_number": lot,
                "mfg_date": "2026-01-01",
            }],
            "notes": "lifecycle batch receive",
        }, expect=201)
        r = self.client.get(
            f"{self.base}/items/{ITEM_BATCH}/batches",
            headers=self._headers(),
            params={"branch_id": BRANCH},
        )
        if r.status_code != 200:
            raise AssertionError(f"GET batches → {r.status_code}: {r.text[:300]}")
        data = r.json()
        batches = data.get("items") or []
        match = next(
            (b for b in batches if (b.get("batchNumber") or b.get("batch_number")) == lot),
            None,
        )
        assert match, f"Batch {lot} not found after GRN {grn.get('number')}"
        assert int(match.get("quantity") or 0) >= 5
        return {"grn": grn, "batch_id": match["id"], "lot": lot}

    def test_invoice_explicit_batch_allocation(self, batch_id: str) -> dict:
        """Back-office invoice with explicit batch_allocation consumes the lot."""
        inv = self.req("POST", "/sales/", json={
            "customer_id": CUSTOMER, "customer_name": CUSTOMER_NAME,
            "branch_id": BRANCH,
            "items": [{
                "item_id": ITEM_BATCH, "name": ITEM_BATCH_NAME,
                "qty": 1, "price": 160, "tax_rate": 5,
                "batch_allocation": [{"batch_id": batch_id, "qty": 1}],
            }],
            "payment_mode": "cash",
            "notes": "lifecycle explicit batch sale",
        }, expect=201)
        detail = self.req("GET", f"/sales/{inv['id']}")
        line = detail["items"][0]
        alloc = line.get("batchAllocation") or line.get("batch_allocation")
        assert alloc, "Invoice line must persist batchAllocation ledger"
        assert any(
            (a.get("batch_id") or a.get("batchId")) == batch_id
            for a in (alloc if isinstance(alloc, list) else [])
        ), "Allocation must reference the chosen batch"
        return {"invoice_id": inv["id"]}

    def test_vendor_return(self, bill_id: str) -> str:
        bill = self.req("GET", f"/purchases/{bill_id}")
        line = bill["items"][0]
        ret = self.req("POST", "/purchases/returns/", json={
            "bill_id": bill_id,
            "vendor_id": bill["vendorId"],
            "reason": "Damaged",
            "items": [{
                "bill_line_id": line["id"],
                "item_id": line.get("itemId"),
                "name": line["name"],
                "original_qty": line["qty"],
                "return_qty": 1,
                "cost": line["cost"],
                "tax_rate": line.get("taxRate", 0),
            }],
        }, expect=201)
        bill_after = self.req("GET", f"/purchases/{bill_id}")
        assert bill_after.get("returnStatus") in ("partial", "full", "none")
        return ret.get("id") or ret.get("return_id", "")

    def test_vendor_return_void(self, return_id: str, bill_id: str) -> None:
        if not return_id:
            return
        bill_before = self.req("GET", f"/purchases/{bill_id}")
        self.req("POST", f"/purchases/returns/{return_id}/void", expect=200)
        ret_row = self.req("GET", f"/purchases/returns/{return_id}")
        assert ret_row.get("status") == "void" or ret_row.get("voided") is True
        bill_after = self.req("GET", f"/purchases/{bill_id}")
        assert bill_after.get("returnStatus") == "none"
        assert float(bill_after.get("total") or 0) >= float(bill_before.get("total") or 0)

    def test_vendor_overpayment_credit(self) -> None:
        """Overpay a pending bill → vendor.credit_balance increases."""
        bill = self.req("POST", "/purchases/", json={
            "vendor_id": VENDOR, "vendor_name": VENDOR_NAME,
            "branch_id": BRANCH,
            "items": [{"item_id": ITEM_TRACKED, "name": ITEM_TRACKED_NAME,
                       "qty": 1, "cost": 128, "tax_rate": 18}],
            "notes": "lifecycle overpay test",
        }, expect=201)
        balance = round(float(bill["total"] or 0), 2)
        vendor_before = self.req("GET", f"/vendors/{VENDOR}")
        credit_before = float(vendor_before.get("credit_balance") or 0)
        excess = 50.0
        pay = self.req("POST", f"/purchases/{bill['id']}/payment", json={
            "amount": balance + excess,
            "mode": "cash",
            "payment_ref": "lifecycle-overpay",
        }, expect=200)
        assert float(pay.get("credit_applied") or 0) >= excess - 0.01
        vendor_after = self.req("GET", f"/vendors/{VENDOR}")
        credit_after = float(vendor_after.get("credit_balance") or 0)
        assert credit_after >= credit_before + excess - 0.01

    def test_vendor_payment(self, bill_id: str) -> None:
        bill = self.req("GET", f"/purchases/{bill_id}")
        if bill.get("status") == "paid":
            return
        balance = round(bill["total"] - bill.get("paidAmount", 0), 2)
        if balance <= 0:
            return
        self.req("POST", f"/purchases/{bill_id}/payment", json={
            "amount": balance,
            "mode": "cash",
            "payment_ref": "lifecycle-test",
        }, expect=200)

    # ─── Sales lifecycles ────────────────────────────────────────────────────
    def test_quote_to_so_to_invoice(self) -> dict:
        quote = self.req("POST", "/sales/quotations/", json={
            "customer_id": CUSTOMER, "customer_name": CUSTOMER_NAME,
            "branch_id": BRANCH,
            "items": [{"item_id": ITEM_TRACKED, "name": ITEM_TRACKED_NAME,
                       "qty": 1, "price": 160, "tax_rate": 18}],
            "notes": "quote→so→inv",
        }, expect=201)
        so = self.req("POST", f"/sales/quotations/{quote['id']}/convert-to-order", expect=200)
        so_id = so.get("order_id") or so.get("id")
        inv = self.req("POST", f"/sales/orders/{so_id}/convert", json={
            "payment_received": True, "payment_mode": "cash",
        }, expect=200)
        assert inv.get("invoice_id") or inv.get("id")
        inv_id = inv.get("invoice_id") or inv.get("id")
        so_row = self.req("GET", f"/sales/orders/{so_id}")
        assert so_row["status"] == "converted"
        return {"quote": quote, "so": so, "invoice_id": inv_id}

    def test_quote_to_invoice_direct(self) -> dict:
        quote = self.req("POST", "/sales/quotations/", json={
            "customer_id": CUSTOMER, "customer_name": CUSTOMER_NAME,
            "branch_id": BRANCH,
            "items": [{"item_id": ITEM_TRACKED, "name": ITEM_TRACKED_NAME,
                       "qty": 1, "price": 160, "tax_rate": 18}],
            "notes": "quote→inv direct",
        }, expect=201)
        inv = self.req("POST", f"/sales/quotations/{quote['id']}/convert-to-invoice", json={
            "payment_received": False,
        }, expect=200)
        inv_id = inv.get("invoice_id") or inv.get("id")
        quote_row = self.req("GET", f"/sales/quotations/{quote['id']}")
        assert quote_row.get("convertedInvoiceId") == inv_id
        return {"quote": quote, "invoice_id": inv_id}

    def test_so_to_invoice(self) -> dict:
        so = self.req("POST", "/sales/orders/", json={
            "customer_id": CUSTOMER, "customer_name": CUSTOMER_NAME,
            "branch_id": BRANCH,
            "items": [{"item_id": ITEM_TRACKED, "name": ITEM_TRACKED_NAME,
                       "qty": 1, "price": 160, "tax_rate": 18}],
        }, expect=201)
        inv = self.req("POST", f"/sales/orders/{so['id']}/convert", json={
            "payment_received": False,
        }, expect=200)
        inv_id = inv.get("invoice_id") or inv.get("id")
        return {"so": so, "invoice_id": inv_id}

    def test_so_partial_convert(self) -> dict:
        """Phase 2: invoice part of an SO, order stays partially_invoiced."""
        so = self.req("POST", "/sales/orders/", json={
            "customer_id": CUSTOMER, "customer_name": CUSTOMER_NAME,
            "branch_id": BRANCH,
            "items": [{"item_id": ITEM_TRACKED, "name": ITEM_TRACKED_NAME,
                       "qty": 3, "price": 160, "tax_rate": 18}],
        }, expect=201)
        detail = self.req("GET", f"/sales/orders/{so['id']}")
        line_id = detail["items"][0]["id"]
        inv = self.req("POST", f"/sales/orders/{so['id']}/convert", json={
            "payment_received": False,
            "lines": [{"order_line_id": line_id, "qty": 1}],
        }, expect=200)
        assert inv.get("fully_converted") is False
        assert inv.get("order_status") == "partially_invoiced"
        so_row = self.req("GET", f"/sales/orders/{so['id']}")
        assert so_row["status"] == "partially_invoiced"
        assert so_row["items"][0]["qty"] == 2
        return {"so": so, "invoice_id": inv.get("invoice_id")}

    def test_direct_invoice(self) -> dict:
        inv = self.req("POST", "/sales/", json={
            "customer_id": CUSTOMER, "customer_name": CUSTOMER_NAME,
            "branch_id": BRANCH,
            "items": [{"item_id": ITEM_TRACKED, "name": ITEM_TRACKED_NAME,
                       "qty": 1, "price": 160, "tax_rate": 18}],
            "payment_mode": "cash",
        }, expect=201)
        return {"invoice_id": inv["id"]}

    def test_pos_sale_credit_refund(self) -> dict:
        """Phase 4: POS receipt numbering + store-credit refund at till."""
        cust_before = self.req("GET", f"/customers/{CUSTOMER}")
        credit_before = float(cust_before.get("credit_balance") or 0)
        inv = self.req("POST", "/sales/", json={
            "customer_id": CUSTOMER, "customer_name": CUSTOMER_NAME,
            "branch_id": BRANCH,
            "items": [{"item_id": ITEM_TRACKED, "name": ITEM_TRACKED_NAME,
                       "qty": 1, "price": 160, "tax_rate": 18}],
            "payment_mode": "cash",
            "origin": "pos",
        }, expect=201)
        assert str(inv.get("number", "")).startswith("POS-"), "POS sale must get POS- receipt number"
        detail = self.req("GET", f"/sales/{inv['id']}")
        assert (detail.get("origin") or "").lower() == "pos"
        line = detail["items"][0]
        self.req("POST", "/sales/returns/", json={
            "invoice_id": inv["id"],
            "reason": "POS store credit refund",
            "refund_method": "credit",
            "items": [{
                "invoice_line_id": line["id"],
                "item_id": line.get("itemId"),
                "name": line["name"],
                "return_qty": 1,
            }],
        }, expect=201)
        cust_after = self.req("GET", f"/customers/{CUSTOMER}")
        credit_after = float(cust_after.get("credit_balance") or 0)
        assert credit_after >= credit_before + float(inv.get("total") or 0) - 0.01
        return {"invoice_id": inv["id"], "number": inv["number"]}

    def test_sales_return_credit(self, invoice_id: str) -> str:
        inv = self.req("GET", f"/sales/{invoice_id}")
        line = inv["items"][0]
        ret = self.req("POST", "/sales/returns/", json={
            "invoice_id": invoice_id,
            "reason": "Wrong item",
            "refund_method": "credit",
            "items": [{
                "invoice_line_id": line["id"],
                "item_id": line.get("itemId"),
                "name": line["name"],
                "return_qty": 1,
            }],
        }, expect=201)
        inv_after = self.req("GET", f"/sales/{invoice_id}")
        assert inv_after.get("returnStatus") in ("partial", "full")
        return ret.get("id") or ret.get("return_id", "")

    def test_sales_return_void(self, return_id: str, invoice_id: str) -> None:
        if not return_id:
            return
        self.req("POST", f"/sales/returns/{return_id}/void", expect=200)
        inv_after = self.req("GET", f"/sales/{invoice_id}")
        assert inv_after.get("returnStatus") == "none"
        ret_row = self.req("GET", f"/sales/returns/{return_id}")
        assert ret_row.get("status") == "void"

    def test_customer_payment(self, invoice_id: str) -> None:
        inv = self.req("GET", f"/sales/{invoice_id}")
        if inv.get("status") == "paid":
            return
        balance = round(inv["total"] - inv.get("paidAmount", 0), 2)
        if balance <= 0:
            return
        self.req("POST", f"/sales/{invoice_id}/payment", json={
            "amount": balance,
            "mode": "cash",
            "payment_ref": "lifecycle-test",
        }, expect=200)

    def test_guards(self) -> None:
        """Idempotency / terminal-state guards."""
        po = self.req("POST", "/purchases/orders/", json={
            "vendor_id": VENDOR, "branch_id": BRANCH,
            "items": [{"item_id": ITEM_TRACKED, "name": ITEM_TRACKED_NAME,
                       "qty": 1, "cost": 128}],
        }, expect=201)
        self.req("POST", f"/purchases/orders/{po['id']}/convert", json={}, expect=200)
        self.req("POST", f"/purchases/orders/{po['id']}/convert", json={}, expect=400)

    def test_po_partial_receive_guards(self) -> None:
        """PO with pending GRN must not accept convert/receive again."""
        po = self.req("POST", "/purchases/orders/", json={
            "vendor_id": VENDOR, "vendor_name": VENDOR_NAME,
            "branch_id": BRANCH,
            "items": [{"item_id": ITEM_BATCH, "name": ITEM_BATCH_NAME,
                       "qty": 2, "cost": 120, "tax_rate": 5}],
            "notes": "lifecycle guard partial PO",
        }, expect=201)
        self.req("POST", f"/purchases/grns/from-po/{po['id']}", json={}, expect=201)
        self.req("POST", f"/purchases/orders/{po['id']}/convert", json={}, expect=400)
        self.req("POST", f"/purchases/grns/from-po/{po['id']}", json={}, expect=400)


def main() -> int:
    parser = argparse.ArgumentParser(description="Lifecycle smoke tests")
    parser.add_argument("--base", default="http://localhost:8080/api/v1")
    args = parser.parse_args()

    t = LifecycleTester(args.base)
    ctx: dict[str, Any] = {}

    print("═" * 60)
    print("Cosmopolitan Pro — Lifecycle Smoke Tests")
    print("═" * 60)

    t.run("Login", t.test_login)
    t.run("Settings (org / overselling)", t.test_settings)

    def _po_convert():
        ctx["po_bill"] = t.test_po_convert_to_bill()
    t.run("Purchase: PO → Bill convert", _po_convert)

    def _po_grn_bill():
        ctx["po_grn"] = t.test_po_grn_then_bill()
    t.run("Purchase: PO → GRN → Bill", _po_grn_bill)

    def _manual_grn():
        ctx["manual_grn"] = t.test_manual_grn_to_bill()
    t.run("Purchase: Manual GRN → Bill", _manual_grn)

    def _direct_bill():
        ctx["direct_bill"] = t.test_direct_bill()
    t.run("Purchase: Direct bill (auto-GRN)", _direct_bill)

    def _grn_batch():
        ctx["grn_batch"] = t.test_grn_batch_capture()
    t.run("Purchase: GRN batch capture (lot #)", _grn_batch)

    def _inv_batch():
        ctx["inv_batch"] = t.test_invoice_explicit_batch_allocation(
            ctx["grn_batch"]["batch_id"],
        )
    t.run("Sales: Invoice with explicit batch split", _inv_batch)

    def _vendor_return():
        bill_id = ctx["po_bill"]["conv"]["bill_id"]
        ctx["vendor_return_id"] = t.test_vendor_return(bill_id)
        ctx["vendor_return_bill_id"] = bill_id
    t.run("Purchase: Vendor return", _vendor_return)

    def _vendor_return_void():
        t.test_vendor_return_void(
            ctx.get("vendor_return_id", ""),
            ctx.get("vendor_return_bill_id", ""),
        )
    t.run("Purchase: Void vendor return", _vendor_return_void)

    def _vendor_overpay():
        t.test_vendor_overpayment_credit()
    t.run("Purchase: Vendor overpayment credit", _vendor_overpay)

    def _vendor_pay():
        bill_id = ctx["manual_grn"]["bill_id"]
        t.test_vendor_payment(bill_id)
    t.run("Purchase: Vendor payment", _vendor_pay)

    def _quote_so_inv():
        ctx["sales_chain"] = t.test_quote_to_so_to_invoice()
    t.run("Sales: Quote → SO → Invoice", _quote_so_inv)

    def _quote_inv():
        ctx["quote_inv"] = t.test_quote_to_invoice_direct()
    t.run("Sales: Quote → Invoice (direct)", _quote_inv)

    def _so_inv():
        ctx["so_inv"] = t.test_so_to_invoice()
    t.run("Sales: SO → Invoice", _so_inv)

    def _so_partial():
        ctx["so_partial"] = t.test_so_partial_convert()
    t.run("Sales: SO partial convert", _so_partial)

    def _direct_inv():
        ctx["direct_inv"] = t.test_direct_invoice()
    t.run("Sales: Direct invoice", _direct_inv)

    def _pos_refund():
        ctx["pos_refund"] = t.test_pos_sale_credit_refund()
    t.run("POS: Sale + store-credit refund", _pos_refund)

    def _sales_return():
        ctx["return_id"] = t.test_sales_return_credit(ctx["direct_inv"]["invoice_id"])
    t.run("Sales: Return (credit)", _sales_return)

    def _void_return():
        t.test_sales_return_void(ctx.get("return_id", ""), ctx["direct_inv"]["invoice_id"])
    t.run("Sales: Void credit note", _void_return)

    def _cust_pay():
        t.test_customer_payment(ctx["so_inv"]["invoice_id"])
    t.run("Sales: Invoice payment", _cust_pay)

    t.run("Guards: double PO convert rejected", t.test_guards)

    def _po_partial_guard():
        t.test_po_partial_receive_guards()
    t.run("Guards: PO partial receive blocks re-convert", _po_partial_guard)

    print("\n" + "═" * 60)
    print(f"Results: {len(t.passed)} passed, {len(t.failed)} failed")
    if t.failed:
        print("\nFailures:")
        for name, err in t.failed:
            print(f"  ✗ {name}\n    {err}")
        return 1
    print("All lifecycle tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
