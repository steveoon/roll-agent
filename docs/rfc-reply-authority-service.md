# RFC: Reply Authority Service — 回复签发与验签服务

> Status: Draft
> Date: 2026-04-10
> Authors: @steveoon, Claude, Codex

## 1. 背景与动机

### 1.1 问题

顶层编排 Agent（OpenClaw）在使用 roll-core 协调子 agent 时，有时会跳过 `smart-reply-agent.generate_reply`，自己编造消息直接调用 `browser-use-agent.zhipin_send_reply` 发送给真实求职者（Boss 直聘平台）。

这是一个高风险操作 — 未经 reply-policy、FactGate、ReplyGate、年龄合规检查的消息可能对候选人产生不当影响。

### 1.2 已排除的本地方案

| 方案 | 失败原因 |
|------|----------|
| 本地 HMAC（shared secret） | OpenClaw 有文件系统访问权限，可读 `~/.zshrc` / `roll.config.yaml` 获取 secret 自行计算 token |
| 本地共享存储（replyId） | OpenClaw 可向存储目录写入自伪造的文件 |
| 进程级临时密钥 | smart-reply（stdio, on-demand）与 browser-use（streamable-http, 长驻）生命周期不同，无法在同一进程内共享 secret |
| roll-core pipeline 内存密钥 | roll-core 是无状态 CLI，每次 `roll ask` / `roll run` 是独立进程，无法充当持久信任锚 |

### 1.3 核心结论

**在同一台机器上，无法对拥有完整本地访问权限的 LLM agent 建立真正的安全边界。** 信任锚点必须移到 OpenClaw 的可达范围之外 — 即云端。

## 2. 方案概述

### 2.1 架构：外部签发 + 本地验签（非对称加密）

```
┌─────────────────────┐
│   Reply Authority    │  ← 云端服务，持有 Ed25519 私钥
│   Service (云端)     │
└──────────┬──────────┘
           │
    ① POST /generate-signed-reply
    (candidateMessage, history, candidateInfo, target)
           │
           ▼
    ② 执行 smart-reply 管线
    ③ Ed25519.sign(payload, privateKey)
    ④ 返回 { suggestedReply, signedEnvelope }
           │
           ▼
┌──────────────────────┐     ┌─────────────────────┐
│  smart-reply-agent   │     │  browser-use-agent   │
│  (薄代理，转发请求)   │     │  (持有公钥，本地验签) │
└──────────────────────┘     └──────────┬──────────┘
                                        │
                              ⑤ Ed25519.verify(payload, publicKey)
                              ⑥ 校验 target 与当前会话一致
                              ⑦ 校验 jti 未使用 + exp 未过期
                              ⑧ 从 payload 提取 reply，发送
```

### 2.2 为什么非对称加密解决了问题

- **私钥只在云端**：永不离开服务器，OpenClaw 无法触达
- **公钥可公开**：即使 OpenClaw 读到公钥，也无法伪造签名
- **本地验签**：browser-use-agent 无需每次发送都调云端，离线即可验证

## 3. Signed Envelope 设计

### 3.1 Payload 结构（签名覆盖的完整数据）

```typescript
interface EnvelopePayload {
  /** schema 版本 */
  v: 1;
  /** 密钥标识，支持密钥轮换 */
  kid: string;
  /** 一次性标识（UUID/ULID），防重放 */
  jti: string;
  /** 签发时间（Unix seconds） */
  iat: number;
  /** 过期时间（Unix seconds），建议 iat + 300 */
  exp: number;
  /** 授权目标 tool */
  aud: "browser-use-agent/zhipin_send_reply";
  /** 目标平台 */
  platform: "zhipin";
  /** 租户标识 */
  tenantId: string;
  /** 候选人会话标识（绑定发送目标，防跨候选人复用） */
  conversationId: string;
  /** 候选人标识 */
  candidateId: string;
  /** 实际发送文本 */
  reply: string;
  /** 生成时使用的 reply-policy 版本 */
  policyVersion: string;
}
```

### 3.2 Envelope 传输结构

```typescript
interface SignedEnvelope {
  /** JSON.stringify(EnvelopePayload) */
  payload: string;
  /** Ed25519 签名（base64url 编码） */
  signature: string;
}
```

### 3.3 设计决策

| 决策 | 理由 |
|------|------|
| `reply` 在 payload 内部 | 调用方无法替换消息内容，browser-use 从验签后的 payload 提取 |
| 绑定 `conversationId` + `candidateId` | 防止 A 候选人的签名回复被转发给 B 候选人（Codex 发现的关键漏洞） |
| `kid` 字段 | 支持密钥轮换，browser-use 按 kid 选择对应公钥 |
| `jti` 一次性消费 | TTL 只防过期，jti 防窗口内重放 |
| `iat` + `exp` 替代单一 `timestamp` | 语义更清晰，支持 clock skew 容忍（建议 30-60s） |
| `policyVersion` | 审计用，追溯消息生成时使用的策略版本 |

## 4. API 设计

### 4.1 POST /generate-signed-reply

生成回复并签名，原子操作。**不暴露单独的 /sign 接口。**

**Request:**

```typescript
interface GenerateSignedReplyRequest {
  /** 候选人消息 */
  candidateMessage: string;
  /** 对话历史 */
  conversationHistory?: string[];
  /** 候选人信息 */
  candidateInfo?: {
    name?: string;
    age?: number;
    city?: string;
    [key: string]: unknown;
  };
  /** 发送目标（绑定到签名） */
  target: {
    platform: "zhipin";
    tenantId: string;
    conversationId: string;
    candidateId: string;
  };
}
```

**Response:**

```typescript
interface GenerateSignedReplyResponse {
  /** 生成的回复文本（供展示/日志） */
  suggestedReply: string;
  /** 签名信封（base64url 编码的 JSON） */
  signedEnvelope: string;
  /** 置信度 */
  confidence: number;
  /** 使用的策略来源 */
  replyPolicySource: "file" | "default";
  /** 诊断信息（可选） */
  diagnostics?: Record<string, unknown>;
}
```

### 4.2 POST /verify-reply（可选，供调试/审计）

```typescript
// Request
interface VerifyReplyRequest {
  signedEnvelope: string;
}

// Response
interface VerifyReplyResponse {
  valid: boolean;
  payload?: EnvelopePayload;
  error?: string;
}
```

### 4.3 GET /health

标准健康检查。

### 4.4 GET /.well-known/reply-authority-keys

公钥分发端点。browser-use-agent 可从此获取公钥（替代 env 注入，更安全）。

```typescript
interface PublicKeyResponse {
  keys: Array<{
    kid: string;
    algorithm: "Ed25519";
    publicKey: string;  // base64url 编码
    validFrom: string;  // ISO 8601
    validUntil?: string;
  }>;
}
```

## 5. browser-use-agent 验签流程

```
zhipin_send_reply(signedEnvelope, candidateName?, index?)
│
├─ 1. 解析 signedEnvelope → { payload, signature }
├─ 2. 解析 payload → EnvelopePayload
├─ 3. 按 kid 选择对应公钥
├─ 4. Ed25519.verify(payload, signature, publicKey)
│     └─ 失败 → { success: false, error: "签名验证失败" }
├─ 5. 校验 aud === "browser-use-agent/zhipin_send_reply"
├─ 6. 校验 platform === "zhipin"
├─ 7. 校验 exp > now - clockSkew && iat < now + clockSkew
│     └─ 失败 → { success: false, error: "签名已过期" }
├─ 8. 校验 jti 未使用（本地内存 Set + 定期清理过期 jti）
│     └─ 已使用 → { success: false, error: "token 已消费，禁止重放" }
├─ 9. 导航到目标候选人聊天窗口
├─ 10. 读取当前会话的真实 conversationId / candidateId
├─ 11. 与 payload 中的 target 比对
│      └─ 不一致 → { success: false, error: "发送目标与签名不匹配" }
├─ 12. 从 payload 提取 reply，执行发送
└─ 13. 记录 jti 为已消费
```

## 6. 密钥管理

### 6.1 密钥生成

```bash
# 生成 Ed25519 密钥对
openssl genpkey -algorithm Ed25519 -out reply-authority-private.pem
openssl pkey -in reply-authority-private.pem -pubout -out reply-authority-public.pem
```

### 6.2 密钥分发

| 密钥 | 存储位置 | 访问方式 |
|------|----------|----------|
| 私钥 | 云端服务容器内 / K8s Secret | 环境变量或文件挂载 |
| 公钥 | `/.well-known/reply-authority-keys` 端点 | browser-use-agent 启动时拉取 |

### 6.3 密钥轮换

1. 生成新密钥对，分配新 `kid`
2. 云端服务开始用新私钥签名，`kid` 字段更新
3. 公钥端点同时返回新旧两个公钥
4. browser-use-agent 按 `kid` 选择验证公钥
5. 旧密钥过渡期结束后从端点移除

## 7. 对现有系统的改动

### 7.1 smart-reply-agent

**从完整 agent 变为薄代理：**
- `generate_reply` 内部转发请求到 Reply Authority Service
- 输出 schema 新增 `signedEnvelope: string`
- 回复生成逻辑（reply-policy、FactGate、ReplyGate、age gate）迁移到云端服务

### 7.2 browser-use-agent

- `zhipin_send_reply` input schema：删除 `message`，新增 `signedEnvelope: string`（required）
- 新增验签逻辑（Ed25519 + jti + target 比对）
- 启动时从 `/.well-known/reply-authority-keys` 拉取公钥

### 7.3 roll.config.yaml

```yaml
agents:
  env:
    browser-use-agent:
      REPLY_AUTHORITY_KEYS_URL: "https://reply-authority.duliday.com/.well-known/reply-authority-keys"
    smart-reply-agent:
      REPLY_AUTHORITY_URL: "https://reply-authority.duliday.com"
```

### 7.4 SKILL.md 更新

- 两个 agent 的 SKILL.md 写明 `zhipin_send_reply` 只接受 signedEnvelope
- 明确调用流程：`generate_reply` → 拿到 `signedEnvelope` → 传给 `zhipin_send_reply`

## 8. 新项目结构

```
reply-authority-service/
├── src/
│   ├── app.ts                    # Fastify 应用入口
│   ├── server.ts                 # 服务启动
│   ├── routes/
│   │   ├── generate-reply.ts     # POST /generate-signed-reply
│   │   ├── verify-reply.ts       # POST /verify-reply
│   │   ├── health.ts             # GET /health
│   │   └── public-keys.ts        # GET /.well-known/reply-authority-keys
│   ├── services/
│   │   ├── reply-generator.ts    # 回复生成管线（从 smart-reply 迁移）
│   │   ├── envelope-signer.ts    # Ed25519 签名
│   │   └── key-manager.ts        # 密钥加载与轮换
│   ├── schemas/
│   │   ├── envelope.ts           # EnvelopePayload / SignedEnvelope Zod schema
│   │   └── api.ts                # 请求/响应 Zod schema
│   └── config/
│       └── index.ts              # 配置加载
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── .env.example
```

## 9. 技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 运行时 | Node.js ≥22.6 | 与 nano-agent 生态一致 |
| 框架 | Fastify | 高性能，TypeScript 友好，schema validation 内建 |
| 签名 | Node.js `crypto` (Ed25519) | 标准库，零依赖 |
| Schema | Zod | 与 nano-agent 生态一致，单一数据源 |
| 部署 | Docker + K8s | 用户已有 k8s.duliday.com 基础设施 |
| LLM | AI SDK v6 | 与 smart-reply 管线一致 |

## 10. 部署

### 10.1 Docker

```dockerfile
FROM node:22-alpine
# ... 标准 multi-stage build
```

### 10.2 环境变量

```
REPLY_AUTHORITY_PRIVATE_KEY=<Ed25519 私钥 PEM>
REPLY_AUTHORITY_KEY_ID=reply-signing-key-2026-04
DASHSCOPE_API_KEY=<通义千问 API Key>
ANTHROPIC_API_KEY=<Anthropic API Key>
PORT=3100
```

### 10.3 K8s 部署

- Deployment + Service
- 私钥通过 K8s Secret 挂载
- 健康检查指向 `/health`

## 11. 实施阶段

### Phase 1：基础服务（本次）
- [ ] 新项目初始化（Fastify + TypeScript + Docker）
- [ ] Ed25519 密钥生成与管理模块
- [ ] `/generate-signed-reply` 端点（先用简化的回复生成逻辑）
- [ ] `/.well-known/reply-authority-keys` 公钥分发
- [ ] `/health` 健康检查
- [ ] Docker 部署配置

### Phase 2：管线迁移
- [ ] 从 smart-reply-agent 迁移回复生成管线（classification, context, generation, gates）
- [ ] reply-policy / brand-config 配置加载
- [ ] Duliday API 集成
- [ ] smart-reply-agent 改为薄代理

### Phase 3：验签集成
- [ ] browser-use-agent 实现验签逻辑
- [ ] jti 消费跟踪
- [ ] target 绑定校验
- [ ] `zhipin_send_reply` schema 变更（删 message，加 signedEnvelope）

### Phase 4：生产化
- [ ] 密钥轮换机制
- [ ] 审计日志
- [ ] 监控与告警
- [ ] 压力测试
- [ ] SKILL.md 更新

## 12. 安全审计清单

- [ ] 私钥永不离开云端容器
- [ ] 不暴露 `/sign` 接口（生成+签名原子化）
- [ ] browser-use-agent 删除所有裸文本发送旁路
- [ ] envelope 绑定 conversationId + candidateId
- [ ] jti 一次性消费（防重放）
- [ ] exp + iat + clock skew 容忍
- [ ] 公钥通过 HTTPS 端点分发（非本地文件）
- [ ] kid 支持密钥轮换
