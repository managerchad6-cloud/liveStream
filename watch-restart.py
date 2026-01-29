#!/usr/bin/env python3
"""
Watch for file changes and restart services automatically.
Usage: sudo python3 watch-restart.py
"""

import subprocess
import time
import sys
from pathlib import Path

try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler
except ImportError:
    print("Installing watchdog...")
    subprocess.run([sys.executable, "-m", "pip", "install", "watchdog"], check=True)
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler

# Configuration
WATCH_DIR = Path("/home/liveStream")
DEBOUNCE_SECONDS = 2

# Which services to restart based on file path
SERVICE_MAP = {
    "animation-server/": "animation",
    "frontend/": "livestream",
    "server.js": "livestream",
    "voices.js": "livestream",
    "tools/": None,  # Don't restart for tools
}

IGNORE_PATTERNS = [
    "node_modules",
    ".git",
    "streams",
    "exported-layers",
    "temp",
    "__pycache__",
    ".pyc",
    ".log",
    ".ts",  # HLS segments
    ".m3u8",
]


class RestartHandler(FileSystemEventHandler):
    def __init__(self):
        self.last_restart = {}
        self.pending_restarts = set()

    def should_ignore(self, path):
        path_str = str(path)
        return any(pattern in path_str for pattern in IGNORE_PATTERNS)

    def get_service(self, path):
        rel_path = str(Path(path).relative_to(WATCH_DIR))

        for pattern, service in SERVICE_MAP.items():
            if rel_path.startswith(pattern) or rel_path == pattern.rstrip("/"):
                return service

        return None

    def restart_service(self, service):
        now = time.time()

        # Debounce: don't restart same service within DEBOUNCE_SECONDS
        if service in self.last_restart:
            if now - self.last_restart[service] < DEBOUNCE_SECONDS:
                return

        self.last_restart[service] = now

        print(f"\n{'='*50}")
        print(f"Restarting {service}...")
        print(f"{'='*50}")

        try:
            result = subprocess.run(
                ["systemctl", "restart", service],
                capture_output=True,
                text=True
            )
            if result.returncode == 0:
                print(f"✓ {service} restarted successfully")
            else:
                print(f"✗ Failed to restart {service}: {result.stderr}")
        except Exception as e:
            print(f"✗ Error restarting {service}: {e}")

    def on_modified(self, event):
        if event.is_directory:
            return

        if self.should_ignore(event.src_path):
            return

        service = self.get_service(event.src_path)
        if service:
            rel_path = str(Path(event.src_path).relative_to(WATCH_DIR))
            print(f"Changed: {rel_path}")
            self.restart_service(service)

    def on_created(self, event):
        self.on_modified(event)


def main():
    print(f"""
╔══════════════════════════════════════════════════╗
║         LiveStream Service Watcher               ║
╠══════════════════════════════════════════════════╣
║  Watching: {WATCH_DIR}
║  Services: animation, livestream                 ║
║  Press Ctrl+C to stop                            ║
╚══════════════════════════════════════════════════╝
""")

    # Check current service status
    print("Current service status:")
    for service in ["animation", "livestream", "webhook"]:
        result = subprocess.run(
            ["systemctl", "is-active", service],
            capture_output=True,
            text=True
        )
        status = result.stdout.strip()
        symbol = "✓" if status == "active" else "✗"
        print(f"  {symbol} {service}: {status}")
    print()

    event_handler = RestartHandler()
    observer = Observer()
    observer.schedule(event_handler, str(WATCH_DIR), recursive=True)
    observer.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping watcher...")
        observer.stop()

    observer.join()
    print("Watcher stopped.")


if __name__ == "__main__":
    main()
