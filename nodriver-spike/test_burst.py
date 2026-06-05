from datetime import datetime

import auto_pipeline as ap


def _set_windows(raw):
    ap.BURST_WINDOWS = raw
    ap._BURST_WINDOWS_PARSED = ap._parse_burst_windows(raw)
    ap._BURST_WINDOWS_LOGGED = True


def main():
    _set_windows("")
    assert ap._burst_interval_now(datetime(2026, 6, 5, 9, 30)) is None

    _set_windows("09:00-11:00,14:00-16:00")
    assert ap._burst_interval_now(datetime(2026, 6, 5, 9, 30)) == ap.BURST_INTERVAL
    assert ap._burst_interval_now(datetime(2026, 6, 5, 12, 30)) == ap.IDLE_INTERVAL
    print("burst tests passed: empty=None inside=BURST_INTERVAL outside=IDLE_INTERVAL")


if __name__ == "__main__":
    main()
