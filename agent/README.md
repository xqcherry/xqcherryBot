# Agent Gateway 包

这个目录可以作为独立的 Agent Gateway 包复制到服务器部署。

当前范围是 QQ 聊天 agent 后端。它刻意不暴露 ClaudeCode 风格的文件编辑、shell 执行、Git 操作、IDE 集成或编码子 agent。迁移过来的核心能力是运行时循环、会话记忆、上下文压缩、工具 schema，以及权限/审计流程。

## 1. 准备环境

复制示例环境变量文件，并填入真实值：

```bash
cp .env.example .env
```

示例里已经包含 DeepSeek V4 的 OpenAI-compatible 默认配置：

```env
AGENT_MODEL_PROVIDER=openai-compatible
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-v4-flash
AGENT_SUMMARY_MODEL=deepseek-v4-flash
AGENT_RECENT_MESSAGE_LIMIT=20
AGENT_UNCOMPACTED_MESSAGE_LIMIT=80
AGENT_SENDER_CONTEXT_LIMIT=6
AGENT_TURN_TIMEOUT_MS=120000
# AGENT_ALLOWED_TOOLS=get_recent_messages,get_active_memories,propose_memory_candidate
```

在 `.env` 中把 `OPENAI_API_KEY` 设置为你的真实 DeepSeek API key。  
如果想使用 DeepSeek 专用命名，也可以设置 `DEEPSEEK_API_KEY`。

模型层通过 `AGENT_MODEL_PROVIDER` 选择。当前已经实现的运行时适配器只有 `openai-compatible`，适用于支持 OpenAI 风格 `/chat/completions`、SSE 流式输出和工具调用的服务商。原生 Anthropic/Gemini provider 名称目前只是预留；在对应适配器实现前，配置这些名称会快速失败。

启动 gateway 前先配置 session store：

```env
AGENT_SESSION_STORE=sqlite
AGENT_GATEWAY_DB=./data/agent-gateway.sqlite
# AGENT_DATABASE_URL=sqlite:./data/agent-gateway.sqlite
```

当前已实现的持久化存储是 SQLite。`AGENT_GATEWAY_DB` 仍然保留以兼容旧配置；`AGENT_DATABASE_URL=sqlite:...` 是较新的 provider 风格配置。运行时存储层已经拆成 store 接口、内存实现、通用 SQL 实现、SQLite adapter/dialect 和文件式 migrations，后续添加 MySQL/PostgreSQL adapter 时不需要重写 gateway 接线。

## Prompt 同步

运行时会从本地 SQLite 的 `prompt_templates` 表读取已发布的 `CHAT_PERSONA` prompt。如果表里没有当前 `CHAT_PERSONA` 版本，运行时会回退到代码内置 prompt，除非设置了 `AGENT_PROMPT_FALLBACK_MODE=fail`。

Prompt 同步会读取 `config/prompts/current.json` 里的生产导出快照：

```bash
node scripts/apply-prompts.mjs --db ./data/agent-gateway.sqlite --file ./config/prompts/current.json
```

Persona 同步同样写入本地 SQLite，会读取 `config/personas/current.json`：

```bash
node scripts/apply-personas.mjs --db ./data/agent-gateway.sqlite --file ./config/personas/current.json
```

`apply-prompts.mjs`、`apply-personas.mjs` 和 gateway 运行时必须使用同一个数据库路径。否则可能出现 prompt/persona 导入到一个库，而 gateway 读取另一个库的情况。

生产环境如果希望启动更严格，可以设置：

```env
AGENT_PROMPT_FALLBACK_MODE=fail
```

这样只有 prompt 同步成功后才启动 gateway。健康检查响应会暴露当前 prompt 的来源和版本：

```json
{
  "prompt": {
    "chatPersona": {
      "promptKey": "CHAT_PERSONA",
      "source": "database",
      "fallback": false,
      "sourceVersionNo": 1,
      "sourcePublishedAt": "2026-06-15T00:00:00.000Z"
    }
  }
}
```

确认部署健康前，应该检查 `prompt.chatPersona.fallback` 是否为 `false`。

导出文件格式如下：

```json
{
  "exportedAt": "2026-06-15T00:00:00.000Z",
  "prompts": [
    {
      "promptKey": "CHAT_PERSONA",
      "name": "Chat Persona",
      "description": "Main QQ chat persona and behavior prompt.",
      "systemPrompt": "...",
      "userPrompt": "",
      "extraJson": null,
      "sourceVersionNo": 1,
      "sourcePublishedAt": "2026-06-15T00:00:00.000Z"
    }
  ]
}
```

## 2. Docker 启动

推荐使用 Docker 部署服务器版本。

```bash
mkdir -p data
docker compose up -d --build
docker compose logs -f agent-gateway
```

compose 文件会在容器内把 gateway 绑定到 `0.0.0.0`，并把 `${AGENT_GATEWAY_PORT:-8787}` 映射到宿主机。因为 v1 gateway 还没有实现公网认证，宿主机端口需要通过防火墙、VPN 或反向代理保护。

停止或重启：

```bash
docker compose down
docker compose restart agent-gateway
```

## 3. 本地 Node 启动

```bash
cd agent-server
npm install
```

从 agent 根目录运行，这样 `agent-server/src/cli.mjs` 会加载 `./.env`：

```bash
node agent-server/src/cli.mjs
```

也可以显式传入 env 文件：

```bash
AGENT_ENV_FILE=/opt/agent/.env node agent-server/src/cli.mjs
```

预期启动日志：

```json
{"type":"gateway_started","host":"127.0.0.1","port":8787}
```

健康检查：

```bash
curl -i http://127.0.0.1:8787/health
```

## 4. NoneBot 桥接

NoneBot 辅助代码位于本目录外的 `adapters/nonebot-napcat/adapter`。把该 `adapter` 目录复制到你的 NoneBot 项目根目录：

```text
your-nonebot-project/
├── adapter/
│   ├── __init__.py
│   ├── adapter.py
│   ├── plugin.py
│   └── tools.py
└── plugins/
    └── agent_bridge.py
```

在 NoneBot 环境中安装唯一运行时依赖：

```bash
pip install websockets
```

然后配置 NoneBot 插件连接到：

```env
AGENT_GATEWAY_URL=ws://127.0.0.1:8787
```

当 NoneBot 和 gateway 在同一台服务器上时，保持 `AGENT_GATEWAY_HOST=127.0.0.1`。只有在防火墙、VPN 或反向代理保护下，才使用 `0.0.0.0`，因为 v1 gateway 还没有实现公网认证。

adapter 会转发这些 QQ 管理命令：

```text
#agent status
#agent session
#agent reset summary
#agent reset context
#agent memory list
#agent memory approve <memory-id>
#agent memory delete <memory-id>
#agent allow <tool-call-id>
#agent deny <tool-call-id> [reason]
```
