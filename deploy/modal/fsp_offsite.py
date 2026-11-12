"""
fsp-offsite: the copies outside Railway (ARCHITECTURE 10.4, 15.3, 16.2). Environment `fsp`.

  copy_packs     once per pack set: every pack and index object the deployed pack list names, downloaded
                 through its presigned URL (no credential needed; bucket egress is free) into the Modal volume
                 `fsp-packs` at /packs/<hash>, each verified by SHA-256 against its content address; objects
                 already there with the right hash are skipped. Once it has run, the development machine's
                 data/packs may be deleted (the lead says when).
  copy_dump      nightly (04:17 UTC): the newest database dump from the `dumps` bucket (Modal secret
                 `fsp-dumps`, the only place that credential exists outside Railway) into the volume
                 `fsp-dumps`, keeping the newest 14.

    modal run --env fsp deploy/modal/fsp_offsite.py::copy_packs --pack-list https://game-production-dfc41bff.up.railway.app/packs.json
    modal deploy --env fsp deploy/modal/fsp_offsite.py          (the nightly copy_dump schedule)
"""

import hashlib
import os

import modal

app = modal.App("fsp-offsite")
image = modal.Image.debian_slim(python_version="3.12").pip_install("requests==2.32.3", "boto3==1.35.99")
packs_volume = modal.Volume.from_name("fsp-packs", create_if_missing=True)
dumps_volume = modal.Volume.from_name("fsp-dumps", create_if_missing=True)


def _fetch_verified(url: str, dest: str, want: str) -> int:
    import requests

    h = hashlib.sha256()
    tmp = dest + ".part"
    n = 0
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=4 * 1024 * 1024):
                h.update(chunk)
                f.write(chunk)
                n += len(chunk)
    got = h.hexdigest()[:32]
    if got != want:
        os.remove(tmp)
        raise RuntimeError(f"{want}: downloaded bytes hash to {got}")
    os.replace(tmp, dest)
    return n


@app.function(image=image, volumes={"/packs": packs_volume}, timeout=6 * 3600, cpu=1.0, memory=1024)
def copy_packs(pack_list: str) -> dict:
    import requests

    doc = requests.get(pack_list, timeout=60).json()
    bucket = next(m for m in doc["mirrors"] if m["id"] == "bucket")
    objects = bucket["objects"]
    copied, skipped, byts = 0, 0, 0
    for h in sorted(objects):
        dest = f"/packs/{h}"
        if os.path.exists(dest):
            with open(dest, "rb") as f:
                d = hashlib.sha256()
                for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
                    d.update(chunk)
            if d.hexdigest()[:32] == h:
                skipped += 1
                continue
        byts += _fetch_verified(objects[h], dest, h)
        copied += 1
        packs_volume.commit()
    packs_volume.commit()
    return {"objects": len(objects), "copied": copied, "skipped": skipped, "bytes": byts, "sets": sorted(doc["sets"])}


@app.function(image=image, volumes={"/dumps": dumps_volume}, secrets=[modal.Secret.from_name("fsp-dumps")], schedule=modal.Cron("17 4 * * *"), timeout=1800)
def copy_dump() -> dict:
    import boto3

    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["DUMPS_ENDPOINT"],
        region_name=os.environ["DUMPS_REGION"],
        aws_access_key_id=os.environ["DUMPS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["DUMPS_SECRET_ACCESS_KEY"],
    )
    bucket = os.environ["DUMPS_BUCKET"]
    keys = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix="dumps/"):
        keys += [o["Key"] for o in page.get("Contents", [])]
    if not keys:
        return {"copied": None}
    newest = sorted(keys)[-1]
    dest = "/dumps/" + newest.split("/")[-1]
    if not os.path.exists(dest):
        s3.download_file(bucket, newest, dest)
    kept = sorted(os.listdir("/dumps"))
    for old in kept[:-14]:
        os.remove(os.path.join("/dumps", old))
    dumps_volume.commit()
    return {"copied": newest, "kept": len(kept[-14:])}
