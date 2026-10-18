"""Finance Bridge configuration."""

import os
from dataclasses import dataclass, field


@dataclass
class Settings:
    app_env: str = field(default_factory=lambda: os.getenv("APP_ENV", "development"))
    app_url: str = field(default_factory=lambda: os.getenv("APP_URL", "http://127.0.0.1:8711"))
    tz: str = field(default_factory=lambda: os.getenv("TZ", "Europe/Berlin"))
    bridge_database_url: str = field(default_factory=lambda: os.getenv("BRIDGE_DATABASE_URL", "sqlite:///data/bridge.db"))
    bridge_internal_token: str = field(default_factory=lambda: os.getenv("BRIDGE_INTERNAL_TOKEN", ""))
    firefly_api_url: str = field(default_factory=lambda: os.getenv("FIREFLY_API_URL", "http://127.0.0.1:18080/api/v1"))
    firefly_token: str = field(default_factory=lambda: os.getenv("FIREFLY_TOKEN", ""))
    base_currency: str = field(default_factory=lambda: os.getenv("BASE_CURRENCY", "CNY"))

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def has_firefly_credentials(self) -> bool:
        return bool(self.firefly_token) and bool(self.firefly_api_url)


settings = Settings()
