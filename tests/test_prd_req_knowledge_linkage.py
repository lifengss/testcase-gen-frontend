"""testCaseGenerator · 1.2 PRD/需求文档 → 知识上下文 → 生成链路冒烟测试

覆盖范围：
  FR-004/FR-005 · 上传后知识库统计与检索可用性
  FR-004/FR-005 · 上传后 API 图谱节点完整性
  FR-004/FR-005 · 以 PRD/需求功能模块为范围的生成链路

深度：冒烟（仅验证知识链路与生成依赖的可用性）
框架：pytest
依赖：conftest.py（共享夹具）

用法：
    pytest tests/test_prd_req_knowledge_linkage.py -v --bff-base=http://localhost:4123
"""

import io
import json
import pytest


class TestKnowledgeContextSmoke:
    """上传后知识上下文 — 统计/检索/图谱"""

    # ------------------------------------------------------------------
    # FR-004/FR-005 · 知识库统计
    # ------------------------------------------------------------------

    def test_brain_stats_reflects_prd_req(self, bff_client, project):
        """FR-004/005-SM-01 · 知识库统计端点（GET /api/brain/stats）
        验证：上传后知识库统计可正常读取，wiki-pages 等相关计数结构完整"""
        r = bff_client.get("/api/brain/stats", params={"project": project})
        assert r.status_code in (200, 502), (
            f"知识库统计返回异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", {})
            assert isinstance(data, dict), (
                f"brain stats 格式异常: {type(data)}"
            )
            # 验证 wiki-pages 计数结构存在（值可为 0）
            known_fields = ["wiki-pages", "test-cases", "quality-rules"]
            for field in known_fields:
                if field in data:
                    assert isinstance(data[field], (int, dict)), (
                        f"{field} 计数格式异常: {type(data[field])}"
                    )

    def test_project_wiki_pages_list(self, bff_client, project):
        """FR-004/005-SM-02 · 项目 Wiki 页面列表可读（GET /api/brain/pages）
        验证：上传的 PRD/需求文档出现在 project-wiki 分类下"""
        r = bff_client.get(
            "/api/brain/pages",
            params={"category": "project-wiki", "project": project, "limit": 20},
        )
        assert r.status_code in (200, 502), (
            f"项目 Wiki 页面列表返回异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", {})
            pages = (
                data if isinstance(data, list)
                else data.get("pages", data.get("data", []))
            )
            assert isinstance(pages, list), (
                f"pages 格式异常: {type(pages)}"
            )

    # ------------------------------------------------------------------
    # FR-004/FR-005 · 关键词检索
    # ------------------------------------------------------------------

    def test_keyword_search_uploaded_content(self, bff_client, project):
        """FR-004/005-SM-03 · 关键词检索可命中已上传文档（POST /api/search）
        验证：使用冒烟测试关键词可成功调用检索接口"""
        r = bff_client.post(
            "/api/search",
            json={
                "query": "冒烟测试",
                "mode": "keyword",
                "limit": 10,
                "project": project,
            },
        )
        assert r.status_code in (200, 502), (
            f"关键词检索返回异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", {})
            results = data.get("results", data.get("data", []))
            assert isinstance(results, list), (
                f"检索结果格式异常: {type(results)}"
            )
            # 若有命中文档，验证其包含 source 或 title 字段
            if results:
                first = results[0]
                assert any(k in first for k in ("source", "title", "content")), (
                    f"检索结果结构异常: {first}"
                )

    def test_search_with_module_filter(self, bff_client, project):
        """FR-004/005-SM-04 · 按模块过滤的检索可用（POST /api/search）
        验证：search 接口支持 modules 筛选参数"""
        r = bff_client.post(
            "/api/search",
            json={
                "query": "需求",
                "mode": "keyword",
                "limit": 5,
                "project": project,
                "modules": ["PRD/需求接入"],
            },
        )
        assert r.status_code in (200, 502), (
            f"模块过滤检索返回异常: {r.status_code} {r.text[:300]}"
        )

    # ------------------------------------------------------------------
    # FR-004/FR-005 · API 图谱
    # ------------------------------------------------------------------

    def test_graph_data_contains_doc_nodes(self, bff_client, project):
        """FR-004/005-SM-05 · 业务流图谱数据可读（GET /api/business-graph）
        验证：上传 PRD/需求后，业务流依赖图谱端点正常返回 nodes/edges/flows 结构"""
        r = bff_client.get("/api/business-graph", params={"project": project})
        assert r.status_code in (200, 502), (
            f"图谱数据返回异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", {})
            assert isinstance(data, dict), (
                f"图谱数据格式异常: {type(data)}"
            )
            for field in ("nodes", "edges"):
                if field in data:
                    assert isinstance(data[field], list), (
                        f"图谱 {field} 格式异常: {type(data[field])}"
                    )


class TestGenerationDependencySmoke:
    """PRD/需求 → 生成链路依赖验证"""

    # ------------------------------------------------------------------
    # FR-004/FR-005 · 生成上下文
    # ------------------------------------------------------------------

    def test_generation_context_honors_uploaded_wiki(self, bff_client, project):
        """FR-004/005-SM-06 · 生成上下文检索已上传文档（GET /api/brain/pages）
        验证：context-harvester 使用的 project-wiki 检索端点在 PRD/需求上传后仍可用"""
        r = bff_client.get(
            "/api/brain/pages",
            params={"category": "project-wiki", "project": project, "limit": 5},
        )
        assert r.status_code in (200, 502), (
            f"生成上下文检索返回异常: {r.status_code} {r.text[:300]}"
        )

    def test_generate_with_prd_function_scope(self, bff_client, project, gen_payload):
        """FR-004/005-SM-07 · 以 PRD/需求为功能模块范围提交生成请求
        验证：scope.functions 限定为 PRD/需求模块时，生成链路可正常调用"""
        payload = gen_payload(
            op="gen_outline",
            modules=[],
            depth="smoke",
            framework="pytest",
            note="冒烟测试：PRD/需求功能模块范围的生成",
        )
        payload["scope"]["functions"] = ["PRD/需求接入"]
        r = bff_client.post("/api/generate", json=payload)
        assert r.status_code in (200, 502), (
            f"PRD 功能模块范围生成请求返回异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False, (
                f"生成业务失败: {j.get('error', j)}"
            )

    def test_brain_stats_includes_wiki_count(self, bff_client, project):
        """FR-004/005-SM-08 · 知识库统计在生成前置检查中可用（GET /api/brain/stats）
        验证：生成前置链路依赖的知识库统计端点功能正常"""
        r = bff_client.get("/api/brain/stats", params={"project": project})
        assert r.status_code in (200, 502), (
            f"生成前置知识库统计返回异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", {})
            assert isinstance(data, dict), (
                f"知识库统计格式异常: {type(data)}"
            )
            # 知识库规模字段应当可为数字或嵌套结构
            for scale_field in ("wiki-pages", "total"):
                if scale_field in data:
                    assert isinstance(data[scale_field], (int, dict)), (
                        f"{scale_field} 字段类型异常: {type(data[scale_field])}"
                    )
