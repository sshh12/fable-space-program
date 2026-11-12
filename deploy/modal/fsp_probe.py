"""
fsp-probe: throughput of the packs bucket from a Modal fleet (ARCHITECTURE 10.4, platform-delivery D6).

Concurrent fetchers replay real tile range requests (the byte ranges of real tile groups, from the pack
indexes and the recorded first session) against the presigned URLs of the pack list for a fixed time, and
report first-byte latency (p50, p95, p99), errors and aggregate throughput, per level. Pass/fail (10.4): p95
first byte of a cold range <= 400 ms, errors <= 0.5 %, and >= 1.5 Gbit/s sustained in aggregate at 2,000.

Run (environment fsp; nothing stays deployed: `modal run` creates an ephemeral app):
    modal run --env fsp deploy/modal/fsp_probe.py --requests out/platform/probe-requests.json --levels 20,500,2000 --seconds 900

The request file (written by `npx tsx deploy/modal/make-requests.ts`) holds presigned URLs, which are
bearer URLs for 7 days: it stays in the git-ignored out/ directory and is passed to the containers as data.
Concurrency is expressed as fetchers per container (at most 50 per container, at most 40 containers).
"""

import json
import time

import modal

app = modal.App("fsp-probe")
image = modal.Image.debian_slim(python_version="3.12").pip_install("aiohttp==3.11.18")

BUCKET_MS = 5  # latency histogram resolution
MAX_MS = 20_000


@app.function(image=image, cpu=1.0, memory=1024, timeout=3600)
def fetchers(n: int, seconds: float, payload: bytes, seed: int) -> dict:
    import asyncio
    import random

    import aiohttp

    doc = json.loads(payload)
    urls = doc["urls"]
    reqs = doc["ranges"]
    rnd = random.Random(seed)
    hist = [0] * (MAX_MS // BUCKET_MS + 1)
    out = {"requests": 0, "ok": 0, "errors": {}, "bytes": 0, "fetchers": n}

    async def one(session: aiohttp.ClientSession, deadline: float) -> None:
        while time.monotonic() < deadline:
            h, off, length = reqs[rnd.randrange(len(reqs))]
            t0 = time.monotonic()
            try:
                async with session.get(urls[h], headers={"Range": f"bytes={off}-{off + length - 1}"}) as r:
                    ttfb = (time.monotonic() - t0) * 1000
                    body = await r.read()
                    out["requests"] += 1
                    if r.status == 206 and len(body) == length:
                        out["ok"] += 1
                        out["bytes"] += len(body)
                        hist[min(len(hist) - 1, int(ttfb // BUCKET_MS))] += 1
                    else:
                        k = f"{r.status}/{'len' if r.status == 206 else 'status'}"
                        out["errors"][k] = out["errors"].get(k, 0) + 1
            except Exception as e:  # network failures and timeouts count as errors
                out["requests"] += 1
                k = type(e).__name__
                out["errors"][k] = out["errors"].get(k, 0) + 1

    async def main() -> None:
        conn = aiohttp.TCPConnector(limit=0, ttl_dns_cache=300)
        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(connector=conn, timeout=timeout) as s:
            deadline = time.monotonic() + seconds
            await asyncio.gather(*[one(s, deadline) for _ in range(n)])

    t0 = time.monotonic()
    asyncio.run(main())
    out["seconds"] = time.monotonic() - t0
    out["hist"] = hist
    return out


def percentile(hist: list, q: float) -> float:
    total = sum(hist)
    if total == 0:
        return float("nan")
    want = q * total
    run = 0
    for i, c in enumerate(hist):
        run += c
        if run >= want:
            return (i + 0.5) * BUCKET_MS
    return MAX_MS


@app.local_entrypoint()
def run(requests: str = "out/platform/probe-requests.json", levels: str = "20,500,2000", seconds: float = 900, per_container: int = 50):
    payload = open(requests, "rb").read()
    report = {"seconds": seconds, "levels": []}
    for level in [int(x) for x in levels.split(",")]:
        containers = max(1, -(-level // per_container))
        if containers > 40:
            raise SystemExit("at most 40 containers")
        sizes = [level // containers + (1 if i < level % containers else 0) for i in range(containers)]
        t0 = time.time()
        results = list(fetchers.starmap([(n, seconds, payload, 1000 * level + i) for i, n in enumerate(sizes)]))
        wall = time.time() - t0
        hist = [sum(r["hist"][i] for r in results) for i in range(len(results[0]["hist"]))]
        req = sum(r["requests"] for r in results)
        ok = sum(r["ok"] for r in results)
        errors: dict = {}
        for r in results:
            for k, v in r["errors"].items():
                errors[k] = errors.get(k, 0) + v
        byts = sum(r["bytes"] for r in results)
        span = max(r["seconds"] for r in results)
        row = {
            "fetchers": level,
            "containers": containers,
            "requests": req,
            "ok": ok,
            "errorRate": (req - ok) / req if req else None,
            "errors": errors,
            "firstByteMs": {"p50": percentile(hist, 0.5), "p95": percentile(hist, 0.95), "p99": percentile(hist, 0.99)},
            "bytes": byts,
            "gbitPerS": byts * 8 / span / 1e9,
            "wallS": wall,
        }
        row["pass"] = row["firstByteMs"]["p95"] <= 400 and (row["errorRate"] or 0) <= 0.005 and (level < 2000 or row["gbitPerS"] >= 1.5)
        print(json.dumps(row))
        report["levels"].append(row)
    with open("out/platform/probe-report.json", "w") as f:
        json.dump(report, f, indent=1)
