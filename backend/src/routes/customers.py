import uuid
from typing import Optional, Union

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import Branch, Customer, CustomerCreditEntry, User
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._serializers import _build_customer_code, serialize_customer
from src.permissions import CUSTOMER_PICKER_READ
from src.security import require_perm, current_user, enforce_branch_access
from src.models import User

router = APIRouter()

_VALID_CUSTOMER_TYPES = frozenset({"retail", "wholesale", "staff"})


class CustomerCreate(BaseModel):
    name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    gst_in: Optional[str] = None
    branch_id: str
    credit_limit: float = 10000
    customer_type: str = "retail"
    key_account_manager: Optional[str] = None
    credit_terms: Optional[str] = None
    street1: str
    street2: Optional[str] = None
    street3: Optional[str] = None
    city: str
    state_province: Optional[str] = None
    country: str
    postal_code: Optional[str] = None


class CustomerUpdate(BaseModel):
    """Typed update body — restricts client-writeable fields. `outstanding`
    and `total_purchases` are derived by sales/payment flows and must not be
    settable via PATCH.

    Field names mirror the public API contract (`gst_in`, `customer_type`)
    used by `CustomerCreate` and `serialize_customer`, NOT the underlying
    SQLAlchemy column names (`gstin`, `type`). Pydantic v2's default
    `extra="ignore"` would silently drop API-named keys otherwise, leaving
    those columns silently un-updated on a round-trip GET → mutate → PUT.
    The handler below maps API names → column names via `_FIELD_TO_COLUMN`.
    """
    name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    gst_in: Optional[str] = None
    branch_id: Optional[str] = None
    credit_limit: Optional[float] = None
    customer_type: Optional[str] = None
    key_account_manager: Optional[str] = None
    credit_terms: Optional[str] = None
    street1: Optional[str] = None
    street2: Optional[str] = None
    street3: Optional[str] = None
    city: Optional[str] = None
    state_province: Optional[str] = None
    country: Optional[str] = None
    postal_code: Optional[str] = None
    notes: Optional[str] = None
    active: Optional[bool] = None


def _normalize_customer_type(customer_type: Optional[str]) -> str:
    value = (customer_type or "retail").strip().lower()
    if value not in _VALID_CUSTOMER_TYPES:
        raise HTTPException(
            400,
            f"Invalid customer_type '{customer_type}'. Expected one of: retail, wholesale, staff",
        )
    return value


# Map CustomerUpdate field names → Customer ORM column names where they
# differ. Single source of truth so PUT and POST can't drift again.
_FIELD_TO_COLUMN = {
    "gst_in": "gstin",
    "customer_type": "type",
}

@router.get("/", dependencies=[Depends(require_perm(*CUSTOMER_PICKER_READ))])
async def list_customers(
    search: Optional[str] = None,
    customer_type: Optional[str] = None,
    branch_id: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    q = select(Customer)
    cq = select(func.count(Customer.id))
    if search:
        term = f"%{search}%"
        q = q.where(
            or_(
                Customer.name.ilike(term),
                Customer.phone.ilike(term),
                Customer.email.ilike(term),
            )
        )
        cq = cq.where(
            or_(
                Customer.name.ilike(term),
                Customer.phone.ilike(term),
                Customer.email.ilike(term),
            )
        )
    if customer_type:
        q = q.where(Customer.type == customer_type)
        cq = cq.where(Customer.type == customer_type)
    if branch_id:
        q = q.where(Customer.branch_id == branch_id)
        cq = cq.where(Customer.branch_id == branch_id)
    total = int((await db.execute(cq)).scalar() or 0)
    conds = []
    if search:
        term = f"%{search}%"
        conds.append(
            or_(
                Customer.name.ilike(term),
                Customer.phone.ilike(term),
                Customer.email.ilike(term),
            )
        )
    if customer_type:
        conds.append(Customer.type == customer_type)
    if branch_id:
        conds.append(Customer.branch_id == branch_id)
    outstanding_total = float(
        (
            await db.execute(
                select(func.coalesce(func.sum(Customer.outstanding), 0)).where(and_(*conds) if conds else True)
            )
        ).scalar()
        or 0
    )
    wb_filter = and_(Customer.outstanding > 0, *conds) if conds else (Customer.outstanding > 0)
    with_balance = int((await db.execute(select(func.count(Customer.id)).where(wb_filter))).scalar() or 0)
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "name": Customer.name,
            "phone": Customer.phone,
            "email": Customer.email,
            "customer_type": Customer.type,
            "credit_limit": Customer.credit_limit,
            "outstanding": Customer.outstanding,
            "total_purchases": Customer.total_purchases,
            "created_at": Customer.created_at,
        },
        default_key="name",
        default_order="asc",
    )
    result = await db.execute(q.order_by(sort_expr).offset(sk).limit(lim))
    customers = result.scalars().all()
    await _attach_kam_names(db, customers)
    items = [serialize_customer(c) for c in customers]
    return paged(
        items,
        total,
        sk,
        lim,
        summary={"outstandingTotal": outstanding_total, "withBalanceCount": with_balance},
    )

@router.get("/{customer_id}", dependencies=[Depends(require_perm(*CUSTOMER_PICKER_READ))])
async def get_customer(customer_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Customer).where(Customer.id == customer_id))
    c = result.scalar_one_or_none()
    if not c:
        raise HTTPException(404, "Customer not found")
    await _attach_kam_names(db, [c])
    return serialize_customer(c)


@router.get("/{customer_id}/credit-ledger", dependencies=[Depends(require_perm("customers.view"))])
async def customer_credit_ledger(
    customer_id: str,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    """Append-only store-credit ledger for a customer (Sales Phase 1)."""
    exists = (
        await db.execute(select(Customer.id).where(Customer.id == customer_id))
    ).scalar_one_or_none()
    if not exists:
        raise HTTPException(404, "Customer not found")

    total = int(
        (
            await db.execute(
                select(func.count(CustomerCreditEntry.id)).where(
                    CustomerCreditEntry.customer_id == customer_id
                )
            )
        ).scalar()
        or 0
    )
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    rows = (
        await db.execute(
            select(CustomerCreditEntry)
            .where(CustomerCreditEntry.customer_id == customer_id)
            .order_by(CustomerCreditEntry.created_at.desc(), CustomerCreditEntry.id.desc())
            .offset(sk)
            .limit(lim)
        )
    ).scalars().all()

    def _entry_type_label(t: str) -> str:
        labels = {
            "sale_debit": "Credit sale",
            "payment_debit": "Credit payment",
            "overpayment": "Overpayment credit",
            "return_credit": "Return credit",
            "return_void_revoke": "Return void (revoke)",
            "void_restore": "Payment void (restore)",
            "void_revoke": "Payment void (revoke)",
        }
        return labels.get(t, t.replace("_", " ").title())

    items = [{
        "id": e.id,
        "entryType": e.entry_type,
        "entryLabel": _entry_type_label(e.entry_type),
        "delta": round(float(e.delta or 0), 2),
        "balanceBefore": round(float(e.balance_before or 0), 2),
        "balanceAfter": round(float(e.balance_after or 0), 2),
        "sourceType": e.source_type,
        "sourceRef": e.source_ref,
        "sourceNumber": e.source_number,
        "notes": e.notes,
        "date": e.date,
        "createdBy": e.created_by,
        "createdAt": e.created_at.isoformat() if e.created_at else None,
    } for e in rows]
    return paged(items, total, sk, lim)

async def _validate_branch_id(branch_id: str, db: AsyncSession) -> None:
    result = await db.execute(select(Branch.id).where(Branch.id == branch_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(400, f"Unknown branch: {branch_id}")

def _compose_address_from_parts(data: Union[CustomerCreate, CustomerUpdate]) -> str:
    parts = [
        getattr(data, 'street1', None),
        getattr(data, 'street2', None),
        getattr(data, 'street3', None),
        getattr(data, 'city', None),
        getattr(data, 'state_province', None),
        getattr(data, 'country', None),
        getattr(data, 'postal_code', None),
    ]
    return ", ".join([p.strip() for p in parts if isinstance(p, str) and p.strip()])


async def _attach_kam_names(db: AsyncSession, customers: list[Customer]) -> None:
    """Resolve key_account_manager user ids → display names on each customer."""
    kam_ids = {
        c.key_account_manager
        for c in customers
        if getattr(c, "key_account_manager", None)
    }
    if not kam_ids:
        return
    rows = (
        await db.execute(select(User.id, User.name).where(User.id.in_(kam_ids)))
    ).all()
    name_by_id = {row.id: row.name for row in rows}
    for c in customers:
        kam = getattr(c, "key_account_manager", None)
        # Fall back to the raw value for legacy free-text entries.
        c._key_account_manager_name = name_by_id.get(kam) or kam


@router.post("/", status_code=201, dependencies=[Depends(require_perm("customers.create"))])
async def create_customer(data: CustomerCreate, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    await _validate_branch_id(data.branch_id, db)
    await enforce_branch_access(data.branch_id, user=user, db=db)
    customer_type = _normalize_customer_type(data.customer_type)
    address = _compose_address_from_parts(data)
    customer_id = str(uuid.uuid4())
    customer_code = _build_customer_code(customer_id)
    c = Customer(id=customer_id, name=data.name, phone=data.phone,
                 email=data.email, address=address, customer_code=customer_code,
                 gstin=data.gst_in, branch_id=data.branch_id,
                 credit_limit=data.credit_limit, type=customer_type,
                 key_account_manager=(data.key_account_manager or None),
                 credit_terms=(data.credit_terms or None),
                 street1=data.street1, street2=data.street2, street3=data.street3,
                 city=data.city, state_province=data.state_province,
                 country=data.country, postal_code=data.postal_code)
    db.add(c)
    await db.commit()
    return {"id": c.id, "message": "Customer created"}

@router.put("/{customer_id}", dependencies=[Depends(require_perm("customers.edit"))])
async def update_customer(customer_id: str, data: CustomerUpdate, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    result = await db.execute(select(Customer).where(Customer.id == customer_id))
    c = result.scalar_one_or_none()
    if not c:
        raise HTTPException(404, "Customer not found")
    items = data.model_dump(exclude_unset=True)
    if "branch_id" in items:
        await _validate_branch_id(items["branch_id"], db)
        await enforce_branch_access(items["branch_id"], user=user, db=db)
    if "customer_type" in items:
        items["customer_type"] = _normalize_customer_type(items["customer_type"])

    if any(k in items for k in [
        "street1", "street2", "street3", "city", "state_province", "country", "postal_code"
    ]):
        for k, v in items.items():
            if k in ["street1", "street2", "street3", "city", "state_province", "country", "postal_code"]:
                setattr(c, k, v)
        c.address = _compose_address_from_parts(data)

    for k, v in items.items():
        if k in ["street1", "street2", "street3", "city", "state_province", "country", "postal_code"]:
            continue
        setattr(c, _FIELD_TO_COLUMN.get(k, k), v)

    if not c.customer_code:
        c.customer_code = _build_customer_code(c.id)
    await db.commit()
    return {"message": "Updated"}
