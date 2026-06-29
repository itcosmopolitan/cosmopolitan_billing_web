from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict


class RiskLevel(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class ModuleType(str, Enum):
    SALES = "Sales"
    INVENTORY = "Inventory"
    FINANCE = "Finance"
    CASH = "Cash"
    PURCHASES = "Purchases"
    AUTH = "Auth"


class AuditLogCreate(BaseModel):
    action: str
    user_id: str
    user_name: str
    user_role: str
    module: ModuleType
    reference_id: str
    detail: str
    risk: RiskLevel = RiskLevel.LOW
    ip_address: Optional[str] = None
    device_info: Optional[str] = None
    branch_id: Optional[str] = None
    metadata_: Optional[dict[str, Any]] = None


class AuditLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    action: str
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    user_role: Optional[str] = None
    module: Optional[str] = None
    reference_id: Optional[str] = None
    detail: Optional[str] = None
    risk: Optional[str] = None
    ip_address: Optional[str] = None
    device_info: Optional[str] = None
    branch_id: Optional[str] = None
    event_metadata: Optional[dict[str, Any]] = None
    metadata_: Optional[dict[str, Any]] = None
    created_at: datetime


class AuditLogListResponse(BaseModel):
    total: int
    page: int
    limit: int
    results: list[AuditLogRead]
