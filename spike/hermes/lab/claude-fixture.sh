#!/bin/sh
# Lab-only: the real `claude` binary with a FIXTURE API key and an empty config dir.
# Used as CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND in the zero-model stub runs (stub-probe.mjs).
# The plugin's relay still sits in between; sitecustomize.py sends its upstream to the local stub.
# the owner's login is never reachable from here: CLAUDE_CONFIG_DIR is an empty lab dir and the
# stub aborts the step if a request ever carries an `authorization` (OAuth) header.
: "${PULT_LAB_REAL_CLAUDE:?}" "${PULT_LAB_STUB_CLAUDE_DIR:?}"
export ANTHROPIC_API_KEY=fixture-not-a-real-key
export CLAUDE_CONFIG_DIR="$PULT_LAB_STUB_CLAUDE_DIR"
export DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1
exec "$PULT_LAB_REAL_CLAUDE" "$@"
