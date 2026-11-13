#!/opt/switchgate/acme-venv/bin/python
"""DNSPod DNS-01 hook for certbot, using the official Tencent Cloud SDK."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import dns.resolver
from tencentcloud.common import credential
from tencentcloud.common.exception.tencent_cloud_sdk_exception import (
    TencentCloudSDKException,
)
from tencentcloud.common.profile.client_profile import ClientProfile
from tencentcloud.common.profile.http_profile import HttpProfile
from tencentcloud.dnspod.v20210323 import dnspod_client, models

CREDENTIALS_PATH = Path("/etc/switchgate/dnspod-credentials.json")
STATE_PATH = Path("/var/lib/switchgate-acme/created-records.json")
ZONE = "ztsnss.cloud"
AUTHORITATIVE_NS = ("red.dnspod.net", "display.dnspod.net")


def make_client() -> dnspod_client.DnspodClient:
    data = json.loads(CREDENTIALS_PATH.read_text(encoding="utf-8"))
    cred = credential.Credential(data["secretId"], data["secretKey"])
    profile = ClientProfile()
    profile.httpProfile = HttpProfile(endpoint="dnspod.tencentcloudapi.com")
    profile.httpProfile.reqTimeout = 30
    return dnspod_client.DnspodClient(cred, "", profile)


def create_txt(fqdn: str, value: str) -> None:
    client = make_client()
    request = models.CreateRecordRequest()
    request.from_json_string(
        json.dumps(
            {
                "Domain": ZONE,
                "SubDomain": fqdn[: -len(ZONE) - 1],
                "RecordType": "TXT",
                "RecordLine": "默认",
                "Value": value,
                "TTL": 600,
                "Status": "ENABLE",
            },
            ensure_ascii=False,
        )
    )
    response = client.CreateRecord(request)
    record_id = json.loads(response.to_json_string())["RecordId"]
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    state = (
        json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if STATE_PATH.exists()
        else []
    )
    state.append(
        {
            "domain": ZONE,
            "recordId": record_id,
            "fqdn": fqdn,
            "value": value,
            "createdAt": int(time.time()),
        }
    )
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(STATE_PATH)
    print(f"created TXT {fqdn} recordId={record_id}")
    wait_for_txt(fqdn, value)


def wait_for_txt(fqdn: str, value: str, timeout: int = 180) -> None:
    deadline = time.monotonic() + timeout
    resolver = dns.resolver.Resolver(configure=False)
    resolver.nameservers = [
        address
        for ns in AUTHORITATIVE_NS
        for address in _resolve_ns_address(ns)
    ]
    resolver.lifetime = 10
    last_error = "not queried"
    while time.monotonic() < deadline:
        try:
            answer = resolver.resolve(fqdn, "TXT")
            if any(value in record.to_text() for record in answer):
                print(f"authoritative TXT visible for {fqdn}")
                return
            last_error = "TXT exists but does not yet contain validation value"
        except Exception as exc:  # noqa: BLE001 - report every propagation attempt
            last_error = f"{type(exc).__name__}: {exc}"
        time.sleep(5)
    raise RuntimeError(f"TXT did not propagate to authoritative DNS: {last_error}")


def _resolve_ns_address(name: str) -> list[str]:
    system_resolver = dns.resolver.Resolver()
    system_resolver.lifetime = 10
    try:
        answer = system_resolver.resolve(name, "A")
    except Exception:
        return []
    return [record.to_text() for record in answer]


def delete_txt(fqdn: str, value: str) -> None:
    client = make_client()
    state = (
        json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if STATE_PATH.exists()
        else []
    )
    matches = [
        item
        for item in state
        if item.get("fqdn") == fqdn and item.get("value") == value
    ]
    if not matches:
        print(f"no tracked TXT to delete for {fqdn}")
        return

    remaining = state
    for item in matches:
        request = models.DeleteRecordRequest()
        request.from_json_string(
            json.dumps({"Domain": ZONE, "RecordId": int(item["recordId"])})
        )
        client.DeleteRecord(request)
        remaining = [x for x in remaining if x is not item]
        print(f"deleted TXT {fqdn} recordId={item['recordId']}")

    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(remaining, ensure_ascii=False), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(STATE_PATH)


def main() -> int:
    value = os.environ.get("CERTBOT_VALIDATION", "").strip()
    if not value:
        print("CERTBOT_VALIDATION is empty", file=sys.stderr)
        return 2
    action = os.environ.get("SWITCHGATE_ACME_ACTION", "create")
    domain = os.environ.get("CERTBOT_DOMAIN", "").strip().rstrip(".")
    if not domain or not domain.endswith("." + ZONE):
        print(f"unexpected CERTBOT_DOMAIN={domain!r}", file=sys.stderr)
        return 2
    fqdn = "_acme-challenge." + domain
    if action == "create":
        try:
            create_txt(fqdn, value)
        except Exception:
            delete_txt(fqdn, value)
            raise
        return 0
    if action == "delete":
        delete_txt(fqdn, value)
        return 0
    print(f"unsupported action: {action}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except TencentCloudSDKException as exc:
        print(f"dnspod api error: {exc}", file=sys.stderr)
        raise SystemExit(1)

