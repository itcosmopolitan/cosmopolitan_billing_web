from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from src.database import get_db
from src.models import User
from typing import Optional

router = APIRouter()

class LoginRequest(BaseModel):
    email: str
    password: str

DEMO_USERS = {
    "suresh@srimurugan.com":  {"password": "admin123",  "name": "Suresh Anand", "role": "super_admin",      "avatar": "SA", "branch_id": None},
    "kavitha@srimurugan.com": {"password": "branch123", "name": "Kavitha R.",   "role": "branch_manager",   "avatar": "KR", "branch_id": "br-001"},
    "arjun@srimurugan.com":   {"password": "cash123",   "name": "Arjun M.",     "role": "cashier",          "avatar": "AM", "branch_id": "br-001"},
    "deepa@srimurugan.com":   {"password": "inv123",    "name": "Deepa S.",     "role": "inventory_manager","avatar": "DS", "branch_id": "br-002"},
    "mohan@srimurugan.com":   {"password": "branch123", "name": "Mohan K.",     "role": "branch_manager",   "avatar": "MK", "branch_id": "br-002"},
}

@router.post("/login")
async def login(data: LoginRequest):
    user = DEMO_USERS.get(data.email.lower())
    if not user or user["password"] != data.password:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return {
        "token": f"demo-jwt-{data.email.split('@')[0]}",
        "user": {
            "id":        f"usr-{data.email.split('@')[0]}",
            "name":      user["name"],
            "email":     data.email,
            "role":      user["role"],
            "avatar":    user["avatar"],
            "branch_id": user["branch_id"],
        }
    }

@router.post("/logout")
async def logout():
    return {"message": "Logged out"}

@router.get("/me")
async def me():
    # In production: validate JWT and return user
    return {
        "id":    "usr-001",
        "name":  "Suresh Anand",
        "email": "suresh@srimurugan.com",
        "role":  "super_admin",
        "avatar":"SA",
        "permissions": ["*"],
    }
