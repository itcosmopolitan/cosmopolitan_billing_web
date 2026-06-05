-- PostgreSQL read models for the dashboard analytics surface.
-- Run from a migration once the deployment is on PostgreSQL. The FastAPI
-- routes also work directly against normalized tables; these materialized
-- views are the scale path for high-volume stores.

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_sales_summary AS
SELECT
    si.branch_id,
    si.date::date AS sale_date,
    COUNT(*) AS bill_count,
    SUM(si.total) AS revenue,
    SUM(si.paid_amount) AS collected,
    SUM(si.discount) AS discount,
    AVG(si.total) AS average_bill_value
FROM sale_invoices si
WHERE si.status <> 'cancelled'
GROUP BY si.branch_id, si.date::date;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_daily_sales_summary
ON mv_daily_sales_summary (branch_id, sale_date);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_product_sales_summary AS
SELECT
    si.branch_id,
    si.date::date AS sale_date,
    sli.item_id,
    sli.name AS product_name,
    i.category_id,
    i.brand,
    SUM(sli.qty) AS quantity_sold,
    SUM(sli.line_total) AS revenue,
    SUM(sli.line_total - (COALESCE(i.cost_price, 0) * sli.qty)) AS profit
FROM sale_line_items sli
JOIN sale_invoices si ON si.id = sli.invoice_id
LEFT JOIN items i ON i.id = sli.item_id
WHERE si.status <> 'cancelled'
GROUP BY si.branch_id, si.date::date, sli.item_id, sli.name, i.category_id, i.brand;

CREATE INDEX IF NOT EXISTS idx_mv_product_sales_summary_date_branch
ON mv_product_sales_summary (sale_date, branch_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_inventory_snapshot AS
SELECT
    ist.branch_id,
    ist.item_id,
    i.category_id,
    i.brand,
    ist.quantity,
    i.reorder_level,
    (ist.quantity * i.cost_price) AS inventory_value,
    ist.updated_at
FROM item_stock ist
JOIN items i ON i.id = ist.item_id
WHERE i.active = true;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_inventory_snapshot
ON mv_inventory_snapshot (branch_id, item_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_payment_summary AS
SELECT
    si.branch_id,
    si.date::date AS paid_date,
    COALESCE(si.payment_mode, 'cash') AS payment_method,
    COUNT(*) AS bill_count,
    SUM(si.paid_amount) AS collected,
    SUM(si.total - si.paid_amount) AS pending_amount
FROM sale_invoices si
WHERE si.status <> 'cancelled'
GROUP BY si.branch_id, si.date::date, COALESCE(si.payment_mode, 'cash');

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_payment_summary
ON mv_payment_summary (branch_id, paid_date, payment_method);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_staff_performance_summary AS
SELECT
    si.branch_id,
    si.date::date AS sale_date,
    COALESCE(si.cashier, 'Unassigned') AS staff_name,
    COUNT(*) AS bill_count,
    SUM(si.total) AS sales,
    AVG(si.total) AS average_bill_value
FROM sale_invoices si
WHERE si.status <> 'cancelled'
GROUP BY si.branch_id, si.date::date, COALESCE(si.cashier, 'Unassigned');

CREATE INDEX IF NOT EXISTS idx_mv_staff_performance_summary_date_branch
ON mv_staff_performance_summary (sale_date, branch_id, staff_name);

CREATE INDEX IF NOT EXISTS idx_sale_invoices_date_branch
ON sale_invoices (date, branch_id);

CREATE INDEX IF NOT EXISTS idx_sale_invoices_cashier_date
ON sale_invoices (cashier, date);

CREATE INDEX IF NOT EXISTS idx_sale_line_items_product
ON sale_line_items (item_id);

CREATE INDEX IF NOT EXISTS idx_item_stock_product_branch
ON item_stock (item_id, branch_id);

CREATE INDEX IF NOT EXISTS idx_item_batches_expiry_available
ON item_batches (expiry_date)
WHERE quantity > 0;

CREATE INDEX IF NOT EXISTS idx_audit_logs_created
ON audit_logs (created_at DESC);

-- Refresh during low-traffic windows or from a background worker:
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_sales_summary;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_product_sales_summary;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_inventory_snapshot;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_payment_summary;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_staff_performance_summary;
