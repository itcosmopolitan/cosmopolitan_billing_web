"""add POS stock pools and pool sale allocation ledger

Revision ID: 012_stock_pools
Revises: 011_invoice_customer_snapshots
Create Date: 2026-10-03
"""

from alembic import op
import sqlalchemy as sa


revision = "012_stock_pools"
down_revision = "011_invoice_customer_snapshots"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())

    if "stock_pools" not in tables:
        op.create_table(
            "stock_pools",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("allow_cross_branch_sales", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_by", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("name", name="uq_stock_pools_name"),
        )

    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "stock_pool_branches" not in tables:
        op.create_table(
            "stock_pool_branches",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("pool_id", sa.String(), sa.ForeignKey("stock_pools.id", ondelete="CASCADE"), nullable=False),
            sa.Column("branch_id", sa.String(), sa.ForeignKey("branches.id", ondelete="CASCADE"), nullable=False),
            sa.Column("created_by", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("branch_id", name="uq_stock_pool_branches_branch_id"),
        )
    op.create_index(
        "ix_stock_pool_branches_pool_id",
        "stock_pool_branches",
        ["pool_id"],
        if_not_exists=True,
    )

    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "sale_invoices" in tables:
        columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("sale_invoices")}
        if "client_request_id" not in columns:
            op.add_column("sale_invoices", sa.Column("client_request_id", sa.String(length=64), nullable=True))
        if "pool_drawn" not in columns:
            op.add_column(
                "sale_invoices",
                sa.Column("pool_drawn", sa.Boolean(), nullable=False, server_default=sa.false()),
            )
        op.create_index(
            "uq_sale_invoices_branch_client_request",
            "sale_invoices",
            ["branch_id", "client_request_id"],
            unique=True,
            if_not_exists=True,
        )

    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "pool_sale_allocations" not in tables:
        op.create_table(
            "pool_sale_allocations",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("invoice_id", sa.String(), sa.ForeignKey("sale_invoices.id"), nullable=False),
            sa.Column("invoice_line_id", sa.String(), sa.ForeignKey("sale_line_items.id"), nullable=False),
            sa.Column("pool_id", sa.String(), sa.ForeignKey("stock_pools.id"), nullable=False),
            sa.Column("sale_branch_id", sa.String(), sa.ForeignKey("branches.id"), nullable=False),
            sa.Column("owner_branch_id", sa.String(), sa.ForeignKey("branches.id"), nullable=False),
            sa.Column("item_id", sa.String(), sa.ForeignKey("items.id"), nullable=False),
            sa.Column("qty", sa.Float(), nullable=False),
            sa.Column("unit_cost", sa.Float(), nullable=False, server_default="0"),
            sa.Column("cost_source", sa.String(), nullable=False),
            sa.Column("source_batch_id", sa.String(), sa.ForeignKey("item_batches.id"), nullable=True),
            sa.Column("source_batch_no", sa.String(), nullable=True),
            sa.Column("expiry_date", sa.String(), nullable=True),
            sa.Column("dest_batch_id", sa.String(), sa.ForeignKey("item_batches.id"), nullable=True),
            sa.Column("out_movement_id", sa.String(), sa.ForeignKey("stock_movements.id"), nullable=False),
            sa.Column("in_movement_id", sa.String(), sa.ForeignKey("stock_movements.id"), nullable=False),
            sa.Column("created_by", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        )
    op.create_index(
        "ix_pool_sale_allocations_invoice_id",
        "pool_sale_allocations",
        ["invoice_id"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_pool_sale_allocations_owner_created",
        "pool_sale_allocations",
        ["owner_branch_id", "created_at"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_pool_sale_allocations_sale_created",
        "pool_sale_allocations",
        ["sale_branch_id", "created_at"],
        if_not_exists=True,
    )
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "pool_sale_allocation_reversals" not in tables:
        op.create_table(
            "pool_sale_allocation_reversals",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("allocation_id", sa.String(), sa.ForeignKey("pool_sale_allocations.id"), nullable=False),
            sa.Column("invoice_id", sa.String(), sa.ForeignKey("sale_invoices.id"), nullable=False),
            sa.Column("return_id", sa.String(), sa.ForeignKey("sales_returns.id", ondelete="SET NULL"), nullable=True),
            sa.Column("operation", sa.String(), nullable=False),
            sa.Column("qty_delta", sa.Float(), nullable=False),
            sa.Column("sale_movement_id", sa.String(), sa.ForeignKey("stock_movements.id"), nullable=True),
            sa.Column("owner_movement_id", sa.String(), sa.ForeignKey("stock_movements.id"), nullable=False),
            sa.Column("created_by", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        )
    op.create_index(
        "ix_pool_sale_allocation_reversals_allocation",
        "pool_sale_allocation_reversals",
        ["allocation_id"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_pool_sale_allocation_reversals_return",
        "pool_sale_allocation_reversals",
        ["return_id"],
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("ix_pool_sale_allocation_reversals_return", table_name="pool_sale_allocation_reversals")
    op.drop_index("ix_pool_sale_allocation_reversals_allocation", table_name="pool_sale_allocation_reversals")
    op.drop_table("pool_sale_allocation_reversals")
    op.drop_index("ix_pool_sale_allocations_sale_created", table_name="pool_sale_allocations")
    op.drop_index("ix_pool_sale_allocations_owner_created", table_name="pool_sale_allocations")
    op.drop_index("ix_pool_sale_allocations_invoice_id", table_name="pool_sale_allocations")
    op.drop_table("pool_sale_allocations")
    op.drop_index("uq_sale_invoices_branch_client_request", table_name="sale_invoices")
    op.drop_column("sale_invoices", "pool_drawn")
    op.drop_column("sale_invoices", "client_request_id")
    op.drop_index("ix_stock_pool_branches_pool_id", table_name="stock_pool_branches")
    op.drop_table("stock_pool_branches")
    op.drop_table("stock_pools")
