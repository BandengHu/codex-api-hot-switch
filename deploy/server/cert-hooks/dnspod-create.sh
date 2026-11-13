#!/bin/sh
export SWITCHGATE_ACME_ACTION=create
exec /opt/switchgate/acme-venv/bin/python /opt/switchgate/cert-hooks/dnspod-auth.py

