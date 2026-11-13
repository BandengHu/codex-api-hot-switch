#!/bin/sh
export SWITCHGATE_ACME_ACTION=delete
exec /opt/switchgate/acme-venv/bin/python /opt/switchgate/cert-hooks/dnspod-auth.py

