"""仓库级 pytest 配置：把仓库根注入 sys.path，保证 tests 下可稳定 import finance_bridge。

原理：pytest 通常以 rootdir（含 pyproject.toml 的目录）为基准，但显式注入更稳——
无论从哪个 cwd 启动 pytest，都能找到仓库根（本文件在 tests/，上两级即仓库根）。
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
