"""testCaseGenerator · AI 生成模块冒烟测试共享夹具

用法：
    pytest tests/ -v --bff-base=http://localhost:4123
"""

import os
import pytest
import requests


def pytest_addoption(parser):
    parser.addoption(
        "--bff-base",
        default=os.getenv("BFF_BASE", "http://localhost:4123"),
        help="TestGen BFF 服务基址（默认从 BFF_BASE 环境变量读取，或 fallback localhost:4123）",
    )


@pytest.fixture(scope="session")
def bff_base(request):
    """BFF 服务基址"""
    return request.config.getoption("--bff-base")


@pytest.fixture(scope="session")
def project():
    """默认目标项目"""
    return "testCaseGenerator"


@pytest.fixture
def gen_payload(project):
    """生成请求的基础载荷工厂"""

    def _make(op, modules=None, depth="smoke", framework="pytest", note=None):
        payload = {
            "op": op,
            "project": project,
            "scope": {
                "modules": modules or ["generator"],
                "functions": ["AI生成"],
                "depth": depth,
            },
            "constraints": {
                "framework": framework,
            },
        }
        if note:
            payload["constraints"]["note"] = note
        return payload

    return _make


@pytest.fixture
def settings_payload():
    """设置请求的基础载荷"""

    def _make(provider="none", ks_base=None):
        payload = {
            "ai": {"provider": provider},
        }
        if ks_base:
            payload["ks"] = {"apiBase": ks_base}
        return payload

    return _make


@pytest.fixture
def bff_client(bff_base):
    """带健康检查的 BFF 请求客户端"""

    def _request(method, path, **kwargs):
        url = bff_base.rstrip("/") + "/" + path.lstrip("/")
        return requests.request(method, url, timeout=kwargs.pop("timeout", 15), **kwargs)

    def _get(path, **kwargs):
        return _request("GET", path, **kwargs)

    def _post(path, **kwargs):
        return _request("POST", path, **kwargs)

    def _put(path, **kwargs):
        return _request("PUT", path, **kwargs)

    return type("Client", (), {"get": _get, "post": _post, "put": _put, "base": bff_base})()
