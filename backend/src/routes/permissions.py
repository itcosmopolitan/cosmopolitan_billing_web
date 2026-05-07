"""Read-only catalog of permission strings the frontend can grant."""
from fastapi import APIRouter

from src.permissions import PERMISSIONS

router = APIRouter()


@router.get("/catalog")
async def get_catalog() -> dict[str, list[str]]:
    """Return the full module → [actions] catalog. The Roles editor uses this
    to render its permission matrix; useCan() uses it to expand wildcards."""
    return PERMISSIONS
