# Style Profile 定制化风格系统 TODO

## 目标

设计一个独立的 Style Profile 系统，用来定制 agent 的说话风格。它不替代 `CHAT_PERSONA`，也不和 skill/tool 混在一起。

建议分层：

```text
CHAT_PERSONA = 基础人格和底线
Style Profile = 说话风格
Skill = 任务策略
Memory = 长期偏好/事实
Tool = 外部动作
```

## v1 TODO

- [ ] 定义架构分层  
  明确 `CHAT_PERSONA`、`Style Profile`、`Skill`、`Memory`、`Tool` 的职责边界。

- [ ] 新增 `StyleProvider` 概念  
  负责根据当前 turn 选择启用的风格。

- [ ] 新增文件式风格配置  
  初版放在：
  ```text
  agent/config/styles/current.json
  ```

- [ ] 设计 `current.json` 结构  
  包含：
  ```text
  defaultStyleKey
  styles[]
  bindings[]
  ```

- [ ] 设计 style profile 字段  
  每个风格包含：
  ```text
  styleKey
  name
  description
  instructions[]
  ```

- [ ] 设计 binding 字段  
  每条绑定包含：
  ```text
  scope: user | session
  subjectId
  styleKey
  ```

- [ ] 设计风格选择优先级  
  建议：
  ```text
  用户绑定 > 会话/群绑定 > 默认风格 > 无风格
  ```

- [ ] 在 `ContextEngine` 中接入风格  
  在上下文 block 顺序中插入：
  ```text
  CHAT_PERSONA
  -> turn-context
  -> active-style
  -> skills
  -> status/memory/summary/recent/current message
  ```

- [ ] 设计 `styleBlock` 内容  
  注入为 system context block，例如：
  ```text
  Current response style:
  - styleKey: casual_group_friend
  - name: 群友自然风格
  - Instructions:
    - 回复像熟人群聊，不要像客服。
    - 默认简短，除非用户明确要求详细。
  ```

- [ ] 设计 `FileStyleProvider`  
  从 `agent/config/styles/current.json` 读取配置，解析并选择当前风格。

- [ ] 在 `gateway-service` 中创建并注入 `styleProvider`  
  启动 gateway 时传给 `ContextEngine`。

- [ ] 设计无配置 fallback  
  如果配置文件不存在、`defaultStyleKey` 无效、`styleKey` 找不到：
  ```text
  不注入 style block
  不影响正常聊天
  记录诊断信息
  ```

- [ ] 设计诊断输出  
  在 health 或 `get_agent_diag` 中暴露：
  ```text
  currentStyle.styleKey
  currentStyle.name
  currentStyle.source
  ```

- [ ] 添加单元测试  
  覆盖：
  ```text
  默认风格
  群/session 绑定
  用户绑定
  用户绑定优先于 session 绑定
  无配置 fallback
  无效 styleKey fallback
  style block 注入顺序
  ```

## 后续扩展

- [ ] v2：QQ 命令管理风格  
  例如：
  ```text
  #agent style list
  #agent style show
  #agent style use casual_group_friend
  ```

- [ ] v3：场景自动风格  
  例如：
  ```text
  技术问题 -> 结构化风格
  情绪消息 -> 温和陪聊风格
  闲聊 -> 群友自然风格
  ```
