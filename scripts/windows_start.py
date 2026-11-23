"""Start the local Windows browser edition after the launcher checks dependencies."""
import json
import sys
import urllib.request
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import config
import server


def main():
    url = f"http://127.0.0.1:{config.PORT}"
    try:
        with urllib.request.urlopen(url + "/api/health", timeout=1) as response:
            if json.load(response).get("app") == "slidemate":
                webbrowser.open(url)
                return
    except (OSError, ValueError):
        pass
    if not config.CONFIG_PATH.exists():
        config.ensure_library()
        config.update({"provider": "codex", "setup_done": True})
    server.main(open_browser=True)


if __name__ == "__main__":
    main()
