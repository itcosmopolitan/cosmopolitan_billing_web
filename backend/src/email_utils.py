import logging
from typing import Optional

from src import config

logger = logging.getLogger(__name__)

try:
    import resend
except ImportError:  # pragma: no cover - optional dependency, handled at runtime.
    resend = None


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
        subject = "Welcome to Cosmopolitan – Your Account is Ready!"
        html = (
            f"<p>Hi {_format_first_name(first_name)},</p>"
            "<p>Welcome to Cosmopolitan! We're thrilled to have you on board.</p>"
            "<p>Your account has been created, and you can log in using the credentials below:</p>"
            f"<p><strong>Username/Email: {to_email}<br>Temporary Password: {temp_password}</strong></p>"
            "<p>For your security, please log in and change your password as soon as possible.</p>"
            f"<p>👉 Log in here: <a href=\"{login_url}\">{login_url}</a></p>"
            "<p>Here's how to get started:</p>"
            "<ol>"
            "<li>Log in using the temporary password above</li>"
            "<li>Update your password to something only you know</li>"
            "<li>Complete your profile to personalize your experience</li>"
            "<li>Explore the features waiting for you inside</li>"
            "</ol>"
            f"<p>If you have any questions or run into any issues, our support team is always here to help at {support_email}.</p>"
            "<p>We're excited to have you as part of the Cosmopolitan community!</p>"
            "<p>Warm regards,<br>The Cosmopolitan Team</p>"
        )
    else:
        subject = "Reset Your Cosmopolitan Password"
        html = (
            f"<p>Hi {_format_first_name(first_name)},</p>"
            "<p>We received a request to reset the password for your Cosmopolitan account.</p>"
            "<p>Your temporary password is:</p>"
            f"<p><strong>{temp_password}</strong></p>"
            "<p>Please use this to log in, then update your password right away for security.</p>"
            f"<p>👉 Log in here: <a href=\"{login_url}\">{login_url}</a></p>"
            "<p>If you didn't request this change, please contact our support team immediately at "
            f"{support_email} — your account security matters to us.</p>"
            f"<p>This temporary password will expire in {expiry_duration}, so please log in soon.</p>"
            "<p>If you need any help, we're just an email away.</p>"
            "<p>Warm regards,<br>The Cosmopolitan Team</p>"
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
