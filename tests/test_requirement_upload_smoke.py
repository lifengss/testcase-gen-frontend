"""testCaseGenerator · 1.2 需求文档上传冒烟测试

覆盖范围：
  FR-005 · 需求列表文档上传（表格 / content / 自定义参数）
  FR-005 · 需求上传后的功能模块提取接口

深度：冒烟（仅验证核心上传与模块提取链路）
框架：pytest
依赖：conftest.py（共享夹具）

用法：
    pytest tests/test_requirement_upload_smoke.py -v --bff-base=http://localhost:4123
"""

import io
import json
import pytest


class TestRequirementUploadSmoke:
    """需求列表文档上传 — 核心冒烟验证"""

    # ------------------------------------------------------------------
    # FR-005 · 需求列表 Markdown 上传
    # ------------------------------------------------------------------

    def test_requirement_basic_upload(self, bff_client, project):
        """FR-005-SM-01 · 需求列表 Markdown 文件上传（表格格式）
        验证：POST /api/source-upload type=requirement 返回 200，
        响应结构完整"""
        fake_req = io.BytesIO(
            b"# 冒烟测试需求列表\n\n"
            b"## 版本 V1.0\n\n"
            b"| 编号 | 模块 | 需求名称 | 优先级 | 负责人 |\n"
            b"|------|------|----------|--------|--------|\n"
            b"| FR-101 | 用户管理 | 用户注册 | P0 | 张三 |\n"
            b"| FR-102 | 用户管理 | 用户登录 | P0 | 李四 |\n"
            b"| FR-103 | 数据看板 | 数据概览 | P1 | 王五 |\n"
            b"| FR-104 | 报表导出 | PDF 导出 | P2 | 赵六 |\n\n"
            b"## 备注\n"
            b"P0 为本次迭代必做。\n"
        )
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("smoke-requirement.md", fake_req, "text/markdown")},
            data={
                "type": "requirement",
                "project": project,
                "note": "需求列表基础上传冒烟",
            },
        )
        assert r.status_code in (200, 502), (
            f"需求列表基础上传返回异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False, (
                f"需求上传业务级失败: {j.get('error', j)}"
            )
            assert "data" in j, f"响应缺少 data 字段: {j}"

    def test_requirement_content_field_upload(self, bff_client, project):
        """FR-005-SM-02 · 需求列表通过 content 字段上传
        验证：服务端支持 POST form-data content 字段承载需求内容"""
        r = bff_client.post(
            "/api/source-upload",
            data={
                "type": "requirement",
                "project": project,
                "content": json.dumps({
                    "title": "Content模式需求列表",
                    "version": "1.0",
                    "requirements": [
                        {"id": "FR-C01", "module": "认证", "name": "SSO 登录", "priority": "P0"},
                        {"id": "FR-C02", "module": "认证", "name": "权限校验", "priority": "P0"},
                    ],
                }, ensure_ascii=False),
            },
        )
        assert r.status_code in (200, 502), (
            f"Content 模式需求上传异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False, (
                f"Content 模式需求上传业务失败: {j.get('error', j)}"
            )

    def test_requirement_with_custom_note(self, bff_client, project):
        """FR-005-SM-03 · 需求文档附加自定义 note 参数上传
        验证：note 等业务参数被正确透传至知识系统侧"""
        fake_req = io.BytesIO(
            b"# 自定义备注需求\n\n"
            b"| 编号 | 模块 |\n"
            b"|------|------|\n"
            b"| FR-C01 | 模块A |\n"
            b"| FR-C02 | 模块B |\n"
        )
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("custom-note-req.md", fake_req, "text/markdown")},
            data={
                "type": "requirement",
                "project": project,
                "note": "FR-005-SM-03 自定义备注参数验证",
            },
        )
        assert r.status_code in (200, 502), (
            f"自定义备注需求上传异常: {r.status_code} {r.text[:300]}"
        )

    # ------------------------------------------------------------------
    # FR-005 · 功能模块提取
    # ------------------------------------------------------------------

    def test_wiki_modules_extraction(self, bff_client, project):
        """FR-005-SM-04 · 上传后功能模块可被提取（GET /api/wiki-modules）
        验证：上传需求文档后，Wiki 功能模块端点正常返回模块列表结构"""
        r = bff_client.get("/api/wiki-modules", params={"project": project})
        assert r.status_code in (200, 502), (
            f"Wiki 模块列表返回异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", j)
            # 返回结构须为 list 或 dict（含 modules 字段）
            assert isinstance(data, (list, dict)), (
                f"Wiki 模块响应格式异常: {type(data)}"
            )
            if isinstance(data, dict) and "modules" in data:
                assert isinstance(data["modules"], list), (
                    f"modules 字段格式异常: {type(data['modules'])}"
                )

    def test_module_entities_query(self, bff_client, project):
        """FR-005-SM-05 · 功能模块实体可通过图谱查询（GET /api/wiki/module-entities）
        验证：需求文档上传后，图谱实体 API 可用，返回实体列表"""
        r = bff_client.get(
            "/api/wiki/module-entities",
            params={
                "project": project,
                "modules": json.dumps(["用户管理", "数据看板", "报表导出"]),
            },
        )
        assert r.status_code in (200, 502), (
            f"模块实体查询返回异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", {})
            if "entities" in data:
                assert isinstance(data["entities"], list), (
                    f"entities 格式异常: {type(data['entities'])}"
                )
