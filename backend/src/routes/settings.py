"""
Settings — organisation profile and document numbering configuration.
"""
from __future__ import annotations

import uuid
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.document_numbering import get_counter_seq, peek_next_number, serialize_numbering
from src.invoice_template_defaults import (
    DEFAULT_INVOICE_TEMPLATE,
    DEFAULT_INVOICE_TEMPLATE_ID,
    LEGACY_HEADER_STYLES,
    LEGACY_TAX_DISPLAY,
    VALID_HEADER_STYLES,
    VALID_TAX_MODES,
)
from src.models import (
    DocumentNumberCounter,
    DocumentNumbering,
    GoodsReceiptNote,
    InvoiceTemplateSettings,
    Organisation,
    PurchaseOrder,
    SalesOrder,
)
from src.routes._numbering import parse_numbering_config, serialize_numbering_config
from src.permissions import BILLING_SETTINGS_READ
from src.security import current_user, require_perm

router = APIRouter()

VALID_FINANCIAL_YEARS = ("Apr-Mar", "Jan-Dec")


class NumberingEntry(BaseModel):
    prefix: str = Field(..., min_length=1, max_length=12)
    start: int = Field(..., ge=1, le=999999)


class NumberingConfig(BaseModel):
    pos: NumberingEntry
    invoice: NumberingEntry


class OrganisationUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: Optional[str] = Field(None, min_length=1, max_length=200)
    gstin: Optional[str] = Field(None, max_length=20)
    pan: Optional[str] = Field(None, max_length=16)
    address: Optional[str] = None
    phone: Optional[str] = Field(None, max_length=32)
    email: Optional[str] = Field(None, max_length=120)
    website: Optional[str] = Field(None, max_length=200)
    state_code: Optional[str] = Field(None, max_length=4, alias="stateCode")
    financial_year: Optional[str] = Field(None, max_length=16, alias="financialYear")
    logo_url: Optional[str] = Field(None, max_length=500, alias="logoUrl")
    allow_overselling: Optional[bool] = Field(None, alias="allowOverselling")
    numbering_config: Optional[NumberingConfig] = Field(None, alias="numberingConfig")


def _numbering_out(raw: Optional[str]) -> dict[str, Any]:
    cfg = parse_numbering_config(raw)
    return {
        "pos": {"prefix": cfg["pos"]["prefix"], "start": cfg["pos"]["start"]},
        "invoice": {"prefix": cfg["invoice"]["prefix"], "start": cfg["invoice"]["start"]},
    }


def _serialize_organisation(org: Organisation) -> dict:
    return {
        "id": org.id,
        "name": org.name,
        "gstin": org.gstin or "",
        "pan": org.pan or "",
        "address": org.address or "",
        "phone": org.phone or "",
        "email": org.email or "",
        "website": org.website or "",
        "state_code": org.state_code or "33",
        "financial_year": org.financial_year or "Apr-Mar",
        "logo_url": org.logo_url or "",
        "allowOverselling": bool(getattr(org, "allow_overselling", True)),
        "numberingConfig": _numbering_out(getattr(org, "numbering_config", None)),
    }


async def _get_organisation(db: AsyncSession) -> Optional[Organisation]:
    return (await db.execute(select(Organisation).limit(1))).scalar_one_or_none()


@router.get("/organisation", dependencies=[Depends(require_perm(*BILLING_SETTINGS_READ))])
async def get_organisation(db: AsyncSession = Depends(get_db)):
    org = await _get_organisation(db)
    if not org:
        return {
            "id": None,
            "name": "",
            "gstin": "",
            "pan": "",
            "address": "",
            "phone": "",
            "email": "",
            "website": "",
            "state_code": "33",
            "financial_year": "Apr-Mar",
            "logo_url": "",
            "allowOverselling": True,
            "numberingConfig": _numbering_out(None),
        }
    return _serialize_organisation(org)


@router.put("/organisation", dependencies=[Depends(require_perm("settings.edit"))])
async def update_organisation(
    data: OrganisationUpdate,
    db: AsyncSession = Depends(get_db),
):
    org = await _get_organisation(db)
    payload = data.model_dump(exclude_unset=True)

    if "financial_year" in payload:
        fy = (payload["financial_year"] or "").strip()
        if fy and fy not in VALID_FINANCIAL_YEARS:
            raise HTTPException(400, "financial_year must be 'Apr-Mar' or 'Jan-Dec'")
        payload["financial_year"] = fy or "Apr-Mar"

    if not org:
        name = (payload.get("name") or "").strip()
        if not name:
            raise HTTPException(400, "Company name is required")
        org = Organisation(id=f"org-{uuid.uuid4().hex[:8]}", name=name)
        db.add(org)
    elif "name" in payload:
        name = (payload["name"] or "").strip()
        if not name:
            raise HTTPException(400, "Company name is required")
        payload["name"] = name

    # Apply scalar fields from payload for create path / legacy PUT clients.
    for key, val in payload.items():
        if key in ("allow_overselling", "numbering_config"):
            continue
        setattr(org, key, val if val is not None else "")

    await _apply_organisation_update(org, data)
    await db.commit()
    await db.refresh(org)
    return _serialize_organisation(org)


async def _apply_organisation_update(org: Organisation, data: OrganisationUpdate) -> None:
    if data.name is not None:
        org.name = data.name
    if data.gstin is not None:
        org.gstin = data.gstin
    if data.pan is not None:
        org.pan = data.pan
    if data.address is not None:
        org.address = data.address
    if data.phone is not None:
        org.phone = data.phone
    if data.email is not None:
        org.email = data.email
    if data.website is not None:
        org.website = data.website
    if data.state_code is not None:
        org.state_code = data.state_code
    if data.financial_year is not None:
        org.financial_year = data.financial_year
    if data.logo_url is not None:
        org.logo_url = data.logo_url
    if data.allow_overselling is not None:
        org.allow_overselling = data.allow_overselling
    if data.numbering_config is not None:
        merged = parse_numbering_config(None)
        merged["pos"] = {
            "prefix": data.numbering_config.pos.prefix.strip().upper(),
            "start": data.numbering_config.pos.start,
        }
        merged["invoice"] = {
            "prefix": data.numbering_config.invoice.prefix.strip().upper(),
            "start": data.numbering_config.invoice.start,
        }
        org.numbering_config = serialize_numbering_config(merged)


@router.patch("/organisation", dependencies=[Depends(require_perm("settings.edit"))])
async def patch_organisation(
    data: OrganisationUpdate,
    db: AsyncSession = Depends(get_db),
):
    org = await _get_organisation(db)
    if not org:
        raise HTTPException(404, "Organisation not configured")
    await _apply_organisation_update(org, data)
    await db.commit()
    await db.refresh(org)
    return _serialize_organisation(org)


class NumberingUpdate(BaseModel):
    prefix: Optional[str] = Field(None, min_length=1, max_length=16)
    format: Optional[str] = Field(None, min_length=3, max_length=64)
    scope: Optional[Literal["per_branch", "centralised"]] = None
    next_seq: Optional[int] = Field(None, ge=1, le=9_999_999)


@router.get("/numbering", dependencies=[Depends(require_perm("settings.view"))])
async def list_numbering(db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(select(DocumentNumbering).order_by(DocumentNumbering.label))
    ).scalars().all()
    if not rows:
        return []
    out = []
    for row in rows:
        seq = await get_counter_seq(db, row.doc_type, row.scope or "per_branch", None)
        if row.scope == "centralised":
            out.append(serialize_numbering(row, seq))
        else:
            # Per-branch: show the configured starting / minimum sequence.
            out.append(serialize_numbering(row, int(row.next_seq or 1)))
    return out


@router.get("/numbering/preview")
async def preview_document_number(
    doc_type: str,
    branch_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user=Depends(current_user),
):
    """Peek the next document number without reserving it (form default)."""
    dt = doc_type.strip().lower()
    if dt in ("quotation", "sales_invoice", "purchase_bill", "pos_receipt", "credit_note", "stock_transfer", "stock_adjustment"):
        number = await peek_next_number(db, dt, branch_id=branch_id)
        return {"doc_type": dt, "number": number}
    year = datetime.now().year
    if dt == "sales_order":
        count = (await db.execute(select(func.count(SalesOrder.id)))).scalar() or 0
        return {"doc_type": dt, "number": f"SO-{year}-{1000 + count}"}
    if dt == "purchase_order":
        count = (await db.execute(select(func.count(PurchaseOrder.id)))).scalar() or 0
        return {"doc_type": dt, "number": f"PO-{year}-{1000 + count:04d}"}
    if dt == "grn":
        count = (await db.execute(select(func.count(GoodsReceiptNote.id)))).scalar() or 0
        return {"doc_type": dt, "number": f"GRN-{year}-{500 + count:04d}"}
    raise HTTPException(400, f"Unknown document type: {doc_type}")


@router.put(
    "/numbering/{doc_type}",
    dependencies=[Depends(require_perm("settings.edit"))],
)
async def update_numbering(
    doc_type: str,
    data: NumberingUpdate,
    db: AsyncSession = Depends(get_db),
):
    row = (
        await db.execute(
            select(DocumentNumbering).where(DocumentNumbering.doc_type == doc_type)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Document type not found")

    payload = data.model_dump(exclude_unset=True)
    if "format" in payload and "#" not in payload["format"]:
        raise HTTPException(400, "Format must include a # sequence placeholder (e.g. ####)")
    if "scope" in payload and payload["scope"] not in ("per_branch", "centralised"):
        raise HTTPException(400, "Scope must be per_branch or centralised")

    old_scope = row.scope
    for key, val in payload.items():
        setattr(row, key, val)

    # When next_seq is bumped, reset counters so the new floor takes effect.
    if "next_seq" in payload:
        counters = (
            await db.execute(
                select(DocumentNumberCounter).where(
                    DocumentNumberCounter.doc_type == doc_type
                )
            )
        ).scalars().all()
        for c in counters:
            c.next_seq = int(payload["next_seq"])

    # Scope change clears branch-specific counters so allocation restarts cleanly.
    if "scope" in payload and payload["scope"] != old_scope:
        counters = (
            await db.execute(
                select(DocumentNumberCounter).where(
                    DocumentNumberCounter.doc_type == doc_type
                )
            )
        ).scalars().all()
        for c in counters:
            await db.delete(c)

    await db.commit()
    await db.refresh(row)
    seq = await get_counter_seq(db, row.doc_type, row.scope or "per_branch", None)
    return serialize_numbering(row, seq)


class InvoiceTemplateUpdate(BaseModel):
    header_style: Optional[str] = Field(None, max_length=32)
    show_attr: Optional[bool] = None
    show_size: Optional[bool] = None
    show_disc: Optional[bool] = None
    show_hsn: Optional[bool] = None
    tax_mode: Optional[str] = Field(None, max_length=32)
    show_customer: Optional[bool] = None
    show_payment: Optional[bool] = None
    show_printed_date: Optional[bool] = None
    show_store: Optional[bool] = None
    show_cashier: Optional[bool] = None
    footer_msg: Optional[str] = None
    footer_note: Optional[str] = None


def _normalize_header_style(value: Optional[str]) -> str:
    style = (value or "").strip()
    return LEGACY_HEADER_STYLES.get(style, style) or DEFAULT_INVOICE_TEMPLATE["header_style"]


def _normalize_tax_mode(value: Optional[str]) -> str:
    mode = (value or "").strip()
    return LEGACY_TAX_DISPLAY.get(mode, mode) or DEFAULT_INVOICE_TEMPLATE["tax_mode"]


def _default_invoice_template() -> dict:
    cfg = DEFAULT_INVOICE_TEMPLATE
    return {
        "id": None,
        "header_style": cfg["header_style"],
        "show_attr": cfg["show_attr"],
        "show_size": cfg["show_size"],
        "show_disc": cfg["show_disc"],
        "show_hsn": cfg["show_hsn"],
        "tax_mode": cfg["tax_mode"],
        "show_customer": cfg["show_customer"],
        "show_payment": cfg["show_payment"],
        "show_printed_date": cfg["show_printed_date"],
        "show_store": cfg["show_store"],
        "show_cashier": cfg["show_cashier"],
        "footer_msg": cfg["footer_msg"],
        "footer_note": cfg["footer_note"],
    }


def _serialize_invoice_template(row: InvoiceTemplateSettings) -> dict:
    header_style = _normalize_header_style(row.header_style)
    tax_mode = _normalize_tax_mode(getattr(row, "tax_mode", None) or row.tax_display)
    footer_msg = row.footer_msg or row.footer_text or DEFAULT_INVOICE_TEMPLATE["footer_msg"]
    footer_note = row.footer_note or row.terms_text or DEFAULT_INVOICE_TEMPLATE["footer_note"]
    show_attr = row.show_attr if row.show_attr is not None else bool(row.show_item_description)
    return {
        "id": row.id,
        "header_style": header_style if header_style in VALID_HEADER_STYLES else DEFAULT_INVOICE_TEMPLATE["header_style"],
        "show_attr": bool(show_attr),
        "show_size": bool(row.show_size if row.show_size is not None else True),
        "show_disc": bool(row.show_disc if row.show_disc is not None else True),
        "show_hsn": bool(row.show_hsn),
        "tax_mode": tax_mode if tax_mode in VALID_TAX_MODES else DEFAULT_INVOICE_TEMPLATE["tax_mode"],
        "show_customer": bool(row.show_customer if row.show_customer is not None else True),
        "show_payment": bool(row.show_payment if row.show_payment is not None else True),
        "show_printed_date": bool(row.show_printed_date if row.show_printed_date is not None else True),
        "show_store": bool(row.show_store if row.show_store is not None else True),
        "show_cashier": bool(row.show_cashier if row.show_cashier is not None else True),
        "footer_msg": footer_msg or "",
        "footer_note": footer_note or "",
    }


async def _get_invoice_template(db: AsyncSession) -> Optional[InvoiceTemplateSettings]:
    return (await db.execute(select(InvoiceTemplateSettings).limit(1))).scalar_one_or_none()


@router.get("/invoice-template", dependencies=[Depends(require_perm(*BILLING_SETTINGS_READ))])
async def get_invoice_template(db: AsyncSession = Depends(get_db)):
    row = await _get_invoice_template(db)
    if not row:
        return _default_invoice_template()
    return _serialize_invoice_template(row)


@router.put("/invoice-template", dependencies=[Depends(require_perm("settings.edit"))])
async def update_invoice_template(
    data: InvoiceTemplateUpdate,
    db: AsyncSession = Depends(get_db),
):
    row = await _get_invoice_template(db)
    payload = data.model_dump(exclude_unset=True)

    if "header_style" in payload:
        style = _normalize_header_style(payload["header_style"])
        if style not in VALID_HEADER_STYLES:
            raise HTTPException(400, "header_style must be one of: full, nameonly, logo")
        payload["header_style"] = style

    if "tax_mode" in payload:
        mode = _normalize_tax_mode(payload["tax_mode"])
        if mode not in VALID_TAX_MODES:
            raise HTTPException(400, "tax_mode must be one of: total, itemized")
        payload["tax_mode"] = mode

    if not row:
        cfg = DEFAULT_INVOICE_TEMPLATE
        row = InvoiceTemplateSettings(
            id=DEFAULT_INVOICE_TEMPLATE_ID,
            header_style=cfg["header_style"],
            show_attr=cfg["show_attr"],
            show_size=cfg["show_size"],
            show_disc=cfg["show_disc"],
            show_hsn=cfg["show_hsn"],
            tax_mode=cfg["tax_mode"],
            show_customer=cfg["show_customer"],
            show_payment=cfg["show_payment"],
            show_printed_date=cfg["show_printed_date"],
            show_store=cfg["show_store"],
            show_cashier=cfg["show_cashier"],
            footer_msg=cfg["footer_msg"],
            footer_note=cfg["footer_note"],
        )
        db.add(row)

    for key, val in payload.items():
        if val is None and key in ("footer_msg", "footer_note"):
            setattr(row, key, "")
        else:
            setattr(row, key, val)

    await db.commit()
    await db.refresh(row)
    return _serialize_invoice_template(row)
