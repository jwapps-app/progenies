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

    # CORS regex (in addition to the list above). SECURE BY DEFAULT: empty —
    # with allow_credentials on, a broad regex lets any matching origin call
    # the API with the user's refresh cookie. Dev (docker-compose.yml) opts
    # INTO the localhost/private-LAN regex so the PWA can be tested from a
    # phone/iPad at the machine's LAN IP; production leaves it empty (the SPA
    # is same-origin behind the nginx proxy and needs no CORS at all).
    CORS_ORIGIN_REGEX: str = ""

    # Refresh cookie Secure flag. TRUE by default (production is HTTPS behind
    # the Cloudflare Tunnel); dev (plain http on the LAN) sets it to false.
    COOKIE_SECURE: bool = True

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
