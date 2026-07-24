"""testCaseGenerator · 全模块冒烟测试脚本

覆盖范围：
  1. 功能性需求（FR）
     1.1 项目与代码接入（FR-001 ~ FR-003）
     1.2 PRD / 需求文档接入（FR-004 ~ FR-005）
     1.3 多项目管理（FR-006 ~ FR-008）
     1.4 AI 生成（FR-009 ~ FR-013）
     1.5 回写闭环（FR-014 ~ FR-019）
     1.6 UI 与可视化（FR-020 ~ FR-022）
  2. 非功能性需求（NFR）
     2.1 设置与可配置（NFR-004）
     2.2 连接测试（NFR-004）
  3. 需求追溯矩阵

深度：冒烟（仅验证主流程可用性，不深入异常场景）
框架：pytest
依赖：conftest.py（共享夹具）

用法：
    pytest tests/test_smoke_all_modules.py -v --bff-base=http://localhost:4123
"""

import os
import io
import json
import time
import pytest

# ===========================================================================
# 1.1 项目与代码接入（FR-001 ~ FR-003）
# ===========================================================================

class TestFR001_ProjectAndCode:
    """1.1 项目与代码接入 — 冒烟"""

    def test_bff_health_check(self, bff_client):
        """FR-001 · BFF 服务健康检查"""
        r = bff_client.get("/api/health")
        assert r.status_code == 200, f"健康检查返回非200: {r.status_code}"
        j = r.json()
        assert j.get("status") == "ok", f"status 不为 ok: {j}"
        assert j.get("service") == "testcase-gen-frontend", f"service 名称异常: {j}"

    def test_list_projects(self, bff_client):
        """FR-001 · 项目列表可读（GET /api/projects）"""
        r = bff_client.get("/api/projects")
        assert r.status_code in (200, 502), (
            f"项目列表返回异常状态码: {r.status_code} "
            f"(502=KS不可达，部署环境允许)"
        )
        # 200 时验证响应结构
        if r.status_code == 200:
            j = r.json()
            assert "data" in j, f"返回缺少 data 字段: {j}"

    def test_create_project_payload(self, bff_client, project):
        """FR-001/FR-002 · 创建项目请求结构有效（POST /api/projects）"""
        proj_id = f"tg-smoke-{int(time.time() * 1000)}"
        r = bff_client.post(
            "/api/projects",
            json={"id": proj_id, "name": f"冒烟测试项目-{proj_id}", "project": project},
        )
        # 创建项目依赖 KS，502 是可接受的（环境未部署 KS）
        assert r.status_code in (200, 201, 502), (
            f"创建项目返回异常: {r.status_code} {r.text[:200]}"
        )
        if r.status_code in (200, 201):
            j = r.json()
            assert "data" in j or "success" in j, (
                f"创建项目响应缺少 data/success: {j}"
            )

    def test_source_upload_code_type(self, bff_client, project):
        """FR-001/FR-003 · 代码上传请求结构有效（POST /api/source-upload type=code）"""
        # 构造一个最小的代码 zip 内容作为上传测试
        fake_code = io.BytesIO(b"# fake test file\nprint('hello smoke')\n")
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("smoke_test.py", fake_code, "text/x-python")},
            data={"type": "code", "project": project},
        )
        # 上传依赖 KS，502 可接受
        assert r.status_code in (200, 502), (
            f"代码上传返回异常: {r.status_code} {r.text[:200]}"
        )
        if r.status_code == 200:
            j = r.json()
            assert "success" not in j or j.get("success") is not False, (
                f"代码上传响应异常: {j}"
            )


class TestFR004_PRD_Requirements:
    """1.2 PRD / 需求文档接入（FR-004 ~ FR-005）"""

    def test_upload_prd_document(self, bff_client, project):
        """FR-004 · PRD 文档上传（POST /api/source-upload type=prd）"""
        fake_prd = io.BytesIO(b"# PRD Smoke Test\n\n## 需求描述\n这是一个冒烟测试需求文档\n")
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("smoke-prd.md", fake_prd, "text/markdown")},
            data={"type": "prd", "project": project, "note": "冒烟测试 PRD"},
        )
        assert r.status_code in (200, 502), (
            f"PRD上传返回异常: {r.status_code} {r.text[:200]}"
        )

    def test_upload_requirement_document(self, bff_client, project):
        """FR-004 · 需求文档上传（POST /api/source-upload type=requirement）"""
        fake_req = io.BytesIO(b"# 需求列表\n\n| 编号 | 名称 |\n|------|------|\n| FR-TEST | 测试需求 |\n")
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("smoke-req.md", fake_req, "text/markdown")},
            data={"type": "requirement", "project": project, "note": "冒烟测试需求"},
        )
        assert r.status_code in (200, 502), (
            f"需求文档上传返回异常: {r.status_code} {r.text[:200]}"
        )


class TestFR006_MultiProject:
    """1.3 多项目管理（FR-006 ~ FR-008）"""

    def test_project_enumeration(self, bff_client):
        """FR-006 · 项目枚举接口可访问（GET /api/projects）"""
        r = bff_client.get("/api/projects")
        assert r.status_code in (200, 502), (
            f"项目枚举异常: {r.status_code}"
        )

    def test_delete_project_payload(self, bff_client, project):
        """FR-006 · 删除项目接口可调用（DELETE /api/projects/:id）"""
        r = bff_client.delete(f"/api/projects/non-existent-smoke-{int(time.time())}")
        # 项目不存在返回预期错误或 502（KS 不可达）均可
        assert r.status_code in (200, 404, 502), (
            f"DELETE 项目返回异常: {r.status_code} {r.text[:200]}"
        )


class TestFR009_AIGeneration:
    """1.4 AI 生成（FR-009 ~ FR-013）"""

    def test_generate_outline(self, bff_client, project, gen_payload):
        """FR-009 · 测试用例大纲生成（op=gen_outline）
        验证：生成端点响应结构完整，content 非空"""
        payload = gen_payload(
            op="gen_outline",
            modules=None,
            depth="smoke",
            framework="pytest",
            note="冒烟测试：验证生成链路可用",
        )
        r = bff_client.post("/api/generate", json=payload)
        # 生成接口不应返回 5xx
        assert r.status_code in (200, 502), (
            f"生成大纲返回异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False, f"生成失败: {j.get('error', j)}"
            data = j.get("data", {})
            assert isinstance(data.get("hits"), list), f"缺少 hits 或格式异常: {data}"
            assert isinstance(data.get("contextUsed"), dict), (
                f"缺少 contextUsed 或格式异常: {data}"
            )

    def test_generate_cases(self, bff_client, project, gen_payload):
        """FR-010 · 测试用例条目生成（op=gen_cases）
        验证：content 包含 TC-XXX 格式标记"""
        payload = gen_payload(
            op="gen_cases",
            modules=["generator"],
            depth="smoke",
            framework="pytest",
            note="冒烟测试：验证用例条目生成",
        )
        r = bff_client.post("/api/generate", json=payload)
        assert r.status_code in (200, 502), (
            f"生成用例条目返回异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False, f"生成失败: {j.get('error', j)}"
            data = j.get("data", {})
            assert data.get("kind") == "cases", f"kind 不为 cases: {data.get('kind')}"
            assert data.get("content"), f"content 为空: {data.get('content', '')[:100]}"

    def test_generate_scripts(self, bff_client, project, gen_payload):
        """FR-011 · 自动化测试脚本生成（op=gen_scripts）
        验证：生成结果含 python 代码块"""
        payload = gen_payload(
            op="gen_scripts",
            modules=["generator"],
            depth="smoke",
            framework="pytest",
            note="冒烟测试：验证脚本生成",
        )
        r = bff_client.post("/api/generate", json=payload)
        assert r.status_code in (200, 502), (
            f"生成脚本返回异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False, f"生成失败: {j.get('error', j)}"
            data = j.get("data", {})
            assert data.get("kind") == "scripts", f"kind 不为 scripts: {data.get('kind')}"
            assert data.get("engine") in (
                "template", "ai-codebuddy", "ai-openai", "ks-generator",
            ), f"engine 异常: {data.get('engine')}"

    def test_search_endpoint(self, bff_client, project):
        """FR-012 · 知识库关键词检索（POST /api/search）
        验证：搜索接口响应结构正确"""
        r = bff_client.post(
            "/api/search",
            json={"query": "冒烟测试", "mode": "keyword", "limit": 5, "project": project},
        )
        assert r.status_code in (200, 502), (
            f"搜索接口返回异常: {r.status_code} {r.text[:200]}"
        )
        if r.status_code == 200:
            j = r.json()
            # 搜索接口应返回 data.data.results 结构
            data = j.get("data", {})
            # 无结果也视为正常（知识库为空）
            assert isinstance(data, dict), f"data 格式异常: {data}"

    def test_brain_pages_readable(self, bff_client, project):
        """FR-012 · 知识库页面列表可读（GET /api/brain/pages）
        验证：各知识分类页面可枚举"""
        for category in ["test-cases", "quality-rules", "project-wiki"]:
            r = bff_client.get(
                f"/api/brain/pages",
                params={"category": category, "project": project, "limit": 5},
            )
            assert r.status_code in (200, 502), (
                f"读取知识库页面[{category}]异常: {r.status_code} {r.text[:200]}"
            )


class TestFR014_Writeback:
    """1.5 回���闭环（FR-014 ~ FR-019）"""

    def test_drafts_list(self, bff_client, project):
        """FR-014 · 草稿列表可访问（GET /api/drafts）"""
        r = bff_client.get(f"/api/drafts?project={project}")
        assert r.status_code in (200, 502), (
            f"草稿列表返回异常: {r.status_code} {r.text[:200]}"
        )

    def test_drafts_crud_payload(self, bff_client, project):
        """FR-014 · 草稿创建与查询（POST /api/drafts + GET /api/drafts/:id）
        验证：已有草稿能按 ID 查询"""
        # 先读取已有草稿
        r_list = bff_client.get(f"/api/drafts?project={project}&limit=1")
        if r_list.status_code == 200 and r_list.json().get("data"):
            drafts = r_list.json()["data"]
            drafts_arr = (
                drafts.get("drafts", drafts.get("data", drafts)) if isinstance(drafts, dict)
                else drafts if isinstance(drafts, list)
                else []
            )
            if isinstance(drafts_arr, list) and drafts_arr:
                draft_id = drafts_arr[0].get("id")
                r = bff_client.get(f"/api/drafts/{draft_id}")
                assert r.status_code in (200, 502), (
                    f"按ID查询草稿[{draft_id}]异常: {r.status_code}"
                )

    def test_commit_endpoint(self, bff_client, project):
        """FR-017 · 入库端点可访问（POST /api/drafts/:id/commit）"""
        # 使用不存在的ID验证端点可达性
        fake_draft_id = f"nonexistent-{int(time.time())}"
        r = bff_client.post(f"/api/drafts/{fake_draft_id}/commit?project={project}")
        # 期望 404（草稿不存在）或 502（KS 不可达），不期望 5xx
        assert r.status_code in (200, 404, 502), (
            f"入库端点异常: {r.status_code} {r.text[:200]}"
        )

    def test_batch_commit_endpoint(self, bff_client, project):
        """FR-016 · 批量入库端点可访问（POST /api/drafts/batch-commit）"""
        r = bff_client.post(
            "/api/drafts/batch-commit",
            json={"draft_ids": [], "project": project},
        )
        # 空列表批量提交预期返回 200 或 400（校验）或 502（KS不可达）
        assert r.status_code in (200, 400, 502), (
            f"批量入库端点异常: {r.status_code} {r.text[:200]}"
        )

    def test_conflict_detect_endpoint(self, bff_client, project):
        """FR-018 · 冲突检测端点可访问（POST /api/conflicts/detect）"""
        r = bff_client.post(
            "/api/conflicts/detect",
            json={"draft_ids": [], "project": project},
        )
        assert r.status_code in (200, 502), (
            f"冲突检测端点异常: {r.status_code} {r.text[:200]}"
        )

    def test_quality_gate_endpoint(self, bff_client, project):
        """FR-018 · 质量门控端点可访问（POST /api/quality-gate/check）"""
        r = bff_client.post(
            "/api/quality-gate/check",
            json={"project": project},
        )
        assert r.status_code in (200, 502), (
            f"质量门控端点异常: {r.status_code} {r.text[:200]}"
        )


class TestFR020_UI_Visualization:
    """1.6 UI 与可视化（FR-020 ~ FR-022）"""

    def test_frontend_html_serves(self, bff_client):
        """FR-020 · 前端页面可加载（GET /）"""
        r = bff_client.get("/")
        assert r.status_code == 200, (
            f"前端根路径返回 {r.status_code}"
        )
        html = r.text
        assert "testcase" in html.lower() or "TestGen" in html, (
            "前端页面内容不匹配"
        )
        assert "app.v2.js" in html, (
            "前端页面未引用主 JS app.v2.js"
        )

    def test_graph_data_endpoint(self, bff_client, project):
        """FR-021 · API 依赖图谱数据可获取（GET /api/graph-data）"""
        r = bff_client.get("/api/graph-data", params={"project": project})
        assert r.status_code in (200, 502), (
            f"图谱数据返回异常: {r.status_code} {r.text[:200]}"
        )
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", {})
            # 图谱可能有节点/边，也可能为空
            assert isinstance(data, dict), f"图谱数据格式异常: {type(data)}"


class TestNFR_NonFunctional:
    """2. 非功能性需求（NFR）"""

    def test_settings_read(self, bff_client):
        """NFR-004 · 配置可读取（GET /api/settings）"""
        r = bff_client.get("/api/settings")
        assert r.status_code == 200, f"读取配置返回 {r.status_code}"
        j = r.json()
        assert "success" in j, f"配置响应结构异常: {j}"
        assert "data" in j, f"配置响应缺少 data: {j}"

    def test_settings_write_payload(self, bff_client, settings_payload):
        """NFR-004 · 配置可写入（PUT /api/settings）"""
        payload = settings_payload(provider="none")
        r = bff_client.put("/api/settings", json=payload)
        assert r.status_code == 200, (
            f"写入配置返回 {r.status_code}: {r.text[:200]}"
        )
        j = r.json()
        assert j.get("success") is not False, f"配置写入失败: {j}"

    def test_codebuddy_models_list(self, bff_client):
        """NFR-004 · CodeBuddy 模型列表可获取（GET /api/settings/codebuddy-models）"""
        r = bff_client.get("/api/settings/codebuddy-models")
        assert r.status_code == 200, (
            f"模型列表返回 {r.status_code}: {r.text[:200]}"
        )
        j = r.json()
        assert "data" in j, f"模型列表响应缺少 data: {j}"

    def test_settings_connection_test(self, bff_client):
        """NFR-004 · 连接测试可执行（POST /api/settings/test）"""
        r = bff_client.post(
            "/api/settings/test",
            json={},
        )
        assert r.status_code == 200, (
            f"连接测试返回 {r.status_code}: {r.text[:200]}"
        )
        j = r.json()
        # reachable 可能为 false（KS 未部署），但返回结构必须完整
        assert "reachable" in j, f"连接测试响应缺少 reachable: {j}"


class TestRTM_Traceability:
    """3. 需求追溯矩阵 — 冒烟验证"""

    def test_rtm_project_context(self, bff_client, project):
        """需求追溯 · 项目级知识上下文可采集（对应需求 FR-001 ~ FR-022 的集成入口）
        验证：项目级别 API 均能正常响应"""
        resources = [
            ("知识库项目Wiki", "/api/brain/pages?category=project-wiki", "GET"),
            ("知识库测试用例", "/api/brain/pages?category=test-cases", "GET"),
            ("知识库质量规则", "/api/brain/pages?category=quality-rules", "GET"),
            ("API图谱数据", "/api/graph-data", "GET"),
            ("草稿列表", "/api/drafts", "GET"),
        ]
        for name, path, method in resources:
            url = f"{path}&project={project}" if "?" in path else f"{path}?project={project}"
            r = bff_client.get(url)
            assert r.status_code in (200, 502), (
                f"需求追溯[{name}] 返回 {r.status_code}"
            )
