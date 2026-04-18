#!/bin/bash
set -euo pipefail

# 便宜上の workflow-controller 参照
echo "[entrypoint] workflow-controller 経由で起動"
exec openclaw gateway --port 3000
