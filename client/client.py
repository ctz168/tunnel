#!/usr/bin/env python3
"""
Tunnel Client - 兼容入口 (薄包装)

推荐使用 pip 安装:
  pip install tunnel-p2p-client
  tunnel-p2p-client --key <认证令牌> --port 8080

或从源码运行:
  python -m tunnel_client --key <认证令牌> --port 8080
"""
import sys
import os

# 将项目根目录加入 sys.path，以便导入 tunnel_client 包
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from tunnel_client.client import main

if __name__ == "__main__":
    main()
