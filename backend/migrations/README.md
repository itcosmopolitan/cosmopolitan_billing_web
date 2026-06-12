Migration files in this folder are plain SQL files meant to be applied
against a PostgreSQL database. The dashboard materialized views require
PostgreSQL; do NOT run these on SQLite.

To apply the migration (example using psql):

1. Copy the SQL file to the server or run locally with a DB connection:

```bash
psql "$DATABASE_URL" -f backend/migrations/20260605_add_dashboard_mvs.sql
```

2. Refresh materialized views (preferably during a maintenance window):

```bash
psql "$DATABASE_URL" -c "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_sales_summary;"
psql "$DATABASE_URL" -c "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_product_sales_summary;"
psql "$DATABASE_URL" -c "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_inventory_snapshot;"
psql "$DATABASE_URL" -c "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_payment_summary;"
psql "$DATABASE_URL" -c "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_refund_summary;"
psql "$DATABASE_URL" -c "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_staff_performance_summary;"
```

Notes:
- If your Postgres user lacks `CONCURRENTLY` privileges or the view lacks
  a unique index, omit `CONCURRENTLY`.
- Consider running refreshes in a background worker or cron during low traffic.
- For slow date-range queries, use `EXPLAIN ANALYZE` and verify the materialized
  view is using the `date` and `branch_id` indexes defined by the migration.
