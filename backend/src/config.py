"""
Configuration management for Cosmopolitan Pro backend
Uses pydantic-settings to load from environment variables with sensible defaults
"""
from pydantic import computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application configuration loaded from environment variables"""

    model_config = SettingsConfigDict(
        env_file=".env",
        case_sensitive=False,
    )

    # ─── Database ──────────────────────────────────────────────────────────
    # Override via DATABASE_URL in backend/.env (preferred for secrets).
    database_url: str = (
        "postgresql+asyncpg://avnadmin:AVNS_mgZmoo0HyTq_Bm_p-qR"
        "@pg-39f9cb61-demverse5-501b.a.aivencloud.com:23800/defaultdb"
    )

    # ─── API Configuration ─────────────────────────────────────────────────
    api_version: str = "v1"
    api_prefix: str = "/api/v1"
    app_title: str = "Cosmopolitan Pro API"
    app_description: str = "Multi-branch retail billing, POS, inventory, and reporting platform"
    app_version: str = "2.4.0"
    # Storage keys used by the frontend (`localStorage retailos_token`,
    # `retailos-app`, `retailos.db`) deliberately keep the legacy prefix so a
    # rename doesn't log every existing user out. Don't rebrand those.

    # ─── CORS Configuration ────────────────────────────────────────────────
    # Comma-separated in .env — pydantic-settings cannot JSON-decode List[str]
    # from a plain CSV string, so we store str and expose a parsed list below.
    cors_origins: str = "http://localhost:3000,http://localhost:5173"

    @computed_field
    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    # ─── JWT Configuration ────────────────────────────────────────────────
    jwt_secret_key: str = "your-secret-key-change-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expiration_hours: int = 24

    # ─── Auth Enforcement (RBAC) ──────────────────────────────────────────
    # True (default since Phase 2): require_perm() actually checks; routes
    # without a valid JWT get 401 / 403. Set to False to revert to the
    # open-demo behaviour where current_user() falls back to the seeded
    # super-admin (e.g. for screenshot demos). See docs/USERS_AND_ROLES.md
    # §3 D3 and the Phase 2 section.
    auth_enforced: bool = True

    # ─── Demo Mode ────────────────────────────────────────────────────────
    demo_mode: bool = True
    # ─── Email / Resend ───────────────────────────────────────────────────
    resend_api_key: str = ""
    resend_from_email: str = "onboarding@resend.dev"
    frontend_url: str = "http://localhost:5173"
    support_email: str = "support@indogreeninternational.com"
    # ─── Dashboard Read Models ────────────────────────────────────────────
    dashboard_use_materialized_views: bool = False

    # ─── Notifications ──────────────────────────────────────────────────────
    notification_expiry_within_days: int = 30
    notification_scan_enabled: bool = True
    notification_scan_interval_hours: int = 24
    notification_internal_token: str = ""

# ─── Global Config Instance ────────────────────────────────────────────────
_settings: Settings = None

def load() -> Settings:
    """
    Load configuration from environment variables and .env file
    Must be called before reading any config values
    """
    global _settings
    _settings = Settings()
    return _settings

def get() -> Settings:
    """
    Get the loaded configuration instance
    Raises RuntimeError if config hasn't been loaded yet
    """
    global _settings
    if _settings is None:
        raise RuntimeError(
            "Configuration not loaded. Call config.load() during application startup."
        )
    return _settings
