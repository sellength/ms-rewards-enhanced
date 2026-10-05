#!/usr/bin/env bash
# Microsoft Rewards Self-Check & Diagnostic Tool
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

node doctor.mjs
