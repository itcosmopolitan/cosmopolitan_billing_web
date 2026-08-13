import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

from src import config

logger = logging.getLogger(__name__)

try:
    import resend
except ImportError:  # pragma: no cover - optional dependency, handled at runtime.
    resend = None

ROOT_DIR = Path(__file__).resolve().parents[2]
WELCOME_TEMPLATE_PATH = ROOT_DIR / "onboarding-email.html"
RESET_TEMPLATE_PATH = ROOT_DIR / "forgot-password-email.html"


def _get_settings():
    try:
        return config.get()
    except RuntimeError:
        return config.load()


def _get_login_url(settings) -> str:
    return f"{settings.frontend_url.rstrip('/')}/login"


def _format_first_name(name: Optional[str]) -> str:
    if not name or not name.strip():
        return "there"
    return name.strip().split()[0].capitalize()


def _read_template(path: Path) -> str:
    if not path.exists():
        raise FileNotFoundError(f"Email template not found: {path}")
    return path.read_text(encoding="utf-8")


def _parse_expiry_hours(expiry_duration: str) -> int:
    if not expiry_duration:
        return 1
    match = re.search(r"(\d+)", expiry_duration)
    if not match:
        return 1
    value = int(match.group(1))
    if "minute" in expiry_duration.lower():
        return max(1, (value + 59) // 60)
    return max(1, value)


def _apply_template_tokens(template: str, values: dict[str, str]) -> str:
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace(f"{{{{{key}}}}}", str(value))
    return rendered


def _render_brand_template(
    *,
    template: str,
    first_name: Optional[str],
    user_email: str,
    temp_password: str,
    login_url: str,
    support_email: str,
    expiry_duration: str,
) -> str:
    name = _format_first_name(first_name)
    expiry_hours = _parse_expiry_hours(expiry_duration)
    company_name = getattr(_get_settings(), "company_name", "Cosmopolitan Champa Brothers Maldives Pvt Ltd")
    company_address = getattr(_get_settings(), "company_address", "LOT NO-10627, Haivakaru Magu, Hulhumale', Republic of Maldives\nT: +960 331 0477 | E: info@cosmopolitan.com.mv")
    replacements = {
        "USER_NAME": name,
        "user_name": name,
        "first_name": name,
        "USER_EMAIL": user_email,
        "user_email": user_email,
        "TEMP_PASSWORD": temp_password,
        "temporary_password": temp_password,
        "LOGIN_URL": login_url,
        "login_url": login_url,
        "EXPIRY_HOURS": str(expiry_hours),
        "expiry_hours": str(expiry_hours),
        "EXPIRY_MINUTES": str(max(1, int(expiry_duration.split()[0]) if expiry_duration and expiry_duration.split()[0].isdigit() else 30)),
        "expiry_minutes": str(max(1, int(expiry_duration.split()[0]) if expiry_duration and expiry_duration.split()[0].isdigit() else 30)),
        "SUPPORT_EMAIL": support_email,
        "support_email": support_email,
        "CURRENT_YEAR": str(datetime.now().year),
        "current_year": str(datetime.now().year),
        "COMPANY_NAME": company_name,
        "company_name": company_name,
        "COMPANY_ADDRESS": company_address,
        "company_address": company_address,
        "UNSUBSCRIBE_URL": login_url,
        "unsubscribe_url": login_url,
        "PRIVACY_URL": login_url,
        "privacy_url": login_url,
        "reset_url": login_url,
        "request_ip": "N/A",
    }
    return _apply_template_tokens(template, replacements)


def send_temp_password_email(
    to_email: str,
    temp_password: str,
    *,
    first_name: Optional[str] = None,
    welcome: bool = False,
    expiry_duration: str = "30 minutes",
) -> None:
    if resend is None:
        raise RuntimeError("resend package is not installed")

    settings = _get_settings()
    if not settings.resend_api_key:
        raise RuntimeError("Resend API key is not configured")

    resend.api_key = settings.resend_api_key
    login_url = _get_login_url(settings)
    support_email = settings.support_email or settings.resend_from_email

    if welcome:
        subject = "Welcome — Your Account Details"
        template = _read_template(WELCOME_TEMPLATE_PATH)
    else:
        subject = "Reset Your Password"
        template = _read_template(RESET_TEMPLATE_PATH)

    html = _render_brand_template(
        template=template,
        first_name=first_name,
        user_email=to_email,
        temp_password=temp_password,
        login_url=login_url,
        support_email=support_email,
        expiry_duration=expiry_duration,
    )

    result = resend.Emails.send(
        {
            "from": settings.resend_from_email,
            "to": [to_email],
            "subject": subject,
            "html": html,
        }
    )
    if getattr(result, "error", None):
        raise RuntimeError(str(result.error))
