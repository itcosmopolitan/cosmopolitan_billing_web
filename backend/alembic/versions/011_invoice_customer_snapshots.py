"""store customer-facing invoice details as immutable snapshots

Revision ID: 011_invoice_customer_snapshots
Revises: 010_user_account_status
Create Date: 2026-09-22
"""

from alembic import op
import sqlalchemy as sa


revision = "011_invoice_customer_snapshots"
down_revision = "010_user_account_status"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "sale_invoices" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("sale_invoices")}
    additions = {
        "customer_phone_snapshot": sa.String(),
        "customer_gstin_snapshot": sa.String(),
        "customer_address_snapshot": sa.Text(),
        "customer_credit_terms_snapshot": sa.String(),
        "customer_key_account_manager_snapshot": sa.String(),
        "customer_key_account_manager_name_snapshot": sa.String(),
        "quotation_number_snapshot": sa.String(),
    }
    for name, column_type in additions.items():
        if name not in columns:
            op.add_column("sale_invoices", sa.Column(name, column_type, nullable=True))

    invoices = sa.table(
        "sale_invoices",
        sa.column("id", sa.String),
        sa.column("customer_id", sa.String),
        sa.column("customer_phone_snapshot", sa.String),
        sa.column("customer_gstin_snapshot", sa.String),
        sa.column("customer_address_snapshot", sa.Text),
        sa.column("customer_credit_terms_snapshot", sa.String),
        sa.column("customer_key_account_manager_snapshot", sa.String),
        sa.column("customer_key_account_manager_name_snapshot", sa.String),
    )
    customers = sa.table(
        "customers",
        sa.column("id", sa.String),
        sa.column("phone", sa.String),
        sa.column("gstin", sa.String),
        sa.column("address", sa.Text),
        sa.column("street1", sa.String),
        sa.column("street2", sa.String),
        sa.column("street3", sa.String),
        sa.column("city", sa.String),
        sa.column("state_province", sa.String),
        sa.column("country", sa.String),
        sa.column("postal_code", sa.String),
        sa.column("credit_terms", sa.String),
        sa.column("key_account_manager", sa.String),
    )
    bind = op.get_bind()
    rows = bind.execute(
        sa.select(
            invoices.c.id.label("invoice_id"),
            customers.c.phone,
            customers.c.gstin,
            customers.c.address,
            customers.c.street1,
            customers.c.street2,
            customers.c.street3,
            customers.c.city,
            customers.c.state_province,
            customers.c.country,
            customers.c.postal_code,
            customers.c.credit_terms,
            customers.c.key_account_manager,
        ).select_from(
            invoices.join(customers, invoices.c.customer_id == customers.c.id)
        )
    ).mappings()
    for row in rows:
        address = ", ".join(
            str(row[field]).strip()
            for field in ("street1", "street2", "street3", "city", "state_province", "country", "postal_code")
            if row[field] and str(row[field]).strip()
        ) or row["address"] or None
        bind.execute(
            invoices.update().where(invoices.c.id == row["invoice_id"]).values(
                customer_phone_snapshot=row["phone"],
                customer_gstin_snapshot=row["gstin"],
                customer_address_snapshot=address,
                customer_credit_terms_snapshot=row["credit_terms"],
                customer_key_account_manager_snapshot=row["key_account_manager"],
                customer_key_account_manager_name_snapshot=row["key_account_manager"],
            )
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "sale_invoices" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("sale_invoices")}
    for name in (
        "quotation_number_snapshot",
        "customer_key_account_manager_snapshot",
        "customer_key_account_manager_name_snapshot",
        "customer_credit_terms_snapshot",
        "customer_address_snapshot",
        "customer_gstin_snapshot",
        "customer_phone_snapshot",
    ):
        if name in columns:
            op.drop_column("sale_invoices", name)