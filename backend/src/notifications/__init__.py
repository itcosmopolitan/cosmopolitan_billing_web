"""In-app notification evaluation (Phases 6a–6e)."""

from src.notifications.evaluator import (
    NotificationCandidate,
    evaluate_notification_ids,
    evaluate_notifications,
    gather_scan_candidates,
    invalidate_notification_cache,
)
from src.notifications.hub import hub
from src.notifications.kinds import KIND_PERMS, can_see_any, can_see_kind
from src.notifications.scanner import run_notification_scan
from src.notifications.stock_alerts import (
    refresh_stock_alerts_and_notify,
    refresh_stock_alerts_for_item,
)
from src.notifications.store import (
    emit_adjustment_pending,
    emit_item_pending,
    emit_po_pending,
    emit_transfer_in_transit,
    emit_transfer_pending,
    list_for_user,
    mark_all_read,
    mark_read,
    notify_refresh,
    resolve_notification,
    unread_count_for_user,
    unread_ids_for_user,
    upsert_from_candidate,
    upsert_notification,
)

__all__ = [
    "NotificationCandidate",
    "KIND_PERMS",
    "can_see_kind",
    "can_see_any",
    "evaluate_notifications",
    "evaluate_notification_ids",
    "gather_scan_candidates",
    "invalidate_notification_cache",
    "hub",
    "run_notification_scan",
    "refresh_stock_alerts_for_item",
    "refresh_stock_alerts_and_notify",
    "list_for_user",
    "mark_read",
    "mark_all_read",
    "notify_refresh",
    "resolve_notification",
    "upsert_notification",
    "upsert_from_candidate",
    "emit_adjustment_pending",
    "emit_transfer_pending",
    "emit_transfer_in_transit",
    "emit_po_pending",
    "emit_item_pending",
    "unread_count_for_user",
    "unread_ids_for_user",
]
