"""Application configuration."""

SETTINGS = {
    'host': '0.0.0.0',
    'port': 8080,
}


def get_setting(key: str):
    return SETTINGS[key]
