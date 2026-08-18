# 第 10 章 · 系统设置：KS 与 AI 平台对接

TestGen 通过 BFF 连接两个后端：**知识系统 KS** 与 **AI 平台**。这两端的地址与凭证都在「系统设置」中配置。点击左下角 **⚙ 齿轮** 打开设置弹窗。

![系统设置](/tutorial/assets/settings.png "系统设置：KS API 地址 + AI 平台供应商")

## 10.1 知识库系统（KS）

- **KS API 地址**：默认 `http://localhost:3000`，指向 KS 知识系统的 REST 服务；
- 修改后即时生效，无需重启服务。

## 10.2 AI 平台

「供应商」下拉提供三种模式：

- **OpenAI 兼容**：对接豆包 / 火山方舟 / TokenHub 等 OpenAI 风格接口，需填 API Endpoint、Key、模型；
- **CodeBuddy（内置 / 自定义模型）**：选「内置模型」时从已注册模型列表选择；选「自定义模型（自有 endpoint）」时填自有地址与 key；
- **关闭**：仅使用本地模板兜底，不调用任何外部模型。

CodeBuddy 通道额外提供 **最大生成轮次 (maxTurns)**（建议 6–12）：生成步骤多时调大可避免「Max turns exceeded」。

## 10.3 「测试连接」双系统连通探测

点击 **测试连接**，系统会**同时探测 KS 与 AI 平台**两端，并返回各自的连通结果：

![测试连接结果](/tutorial/assets/settings-test.png "测试连接：同时返回 KS 与 AI 平台的连通结果")

- KS 不可达 → 提示检查 KS API 地址与 KS 服务是否启动；
- AI 不可达 → 提示检查供应商配置 / key / 网络；
- 两端均可达 → 显示绿色连通标记。

## 10.4 保存

确认无误后点击 **保存设置**（修改即时生效，无需重启）。页脚状态栏的「AI 平台 / 知识系统」指示灯会随连通状态变化。

## 案例：配置自有模型 endpoint 并验证连通

1. 打开系统设置，供应商选 **CodeBuddy**，模型来源切到 **自定义模型（自有 endpoint）**。
2. 填写自有 `API Endpoint`、固定 `API Key`、模型 id（如注册到 CodeBuddy 的 `my-hy3`），`maxTurns` 设为 `10`。
3. 点击 **测试连接**，确认 KS 与 AI 平台均显示可达。
4. 点击 **保存设置**，返回生成中心生成用例，即走该自有模型 endpoint。

> 提示：国内版 CodeBuddy 需确保环境变量 `CODEBUDDY_INTERNET_ENVIRONMENT=internal`；自定义模型需本地 `.codebuddy/models.json` 注册后才会被解析。

下一章按真实业务场景给出端到端使用案例。
