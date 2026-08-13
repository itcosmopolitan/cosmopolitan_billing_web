from types import SimpleNamespace

from src import email_utils


def test_send_temp_password_email_uses_branded_welcome_template(monkeypatch):
    captured = {}

    def fake_send(payload):
        captured["payload"] = payload
        return SimpleNamespace(error=None)

    monkeypatch.setattr(email_utils, "resend", SimpleNamespace(api_key="test", Emails=SimpleNamespace(send=fake_send)))
    monkeypatch.setattr(
        email_utils,
        "_get_settings",
        lambda: SimpleNamespace(
            resend_api_key="test-key",
            resend_from_email="noreply@example.com",
            frontend_url="https://app.example.com",
            support_email="support@example.com",
        ),
    )

    email_utils.send_temp_password_email(
        "alice@example.com",
        "TempPass123",
        first_name="Alice",
        welcome=True,
        expiry_duration="30 minutes",
    )

    payload = captured["payload"]
    assert payload["subject"] == "Welcome — Your Account Details"
    html = payload["html"]
    assert "Hi <strong>Alice</strong>" in html
    assert "Your account has been created successfully" in html
    assert "TempPass123" in html
    assert "https://app.example.com/login" in html


def test_send_temp_password_email_uses_branded_reset_template(monkeypatch):
    captured = {}

    def fake_send(payload):
        captured["payload"] = payload
        return SimpleNamespace(error=None)

    monkeypatch.setattr(email_utils, "resend", SimpleNamespace(api_key="test", Emails=SimpleNamespace(send=fake_send)))
    monkeypatch.setattr(
        email_utils,
        "_get_settings",
        lambda: SimpleNamespace(
            resend_api_key="test-key",
            resend_from_email="noreply@example.com",
            frontend_url="https://app.example.com",
            support_email="support@example.com",
        ),
    )

    email_utils.send_temp_password_email(
        "bob@example.com",
        "ResetPass456",
        first_name="Bob",
        welcome=False,
        expiry_duration="30 minutes",
    )

    payload = captured["payload"]
    assert payload["subject"] == "Reset Your Password"
    html = payload["html"]
    assert "Reset your password" in html
    assert "ResetPass456" in html
    assert "support@example.com" in html
