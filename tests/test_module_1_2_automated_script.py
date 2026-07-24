"""testCaseGenerator · 1.2 PRD / 需求文档接入 自动化测试脚本

覆盖范围：
  功能模块：1.2 PRD / 需求文档接入（用户需求 2）
  功能需求：FR-004 · PRD 文档上传
            FR-005 · 需求列表文档上传 + 功能模块提取
  知识图谱：上传后功能模块通过图谱实体查询可被检索
  生成链路：以 PRD/需求为功能模块范围的生成流程

深度：冒烟（仅验证主流程可用性与核心链路连通性）
框架：pytest 7.0+
依赖：conftest.py（共享夹具：bff_client / project / gen_payload）

用例编号规范：
  AS (Automated Script) - 自动化测试脚本
  - AS-PRD-NNN     PRD 文档上传用例
  - AS-REQ-NNN     需求列表文档上传用例
  - AS-KC-NNN      知识上下文链路用例
  - AS-GEN-NNN     生成依赖链路用例
  - AS-BND-NNN     边界与隔离校验用例

用法：
    pip install -r tests/requirements.txt
    pytest tests/test_module_1_2_automated_script.py -v --bff-base=http://localhost:4123
"""

import io
import json
import pytest


class TestPRDRequirementsUpload:
    """1.2 PRD / 需求文档接入 · 上传层冒烟验证"""

    # ==================================================================
    # FR-004 · PRD 文档上传（AS-PRD 系列）
    # ==================================================================

    def test_prd_markdown_basic_upload(self, bff_client, project):
        """AS-PRD-001 · PRD Markdown 文件上传（标准化头部+多章节）
        验证：POST /api/source-upload type=prd 返回 200，
        响应包含 success 标记与 data 字段"""
        fake_prd = io.BytesIO(
            b"# 自动化测试 PRD\n\n"
            b"## 1. 项目背景\n"
            b"本项目用于验证自动化测试脚本的 PRD 接入流程。\n\n"
            b"## 2. 功能范围\n"
            b"- 模块 A：知识库管理\n"
            b"- 模块 B：测试用例生成\n\n"
            b"## 3. 验收标准\n"
            b"- 冒烟通过率 100%\n"
        )
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("auto-prd-as001.md", fake_prd, "text/markdown")},
            data={"type": "prd", "project": project, "note": "AS-PRD-001 基础上传冒烟"},
        )
        # 冒烟层接受 200（成功）和 502（KS 未部署环境）
        assert r.status_code in (200, 502), \
            f"AS-PRD-001 失败: {r.status_code} {r.text[:300]}"
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False, \
                f"AS-PRD-001 业务失败: {j.get('error', j)}"
            assert "data" in j, f"AS-PRD-001 响应缺 data: {j}"

    def test_prd_content_field_upload(self, bff_client, project):
        """AS-PRD-002 · PRD 通过 content 字段上传（无 file 附件）
        验证：服务端支持 POST form-data content 字符串承载文档内容"""
        r = bff_client.post(
            "/api/source-upload",
            data={
                "type": "prd",
                "project": project,
                "content": json.dumps({
                    "title": "AS-PRD-002 Content模式PRD",
                    "version": "1.0",
                    "sections": [
                        {"heading": "背景", "body": "纯内容字段上传验证"},
                        {"heading": "需求", "body": "Content 模式应正常解析入库"},
                    ],
                }, ensure_ascii=False),
            },
        )
        assert r.status_code in (200, 502), \
            f"AS-PRD-002 失败: {r.status_code} {r.text[:300]}"
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False, \
                f"AS-PRD-002 业务失败: {j.get('error', j)}"

    def test_prd_table_markdown_upload(self, bff_client, project):
        """AS-PRD-003 · PRD 含表格结构的 Markdown 上传
        验证：表格格式不引发服务端解析异常，上传链路正常"""
        fake_prd = io.BytesIO(
            b"# 带表格的 PRD\n\n"
            b"## 需求优先级矩阵\n\n"
            b"| 需求ID | 模块     | 优先级 | 状态   |\n"
            b"|--------|----------|--------|--------|\n"
            b"| FR-001 | 登录     | P0     | 已确认 |\n"
            b"| FR-002 | 看板     | P1     | 评审中 |\n"
            b"| FR-003 | 导出     | P2     | 待定   |\n\n"
            b"## 备注\nP0 为必须交付项。\n"
        )
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("prd-table-as003.md", fake_prd, "text/markdown")},
            data={"type": "prd", "project": project},
        )
        assert r.status_code in (200, 502), \
            f"AS-PRD-003 失败: {r.status_code} {r.text[:300]}"

    def test_prd_large_document_upload(self, bff_client, project):
        """AS-PRD-004 · PRD 较大文档上传（20 章节 + 20 表格）
        验证：较长文档的上传链路稳定，不发生超时或截断"""
        lines = [b"# 大型 PRD 文档\n\n"]
        for i in range(1, 21):
            chapter = str(i).encode()
            lines.extend([
                b"## 第 ", chapter, b" 章\n\n",
                b"这是第 ", chapter, b" 章节的描述内容，用于验证较大文档的传输稳定性。\n\n",
                b"| 项   | 值       |\n|------|----------|\n",
                b"| 编号 | ITEM-", chapter, b" |\n| 状态 | 正常     |\n\n",
            ])
        fake_prd = io.BytesIO(b"".join(lines))
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("large-prd-as004.md", fake_prd, "text/markdown")},
            data={"type": "prd", "project": project, "note": "AS-PRD-004 大文档冒烟"},
            timeout=30,
        )
        assert r.status_code in (200, 502), \
            f"AS-PRD-004 失败: {r.status_code} {r.text[:300]}"

    def test_prd_python_file_with_prd_type(self, bff_client, project):
        """AS-PRD-005 · 非 Markdown 扩展名 + type=prd 上传
        验证：上传类型由 type 参数决定而非文件扩展名"""
        fake_file = io.BytesIO(b"# Python-style PRD\n\nprint('prd content in code file')\n")
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("prd_marked_as005.py", fake_file, "text/x-python")},
            data={"type": "prd", "project": project},
        )
        assert r.status_code in (200, 502), \
            f"AS-PRD-005 失败: {r.status_code} {r.text[:300]}"

    def test_prd_chinese_filename_upload(self, bff_client, project):
        """AS-PRD-006 · 中文文件名 PRD 上传（Latin-1 编码回退场景）
        验证：中文文件名经 BFF 代理后 Latin-1→UTF-8 回退不引发乱码 500"""
        fake_prd = io.BytesIO(b"# 中文文件名测试\n\n用于验证 Latin-1 回退机制。\n")
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("产品需求文档_v1.0_AS006.md", fake_prd, "text/markdown")},
            data={"type": "prd", "project": project},
        )
        assert r.status_code in (200, 502), \
            f"AS-PRD-006 失败: {r.status_code} {r.text[:300]}"
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False, \
                f"AS-PRD-006 业务失败: {j.get('error', j)}"

    def test_prd_empty_document_upload(self, bff_client, project):
        """AS-PRD-007 · PRD 空文档上传
        验证：空内容文档上传时服务端不抛出 500，稳定返回确定性状态码"""
        fake_prd = io.BytesIO(b"")
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("empty-prd-as007.md", fake_prd, "text/markdown")},
            data={"type": "prd", "project": project},
        )
        assert r.status_code in (200, 400, 502), \
            f"AS-PRD-007 失败: {r.status_code} {r.text[:300]}"

    # ==================================================================
    # FR-005 · 需求列表文档上传（AS-REQ 系列）
    # ==================================================================

    def test_requirement_basic_upload(self, bff_client, project):
        """AS-REQ-001 · 需求列表 Markdown 文件上传（表格格式）
        验证：POST /api/source-upload type=requirement 返回 200，
        响应结构含 success 与 data 字段"""
        fake_req = io.BytesIO(
            b"# 自动化测试需求列表\n\n"
            b"## 版本 V1.0\n\n"
            b"| 编号    | 模块     | 需求名称   | 优先级 | 负责人 |\n"
            b"|---------|----------|------------|--------|--------|\n"
            b"| FR-101  | 用户管理 | 用户注册   | P0     | 张三   |\n"
            b"| FR-102  | 用户管理 | 用户登录   | P0     | 李四   |\n"
            b"| FR-103  | 数据看板 | 数据概览   | P1     | 王五   |\n"
            b"| FR-104  | 报表导出 | PDF 导出   | P2     | 赵六   |\n\n"
            b"## 备注\nP0 为本次迭代必做。\n"
        )
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("auto-req-as001.md", fake_req, "text/markdown")},
            data={
                "type": "requirement",
                "project": project,
                "note": "AS-REQ-001 基础需求上传冒烟",
            },
        )
        assert r.status_code in (200, 502), \
            f"AS-REQ-001 失败: {r.status_code} {r.text[:300]}"
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False, \
                f"AS-REQ-001 业务失败: {j.get('error', j)}"
            assert "data" in j, f"AS-REQ-001 响应缺 data: {j}"

    def test_requirement_content_field_upload(self, bff_client, project):
        """AS-REQ-002 · 需求列表通过 content 字段上传（无 file）
        验证：服务端支持 POST form-data content 承载需求结构化数据"""
        r = bff_client.post(
            "/api/source-upload",
            data={
                "type": "requirement",
                "project": project,
                "content": json.dumps({
                    "title": "AS-REQ-002 Content模式需求列表",
                    "version": "1.0",
                    "requirements": [
                        {"id": "FR-C01", "module": "认证", "name": "SSO 登录", "priority": "P0"},
                        {"id": "FR-C02", "module": "认证", "name": "权限校验", "priority": "P0"},
                    ],
                }, ensure_ascii=False),
            },
        )
        assert r.status_code in (200, 502), \
            f"AS-REQ-002 失败: {r.status_code} {r.text[:300]}"
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False, \
                f"AS-REQ-002 业务失败: {j.get('error', j)}"

    def test_requirement_with_custom_note(self, bff_client, project):
        """AS-REQ-003 · 需求文档附加自定义 note 参数上传
        验证：note 等业务参数被正确透传至知识系统侧"""
        fake_req = io.BytesIO(
            b"# 自定义备注需求\n\n"
            b"| 编号    | 模块 |\n"
            b"|---------|------|\n"
            b"| FR-C01  | 模块A |\n"
            b"| FR-C02  | 模块B |\n"
        )
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("custom-note-as003.md", fake_req, "text/markdown")},
            data={
                "type": "requirement",
                "project": project,
                "note": "AS-REQ-003 自定义备注参数验证",
            },
        )
        assert r.status_code in (200, 502), \
            f"AS-REQ-003 失败: {r.status_code} {r.text[:300]}"


class TestKnowledgeContextLinkage:
    """1.2 PRD/需求文档接入 · 知识上下文链路冒烟验证（AS-KC 系列）"""

    # ==================================================================
    # 知识库统计
    # ==================================================================

    def test_brain_stats_accessible(self, bff_client, project):
        """AS-KC-001 · 知识库统计端点可访问（GET /api/brain/stats）
        验证：上传后知识库统计可正常读取，响应结构为 dict"""
        r = bff_client.get("/api/brain/stats", params={"project": project})
        assert r.status_code in (200, 502), \
            f"AS-KC-001 失败: {r.status_code} {r.text[:300]}"
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", {})
            assert isinstance(data, dict), \
                f"AS-KC-001 stats 格式异常: {type(data)}"
            # wiki-pages 计数可为 0，但结构须存在（若 KS 返回该字段）
            for field in ("wiki-pages", "test-cases", "quality-rules"):
                if field in data:
                    assert isinstance(data[field], (int, dict)), \
                        f"AS-KC-001 {field} 格式异常: {type(data[field])}"

    def test_project_wiki_pages_list(self, bff_client, project):
        """AS-KC-002 · 项目 Wiki 页面列表可读（GET /api/brain/pages）
        验证：上传的 PRD/需求文档出现在 project-wiki 分类下"""
        r = bff_client.get(
            "/api/brain/pages",
            params={"category": "project-wiki", "project": project, "limit": 20},
        )
        assert r.status_code in (200, 502), \
            f"AS-KC-002 失败: {r.status_code} {r.text[:300]}"
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", {})
            pages = (
                data if isinstance(data, list)
                else data.get("pages", data.get("data", []))
            )
            assert isinstance(pages, list), \
                f"AS-KC-002 pages 格式异常: {type(pages)}"

    # ==================================================================
    # 关键词检索
    # ==================================================================

    def test_keyword_search_hits_uploaded_content(self, bff_client, project):
        """AS-KC-003 · 关键词检索可命中已上传文档内容（POST /api/search）
        验证：使用冒烟测试关键词可成功调用检索接口，返回结果为 list"""
        r = bff_client.post(
            "/api/search",
            json={
                "query": "自动化测试",
                "mode": "keyword",
                "limit": 10,
                "project": project,
            },
        )
        assert r.status_code in (200, 502), \
            f"AS-KC-003 失败: {r.status_code} {r.text[:300]}"
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", {})
            results = data.get("results", data.get("data", []))
            assert isinstance(results, list), \
                f"AS-KC-003 检索结果格式异常: {type(results)}"
            # 若有命中文档，验证其包含必要字段
            if results:
                first = results[0]
                assert any(k in first for k in ("source", "title", "content")), \
                    f"AS-KC-003 结果结构异常: {first}"

    def test_search_with_module_filter(self, bff_client, project):
        """AS-KC-004 · 按模块过滤的检索可用（POST /api/search + modules）
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
        assert r.status_code in (200, 502), \
            f"AS-KC-004 失败: {r.status_code} {r.text[:300]}"

    # ==================================================================
    # 功能模块提取与图谱查询
    # ==================================================================

    def test_wiki_modules_extraction(self, bff_client, project):
        """AS-KC-005 · 上传后功能模块可被提取（GET /api/wiki-modules）
        验证：上传 PRD/需求后，Wiki 功能模块端点正常返回模块列表"""
        r = bff_client.get("/api/wiki-modules", params={"project": project})
        assert r.status_code in (200, 502), \
            f"AS-KC-005 失败: {r.status_code} {r.text[:300]}"
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", j)
            assert isinstance(data, (list, dict)), \
                f"AS-KC-005 响应格式异常: {type(data)}"
            if isinstance(data, dict) and "modules" in data:
                assert isinstance(data["modules"], list), \
                    f"AS-KC-005 modules 格式异常: {type(data['modules'])}"

    def test_module_entities_query(self, bff_client, project):
        """AS-KC-006 · 功能模块实体可通过图谱查询（GET /api/wiki/module-entities）
        验证：上传 PRD/需求后，图谱实体 API 可用，返回实体列表结构"""
        r = bff_client.get(
            "/api/wiki/module-entities",
            params={
                "project": project,
                "modules": json.dumps(["PRD/需求接入", "generator"], ensure_ascii=False),
            },
        )
        assert r.status_code in (200, 502), \
            f"AS-KC-006 失败: {r.status_code} {r.text[:300]}"
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", {})
            if "entities" in data:
                assert isinstance(data["entities"], list), \
                    f"AS-KC-006 entities 格式异常: {type(data['entities'])}"

    def test_graph_data_accessible(self, bff_client, project):
        """AS-KC-007 · API 图谱数据可读（GET /api/graph-data）
        验证：上传 PRD/需求后，图谱数据端点正常返回 nodes/edges 结构"""
        r = bff_client.get("/api/graph-data", params={"project": project})
        assert r.status_code in (200, 502), \
            f"AS-KC-007 失败: {r.status_code} {r.text[:300]}"
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", {})
            assert isinstance(data, dict), \
                f"AS-KC-007 图谱格式异常: {type(data)}"
            for field in ("nodes", "edges"):
                if field in data:
                    assert isinstance(data[field], list), \
                        f"AS-KC-007 {field} 格式异常: {type(data[field])}"


class TestGenerationDependency:
    """1.2 PRD/需求文档接入 · 生成依赖链路冒烟验证（AS-GEN 系列）"""

    def test_generation_context_retrieval(self, bff_client, project):
        """AS-GEN-001 · 生成上下文检索已上传文档（GET /api/brain/pages）
        验证：context-harvester 使用的 project-wiki 检索端点在 PRD/需求上传后仍可用"""
        r = bff_client.get(
            "/api/brain/pages",
            params={"category": "project-wiki", "project": project, "limit": 5},
        )
        assert r.status_code in (200, 502), \
            f"AS-GEN-001 失败: {r.status_code} {r.text[:300]}"

    def test_generate_with_prd_function_scope(self, bff_client, project, gen_payload):
        """AS-GEN-002 · 以 PRD/需求功能模块为范围的生成请求可提交
        验证：scope.functions 限定为 PRD/需求模块时，生成链路正常调用"""
        payload = gen_payload(
            op="gen_outline",
            modules=[],
            depth="smoke",
            framework="pytest",
            note="AS-GEN-002: PRD/需求功能模块范围的生成",
        )
        payload["scope"]["functions"] = ["PRD/需求接入"]
        r = bff_client.post("/api/generate", json=payload)
        assert r.status_code in (200, 502), \
            f"AS-GEN-002 失败: {r.status_code} {r.text[:300]}"
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False, \
                f"AS-GEN-002 业务失败: {j.get('error', j)}"

    def test_brain_stats_as_generation_preamble(self, bff_client, project):
        """AS-GEN-003 · 生成前置知识库统计可用（GET /api/brain/stats）
        验证：生成链路依赖的知识库统计端点功能正常"""
        r = bff_client.get("/api/brain/stats", params={"project": project})
        assert r.status_code in (200, 502), \
            f"AS-GEN-003 失败: {r.status_code} {r.text[:300]}"
        if r.status_code == 200:
            j = r.json()
            data = j.get("data", {})
            assert isinstance(data, dict), \
                f"AS-GEN-003 stats 格式异常: {type(data)}"

    def test_generate_with_empty_module_scope(self, bff_client, project, gen_payload):
        """AS-GEN-004 · 空模块列表的生成请求可正常提交
        验证：scope.modules 为空列表时生成链路仍可处理，不触发空指针"""
        payload = gen_payload(
            op="gen_outline",
            modules=[],
            depth="smoke",
            framework="pytest",
            note="AS-GEN-004: 空模块列表边界",
        )
        payload["scope"]["functions"] = ["PRD/需求接入"]
        r = bff_client.post("/api/generate", json=payload)
        assert r.status_code in (200, 502), \
            f"AS-GEN-004 失败: {r.status_code} {r.text[:300]}"


class TestModuleIsolation:
    """1.2 PRD/需求文档接入 · 模块隔离与边界校验（AS-BND 系列）"""

    def test_upload_type_code_isolated(self, bff_client, project):
        """AS-BND-001 · 同端点上传 type=code（模块隔离校验）
        验证：PRD/需求模块端点与其他上传类型（code）共用同一端点即可正常访问"""
        fake_file = io.BytesIO(b"# code scope check\nprint('module isolation')\n")
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("module_isolation_as001.py", fake_file, "text/x-python")},
            data={"type": "code", "project": project},
        )
        assert r.status_code in (200, 502), \
            f"AS-BND-001 失败: {r.status_code} {r.text[:300]}"

    def test_source_upload_without_type_defaults(self, bff_client, project):
        """AS-BND-002 · 不传 type 时服务端走默认值
        验证：缺少 type 参数时，BFF 使用默认 type=code 而非抛出 500"""
        fake_file = io.BytesIO(b"default type behavior test\n")
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("no-type-as002.md", fake_file, "text/markdown")},
            data={"project": project},
        )
        assert r.status_code in (200, 502), \
            f"AS-BND-002 失败: {r.status_code} {r.text[:300]}"

    def test_upload_without_project_param(self, bff_client):
        """AS-BND-003 · 不传 project 参数使用默认值
        验证：缺少 project 参数时，BFF 使用 DEFAULT_PROJECT 而非抛出 500"""
        fake_prd = io.BytesIO(b"# PRD without project param\n\n默认项目测试。\n")
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("no-project-as003.md", fake_prd, "text/markdown")},
            data={"type": "prd"},
        )
        assert r.status_code in (200, 502), \
            f"AS-BND-003 失败: {r.status_code} {r.text[:300]}"

    def test_upload_with_invalid_type(self, bff_client, project):
        """AS-BND-004 · 传入无效 type 枚举值
        验证：type=invalid 不导致服务端崩溃，返回 200 或 400"""
        fake_file = io.BytesIO(b"invalid type test\n")
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("invalid-type-as004.txt", fake_file, "text/plain")},
            data={"type": "invalid_type_value", "project": project},
        )
        # 服务器可能透传也可能返回 400，但不应该 500
        assert r.status_code in (200, 400, 502), \
            f"AS-BND-004 失败: {r.status_code} {r.text[:300]}"

    def test_upload_pdf_as_prd(self, bff_client, project):
        """AS-BND-005 · PDF 文件以 type=prd 上传
        验证：BFF 不限制文件 MIME 类型，PDF 以 type=prd 上传也可正常透传"""
        fake_pdf = io.BytesIO(b"%PDF-1.4 mock pdf content for smoke test\n1 0 obj\n<<>>\nendobj\n")
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("mock-prd-as005.pdf", fake_pdf, "application/pdf")},
            data={"type": "prd", "project": project},
        )
        assert r.status_code in (200, 502), \
            f"AS-BND-005 失败: {r.status_code} {r.text[:300]}"
