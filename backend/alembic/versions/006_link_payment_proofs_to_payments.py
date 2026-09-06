"""link payment proofs to individual payments

Revision ID: 006_link_payment_proofs_to_payments
Revises: 005_add_invoice_payment_proofs
Create Date: 2026-09-06 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "006_link_payment_proofs_to_payments"
down_revision = "005_add_invoice_payment_proofs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("invoice_payment_proofs")}
    if "payment_id" not in columns:
        op.add_column(
            "invoice_payment_proofs",
            sa.Column("payment_id", sa.String(), sa.ForeignKey("customer_payments.id"), nullable=True),
        )


def downgrade() -> None:
    op.drop_column("invoice_payment_proofs", "payment_id")