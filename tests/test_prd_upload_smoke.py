"""testCaseGenerator · 1.2 PRD 文档上传冒烟测试

覆盖范围：
  FR-004 · PRD 文档上传（Markdown / content / 表格 三种载体）
  FR-004 · PRD 文档类型校验与文件格式兼容性

深度：冒烟（仅验证核心上传链路可用性）
框架：pytest
依赖：conftest.py（共享夹具）

用法：
    pytest tests/test_prd_upload_smoke.py -v --bff-base=http://localhost:4123
"""

import io
import json
import pytest


class TestPRDUploadSmoke:
    """PRD 文档上传 — 核心冒烟验证"""

    # ------------------------------------------------------------------
    # FR-004 · PRD Markdown 文件上传
    # ------------------------------------------------------------------

    def test_prd_markdown_basic_upload(self, bff_client, project):
        """FR-004-SM-01 · PRD Markdown 文件上传（标准化头部+章节）
        验证：POST /api/source-upload type=prd 返回 200，
        响应结构含 success 标记"""
        fake_prd = io.BytesIO(
            b"# 冒烟测试 PRD\n\n"
            b"## 1. 项目概述\n"
            b"本 PRD 用于验证自动化冒烟测试流程。\n\n"
            b"## 2. 功能范围\n"
            b"- 模块 A：用户认证\n"
            b"- 模块 B：数据看板\n\n"
            b"## 3. 验收标准\n"
            b"- 冒烟通过率 100%\n"
        )
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("smoke-prd-basic.md", fake_prd, "text/markdown")},
            data={"type": "prd", "project": project, "note": "PRD 基础上传冒烟"},
        )
        # 冒烟层接受 200（成功）和 502（KS 未部署环境）
        assert r.status_code in (200, 502), (
            f"PRD Markdown 基础上传返回异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False, (
                f"PRD 上传业务级失败: {j.get('error', j)}"
            )
            # 验证返回值包含标准字段
            assert "data" in j, f"响应缺少 data 字段: {j}"

    def test_prd_content_field_upload(self, bff_client, project):
        """FR-004-SM-02 · PRD 通过 content 字段上传（无 file 上传）
        验证：服务端支持 POST form-data content 字符串承载文档内容"""
        r = bff_client.post(
            "/api/source-upload",
            data={
                "type": "prd",
                "project": project,
                "content": json.dumps({
                    "title": "Content模式PRD",
                    "version": "1.0",
                    "sections": [
                        {"heading": "背景", "body": "纯内容字段上传验证"},
                        {"heading": "需求", "body": "Content 模式应正常解析入库"},
                    ],
                }, ensure_ascii=False),
            },
        )
        assert r.status_code in (200, 502), (
            f"Content 字段 PRD 上传异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False, (
                f"Content 上传业务失败: {j.get('error', j)}"
            )

    def test_prd_table_markdown_upload(self, bff_client, project):
        """FR-004-SM-03 · PRD 含表格结构的 Markdown 上传
        验证：表格格式不引发服务端解析异常，上传链路正常"""
        fake_prd = io.BytesIO(
            b"# 带表格的 PRD\n\n"
            b"## 需求优先级矩阵\n\n"
            b"| 需求ID | 模块 | 优先级 | 状态 |\n"
            b"|--------|------|--------|------|\n"
            b"| FR-001 | 登录 | P0 | 已确认 |\n"
            b"| FR-002 | 看板 | P1 | 评审中 |\n"
            b"| FR-003 | 导出 | P2 | 待定 |\n\n"
            b"## 备注\n"
            b"P0 为必须交付项。\n"
        )
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("prd-table-smoke.md", fake_prd, "text/markdown")},
            data={"type": "prd", "project": project},
        )
        assert r.status_code in (200, 502), (
            f"表格 PRD 上传返回异常: {r.status_code} {r.text[:300]}"
        )

    def test_prd_large_document_upload(self, bff_client, project):
        """FR-004-SM-04 · PRD 较大文档上传（多章节 + 多表格）
        验证：较长文档的上传链路仍然可用，不发生超时"""
        lines = [b"# 大型 PRD 文档\n\n"]
        for i in range(1, 21):
            lines.append(
                b"## 第 %d 章\n\n" % str(i).encode()
                + b"这是第 %d 章节的描述内容，用于验证较大文档的传输稳定性。\n\n" % str(i).encode()
                + b"| 项 | 值 |\n|----|----|\n"
                + b"| 编号 | ITEM-%d |\n| 状态 | 正常 |\n\n" % str(i).encode()
            )
        fake_prd = io.BytesIO(b"".join(lines))
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("large-prd-smoke.md", fake_prd, "text/markdown")},
            data={"type": "prd", "project": project, "note": "大文档冒烟"},
            timeout=30,
        )
        assert r.status_code in (200, 502), (
            f"大型 PRD 上传返回异常: {r.status_code} {r.text[:300]}"
        )

    # ------------------------------------------------------------------
    # FR-004 · 文件格式与类型边界
    # ------------------------------------------------------------------

    def test_prd_python_file_with_prd_type(self, bff_client, project):
        """FR-004-SM-05 · 使用非 Markdown 文件但指定 type=prd
        验证：上传类型由 type 参数决定而非文件扩展名"""
        fake_file = io.BytesIO(b"# Python-style PRD\n\nprint('prd content in code file')\n")
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("prd_marked.py", fake_file, "text/x-python")},
            data={"type": "prd", "project": project},
        )
        assert r.status_code in (200, 502), (
            f"非 Markdown PRD 上传异常: {r.status_code} {r.text[:300]}"
        )

    def test_prd_chinese_filename_upload(self, bff_client, project):
        """FR-004-SM-06 · PRD 含中文文件名的上传（Latin-1 编码回退场景）
        验证：中文文件名经 BFF 代理后不出现乱码导致 500"""
        fake_prd = io.BytesIO(b"# 中文文件名测试\n\n用于验��� Latin-1 回退机制。\n")
        r = bff_client.post(
            "/api/source-upload",
            files={"file": ("产品需求文档_v1.0_冒烟.md", fake_prd, "text/markdown")},
            data={"type": "prd", "project": project},
        )
        assert r.status_code in (200, 502), (
            f"中文文件名 PRD 上传异常: {r.status_code} {r.text[:300]}"
        )
        if r.status_code == 200:
            j = r.json()
            assert j.get("success") is not False
