import pytest
from pydantic import ValidationError

from src.routes.purchases import PaymentIn as PurchasePaymentIn
from src.routes.purchases import PurchaseCreate, VendorPaymentCreate
from src.routes.sales import ConvertToInvoiceIn, CustomerPaymentCreate, InvoiceUpdate, SaleCreate
from src.routes.sales import PaymentIn as CustomerInvoicePaymentIn


def test_new_sales_payment_accepts_cheque_and_rejects_upi():
    sale = SaleCreate(
        branch_id="branch-1",
        items=[],
        payment_mode="cheque",
        payment_ref="CHQ-102",
    )
    assert sale.payment_mode == "cheque"
    assert sale.payment_ref == "CHQ-102"

    with pytest.raises(ValidationError, match="UPI is no longer accepted"):
        SaleCreate(branch_id="branch-1", items=[], payment_mode="upi")


def test_cheque_reference_is_required_for_payment_entry_schemas():
    with pytest.raises(ValidationError, match="cheque number is required"):
        CustomerInvoicePaymentIn(amount=20, mode="cheque")
    assert CustomerInvoicePaymentIn(amount=20, mode="cheque", ref="CHQ-202").mode == "cheque"

    with pytest.raises(ValidationError, match="cheque number is required"):
        PurchasePaymentIn(amount=20, mode="cheque")
    assert PurchasePaymentIn(amount=20, mode="cheque", ref="CHQ-203").mode == "cheque"


def test_purchase_creation_accepts_cheque_and_rejects_upi():
    bill = PurchaseCreate(
        vendor_id="vendor-1",
        branch_id="branch-1",
        items=[],
        payment_mode="cheque",
        payment_ref="CHQ-301",
    )
    assert bill.payment_mode == "cheque"
    assert bill.payment_ref == "CHQ-301"

    with pytest.raises(ValidationError, match="UPI is no longer accepted"):
        PurchaseCreate(
            vendor_id="vendor-1",
            branch_id="branch-1",
            items=[],
            payment_mode="upi",
        )


def test_cheque_reference_is_required_for_multi_document_payments_and_conversion():
    with pytest.raises(ValidationError, match="cheque number is required"):
        CustomerPaymentCreate(
            customer_id="customer-1",
            payment_mode="cheque",
            allocations=[{"invoice_id": "invoice-1", "amount": 20}],
        )
    with pytest.raises(ValidationError, match="cheque number is required"):
        VendorPaymentCreate(
            vendor_id="vendor-1",
            payment_mode="cheque",
            allocations=[{"bill_id": "bill-1", "amount": 20}],
        )
    with pytest.raises(ValidationError, match="cheque number is required"):
        ConvertToInvoiceIn(payment_received=True, payment_mode="cheque")


def test_historical_upi_remains_readable_for_existing_payment_edits():
    invoice = InvoiceUpdate(items=[], payment_mode="upi")
    assert invoice.payment_mode == "upi"
    payment = CustomerPaymentCreate(
        customer_id="customer-1",
        payment_mode="upi",
        allocations=[{"invoice_id": "invoice-1", "amount": 20}],
    )
    assert payment.payment_mode == "upi"
