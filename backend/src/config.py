"""
Configuration management for RetailOS backend
Uses pydantic-settings to load from environment variables with sensible defaults
"""
from pydantic_settings import BaseSettings
from typing import List

class Settings(BaseSettings):
    """Application configuration loaded from environment variables"""
    
    # ─── Database ──────────────────────────────────────────────────────────
    database_url: str = "sqlite+aiosqlite:///./retailos.db"
    
    # ─── API Configuration ─────────────────────────────────────────────────
    api_version: str = "v1"
    api_prefix: str = "/api/v1"
    app_title: str = "RetailOS Pro API"
    app_description: str = "Multi-branch retail billing, POS, inventory, and reporting platform"
    app_version: str = "2.4.0"
    
    # ─── CORS Configuration ────────────────────────────────────────────────
    cors_origins: List[str] = [
        "http://localhost:3000",
        "http://localhost:5173"
    ]
    
    # ─── JWT Configuration ────────────────────────────────────────────────
    jwt_secret_key: str = "your-secret-key-change-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expiration_hours: int = 24
    
    # ─── Demo Mode ────────────────────────────────────────────────────────
    demo_mode: bool = True
    
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
