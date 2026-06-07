"""
Configuration management for Cosmopolitan Pro backend
Uses pydantic-settings to load from environment variables with sensible defaults
"""
from typing import List

from pydantic import field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application configuration loaded from environment variables"""

    # ─── Database ──────────────────────────────────────────────────────────
    database_url: str = "sqlite+aiosqlite:///./retailos.db"

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
    cors_origins: List[str] = [
        "http://localhost:3000",
        "http://localhost:5173"
    ]

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, v):
        """Parse CORS origins from comma-separated string or keep as list"""
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(",") if origin.strip()]
        return v

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

    # ─── Dashboard Read Models ────────────────────────────────────────────
    # Disabled by default because materialized views require an external
    # refresh step. When false, dashboard APIs query source tables directly.
    dashboard_use_materialized_views: bool = False

    class Config:
        env_file = ".env"
        case_sensitive = False

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
