import asyncio
import re
import secrets
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.email_utils import send_temp_password_email
from src.models import Branch, Organisation, Role, User, UserBranch
from src.security import hash_password_async

router = APIRouter()

TEMP_PASSWORD_BYTES = 9


def _generate_temp_password() -> str:
    """Cryptographically random URL-safe temp password (~12 chars)."""
    return secrets.token_urlsafe(TEMP_PASSWORD_BYTES)


def is_setup_required(user_count: int, branch_count: int) -> bool:
    return user_count == 0 and branch_count == 0


def _normalize_branch_code(value: str) -> str:
    letters = re.sub(r"[^A-Z]", "", (value or "").upper())
    if len(letters) >= 2:
        return letters[:2]
    if letters:
        return letters + letters[-1]
    return "BR"


def _build_branch_code(name: str, existing_codes: Optional[list[str]] = None, existing_code: Optional[str] = None) -> str:
    base_code = _normalize_branch_code(name if name else "Branch")
    if existing_code and existing_code.upper() == base_code:
        return existing_code.upper()

    candidate = re.sub(r"[^A-Z]", "", base_code.upper())
    used_codes = {re.sub(r"[^A-Z]", "", code.upper()) for code in (existing_codes or []) if code}
    if existing_code:
        used_codes.discard(re.sub(r"[^A-Z]", "", existing_code.upper()))

    if candidate not in used_codes:
        return candidate

    first_start = ord(candidate[0]) if len(candidate) > 0 else ord("A")
    second_start = ord(candidate[1]) if len(candidate) > 1 else ord("A")

    for first_offset in range(0, 26):
        first_letter = chr((first_start - ord("A") + first_offset) % 26 + ord("A"))
        for second_offset in range(0, 26):
            second_letter = chr((second_start - ord("A") + second_offset) % 26 + ord("A"))
            alt = f"{first_letter}{second_letter}"
            if alt not in used_codes:
                return alt

    return "ZZ"


class SetupRequest(BaseModel):
    organizationName: str = Field(..., min_length=1, max_length=200)
    organizationGstin: Optional[str] = Field(None, max_length=20)
    organizationPan: Optional[str] = Field(None, max_length=16)
    organizationAddress: Optional[str] = None
    organizationPhone: Optional[str] = Field(None, max_length=32)
    organizationEmail: Optional[str] = Field(None, max_length=120)
    organizationWebsite: Optional[str] = Field(None, max_length=200)
    branchName: str = Field(..., min_length=1, max_length=200)
    branchPhone: Optional[str] = Field(None, max_length=32)
    branchAddress: Optional[str] = None
    adminName: str = Field(..., min_length=1, max_length=200)
    adminEmail: EmailStr


@router.get("/status")
async def get_setup_status(db: AsyncSession = Depends(get_db)):
    user_count = int((await db.execute(select(func.count(User.id)))).scalar() or 0)
    branch_count = int((await db.execute(select(func.count(Branch.id)))).scalar() or 0)
    return {"required": is_setup_required(user_count, branch_count)}


@router.post("/initialize")
async def initialize_setup(data: SetupRequest, db: AsyncSession = Depends(get_db)):
    user_count = int((await db.execute(select(func.count(User.id)))).scalar() or 0)
    branch_count = int((await db.execute(select(func.count(Branch.id)))).scalar() or 0)
    if not is_setup_required(user_count, branch_count):
        raise HTTPException(409, "Setup has already been completed")

    org_name = (data.organizationName or "").strip()
    if not org_name:
        raise HTTPException(400, "Organization name is required")

    branch_name = (data.branchName or "").strip()
    if not branch_name:
        raise HTTPException(400, "At least one branch is required")

    admin_name = (data.adminName or "").strip()
    if not admin_name:
        raise HTTPException(400, "Admin user name is required")

    normalized_email = str(data.adminEmail).lower().strip()
    existing_user = (await db.execute(select(User).where(User.email == normalized_email))).scalar_one_or_none()
    if existing_user:
        raise HTTPException(409, "A user with this email already exists")

    existing_codes = [row[0] for row in (await db.execute(select(Branch.code))).all() if row[0]]
    branch_code = _build_branch_code(branch_name, existing_codes=existing_codes)

    # Generate a temporary password for the super admin
    temp_password = _generate_temp_password()

    org = Organisation(
        id=f"org-{uuid.uuid4().hex[:8]}",
        name=org_name,
        gstin=(data.organizationGstin or "").strip() or None,
        pan=(data.organizationPan or "").strip() or None,
        address=(data.organizationAddress or "").strip() or None,
        phone=(data.organizationPhone or "").strip() or None,
        email=(data.organizationEmail or "").strip() or None,
        website=(data.organizationWebsite or "").strip() or None,
    )
    db.add(org)
    await db.flush()

    branch = Branch(
        id=str(uuid.uuid4()),
        name=branch_name,
        code=branch_code,
        phone=(data.branchPhone or "").strip() or None,
        address=(data.branchAddress or "").strip() or None,
        active=True,
    )
    db.add(branch)
    await db.flush()

    role = (await db.execute(select(Role).where(Role.key == "super_admin"))).scalar_one_or_none()
    hashed_password = await hash_password_async(temp_password)
    user = User(
        id=str(uuid.uuid4()),
        name=admin_name,
        email=normalized_email,
        hashed_password=hashed_password,
        role="super_admin",
        role_id=role.id if role else None,
        branch_id=branch.id,
        active=True,
        must_change_password=True,  # Force password change on first login
        all_branches=True,
    )
    db.add(user)
    await db.flush()

    available_branches = (await db.execute(select(Branch.id).order_by(Branch.id))).scalars().all()
    for bid in available_branches:
        db.add(UserBranch(user_id=user.id, branch_id=bid))
    await db.commit()
    await db.refresh(org)
    await db.refresh(branch)
    await db.refresh(user)

    # Send temporary password email asynchronously (don't fail setup if email fails)
    try:
        await asyncio.to_thread(
            send_temp_password_email,
            normalized_email,
            temp_password,
            first_name=admin_name,
            welcome=True,
        )
    except Exception:
        pass

    return {
        "message": "Setup completed. A temporary password has been sent to the super admin email.",
        "organization": {
            "id": org.id,
            "name": org.name,
        },
        "branch": {
            "id": branch.id,
            "name": branch.name,
            "code": branch.code,
        },
        "user": {
            "id": user.id,
            "name": user.name,
            "email": user.email,
        },
    }
