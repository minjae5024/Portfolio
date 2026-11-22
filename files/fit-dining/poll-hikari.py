"""B′ 연결 풀 지표 수집기. k6가 도는 동안 BE 관리 포트의 Prometheus 지표를 0.2초마다 읽는다.

시작과 끝의 hikaricp_connections_usage_seconds(연결을 쥔 시간 합·횟수)와 timeout 수의 차이,
도는 동안 active·pending의 최댓값을 JSON으로 남긴다.
실행: python -I poll-hikari.py <결과 파일> <멈춤 신호 파일>
"""

import json
import os
import re
import sys
import time
import urllib.request

URL = "http://127.0.0.1:8081/actuator/prometheus"
NAMES = {
    "usage_count": "hikaricp_connections_usage_seconds_count",
    "usage_sum": "hikaricp_connections_usage_seconds_sum",
    "usage_max": "hikaricp_connections_usage_seconds_max",
    "acquire_sum": "hikaricp_connections_acquire_seconds_sum",
    "acquire_count": "hikaricp_connections_acquire_seconds_count",
    "acquire_max": "hikaricp_connections_acquire_seconds_max",
    "timeout": "hikaricp_connections_timeout_total",
    "active": "hikaricp_connections_active",
    "pending": "hikaricp_connections_pending",
}


def scrape() -> dict:
    text = urllib.request.urlopen(URL, timeout=15).read().decode("utf-8")
    values = {}
    for key, name in NAMES.items():
        m = re.search(rf"^{name}(?:\{{[^}}]*\}})?\s+([0-9.eE+-]+)$", text, re.M)
        values[key] = float(m.group(1)) if m else None
    return values


def main() -> None:
    out, stop = sys.argv[1], sys.argv[2]
    start = scrape()
    slow = 0
    peak = {"active": 0.0, "pending": 0.0, "acquire_max": 0.0, "usage_max": 0.0}
    samples = 0
    while not os.path.exists(stop):
        try:
            v = scrape()
            for k in peak:
                if v[k] is not None:
                    peak[k] = max(peak[k], v[k])
            samples += 1
        except OSError:
            slow += 1
        time.sleep(0.2)
    end = scrape()
    start["scrape_failures"] = slow
    diff = {k: (end[k] - start[k]) for k in ("usage_count", "usage_sum", "acquire_count", "acquire_sum", "timeout")
            if end[k] is not None and start[k] is not None}
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"start": start, "end": end, "diff": diff, "peak": peak, "samples": samples}, f, indent=2)


if __name__ == "__main__":
    main()
