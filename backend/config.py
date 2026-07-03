"""Application configuration loaded from environment variables."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration for the backend.

    Values are read from environment variables (see .env.example). Defaults are
    development-friendly; production values are supplied via Docker Compose / .env.
    """

    # Display/brand name. Provisional working title; change APP_NAME to rebrand.
    APP_NAME: str = "Progenies"

    DATABASE_URL: str = "postgresql://kindred:kindred@db:5432/genealogy"
    SECRET_KEY: str = "change-me-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30
    BCRYPT_ROUNDS: int = 12

    # CORS: comma-separated list of allowed origins for the frontend.
    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:3000"

    # CORS regex (in addition to the list above). The default accepts localhost,
    # 127.0.0.1, and private-LAN IPs (10.x, 192.168.x, 172.16-31.x) on any port,
    # so local dev works whether the app is opened at localhost or the machine's
    # LAN IP (handy for testing the PWA on a phone). Set to "" to disable in prod.
    CORS_ORIGIN_REGEX: str = (
        r"https?://("
        r"localhost|127\.0\.0\.1|"
        r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
        r"192\.168\.\d{1,3}\.\d{1,3}|"
        r"172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
        r")(:\d+)?"
    )

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
