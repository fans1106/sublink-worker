# AGENTS.md

## 协作偏好

- 用中文回复；代码注释用英文，注释写 why 不写 how。
- 简洁直接，不要多余总结和解释；除非存在高风险或信息缺口，直接写代码。
- 函数式优先，TS/JS 中避免 OOP；新功能优先复用或重构现有代码。
- 遵循 KISS、DRY 原则；从第一性原理解构问题，警惕 XY 问题。
- 发现不合理的需求或方向要立即指出，不奉承。

## 项目概览

Sublink Worker 是多平台代理订阅转换器：将各类协议（ShadowSocks/VMess/VLESS/Hysteria2/Trojan/TUIC）转为客户端配置（Sing-Box/Clash/Xray/Surge）。同一份代码跑在 Cloudflare Workers / Node.js / Vercel / Docker 上。技术栈：Hono（Web/JSX SSR）+ Vitest + Wrangler + esbuild + ioredis。

## 常用命令

- `npm run dev` — Wrangler 本地开发（Cloudflare Workers 入口）
- `npm run dev:node` — esbuild bundle + 启动 Node.js server
- `npm test` — Vitest（基于 `@cloudflare/vitest-pool-workers`，依赖 `wrangler.toml`）
- `npx vitest test/<file>.test.js` — 跑单个测试文件
- `npm run build` — Vercel 构建（输出到 `dist/vercel/`）
- `npm run deploy` — `setup-kv` + `wrangler deploy`

无 ESLint/Prettier/Biome 配置，未启用自动格式化。

## 多运行时架构

入口分平台：`src/worker.jsx`（Cloudflare）、`src/platforms/node-server.js`（Node/Docker）、`api/index.js`（Vercel）。三者都通过 `createApp(runtime)`（`src/app/createApp.jsx`）创建同一个 Hono app。

- `src/runtime/{cloudflare,node,vercel}.js` 提供平台适配
- `src/runtime/runtimeConfig.js` 规范化 KV、资源获取、日志、环境变量默认值

新增运行时：在 `src/runtime/` 加 adapter，按需在 `src/adapters/kv/` 加 KV 实现，按需在 `src/platforms/` 加入口。

## KV 存储抽象

统一接口：`get(key)`、`put(key, value, options)`、`delete(key)`。实现：`CloudflareKVAdapter`、`RedisKVAdapter`（ioredis）、`UpstashKVAdapter`（REST）、`MemoryKVAdapter`。

- 服务层：`ShortLinkService`（短链）、`ConfigStorageService`（base config 存储，默认 30 天 TTL）
- Node/Vercel 优先级：Redis > Upstash/Vercel KV > 内存兜底；`DISABLE_MEMORY_KV=true` 关闭兜底
- Cloudflare 用 `wrangler.toml` 的 `SUBLINK_KV` 与 `ASSETS` binding

环境变量：`REDIS_URL` / `REDIS_HOST`+`REDIS_PORT` / `REDIS_USERNAME` / `REDIS_PASSWORD` / `REDIS_TLS` / `REDIS_KEY_PREFIX`、`KV_REST_API_URL`+`KV_REST_API_TOKEN`、`CONFIG_TTL_SECONDS`、`SHORT_LINK_TTL_SECONDS`、`STATIC_DIR`、`PORT`。

## 协议解析与配置构建

**ProxyParser**（`src/parsers/ProxyParser.js`）按 URL scheme 分发到 `src/parsers/protocols/<protocol>Parser.js`。HTTP(S) 订阅走 `httpSubscriptionFetcher` → `subscriptionContentParser`，自动识别 Sing-Box JSON / Clash YAML / Surge INI / Base64 列表。

返回值约定：
- 协议 parser：`{ tag, type, ...protocolFields }`
- 订阅级 parser：`{ type: 'yamlConfig'|'singboxConfig'|'surgeConfig', config: null, proxies }`，只提取节点。

**新增协议**：在 `src/parsers/protocols/` 加 parser，并在 `ProxyParser.js` 的 `protocolParsers` map 注册。

**Builder 模式**：`SingboxConfigBuilder` / `ClashConfigBuilder` / `SurgeConfigBuilder` 都继承 `BaseConfigBuilder`。子类必须实现：`getProxies()`、`getProxyName(proxy)`、`convertProxy(proxy)`、`addProxyToConfig(proxy)`、`addSelectorGroup(name, members, type, providers)`、`addOutboundGroups(outbounds)`、`addCustomRuleGroups()`、`addFallBackGroup()`、`addCountryGroups()`、`formatConfig()`。总选择、普通选择、来源分组与链式分组的成员逻辑由基类和 `helpers/groupBuilder.js` 统一计算。

**订阅导入**：订阅与粘贴的完整配置只贡献节点，原分组、DNS、规则等不合并到 base config；内置模板或用户选择的 base config 提供这些设置。Clash / Sing-Box / Surge 按完整订阅 URL 建立来源选择组，同域名不同 URL 用数字后缀区分；手动 URI 和粘贴配置分别归组。来源组与国家分组并存，provider 来源组只引用自身 provider。

**分组层级**：节点选择 → 普通代理 / 链式代理。普通代理包含普通自动选择、全部节点、来源与可选国家组；业务/自定义规则组保留来源候选，不展开原始节点或国家组。开启链式代理时总选择默认走链式；每个落地提供自动入口（完整链路测速、固定落地）或入口选择选项（带落地后缀、共享入口选择、仅 IN 节点）。关闭自动选择时不生成测速组或链式测速副本，国家组改为手动选择。原始 OUT 节点可在普通代理中单跳使用。

**基础配置覆写**：`configId` 是对应版本默认模板上的合并覆写，与订阅仅节点导入分离。普通对象递归合并，标量和普通数组替换；命名列表按 name/tag 增改，type 改变时整项替换，命名空列表不清空。节点覆写在解析后、分组前应用，分组与规则覆写在生成后应用。规则表直接提供时整体替换；`prepend-rules`/`append-rules` 增补，append 位于兜底前，Sing-Box 推荐放在 route 内。合并与引用检查见 `builders/helpers/configOverrides.js`、`configValidation.js`，formatConfig 重复调用不得重复增补。

国家分组逻辑在 `src/utils.js#groupProxiesByCountry`。

分组展示顺序：节点选择 → 普通代理 / 链式代理 → 落地 / 来源 → 入口选择 / 全部节点 → 自动选择 / 国家组 → 业务规则 / 自定义规则 / 漏网之鱼。

## 测试

Vitest + `@cloudflare/vitest-pool-workers`，配置 `vitest.config.js` 指向 `wrangler.toml`。测试文件在 `test/`。

- 写测试时用 `MemoryKVAdapter` 做 KV，用 `createApp(runtime)` 拿到可测的 Hono app
- 覆盖：路由、各 builder、各 parser（含 YAML 订阅）、country grouping、selectedRules 向后兼容

## 关键约定

- `.jsx` 文件用 Hono JSX runtime，**不是 React**
- Base64 输入用 `tryDecodeSubscriptionLines()` 处理（同时支持原文和 Base64）
- 错误用 `ServiceError` 子类（`InvalidPayloadError`、`MissingDependencyError`），返回干净响应
- i18n：zh-CN / en-US / fa-IR，文件在 `src/i18n/`

## 本地工作流

- 本地分层规划放 `.roadmap/roadmap.md`（已 `.gitignore`）；更新前先同步 GitHub open issues
- 个人偏好、沙盒、临时上下文写入 `AGENTS.local.md`（不提交）
- Claude 共享规则放 `CLAUDE.md`，个人覆盖放 `CLAUDE.local.md`

## 文档参考

代理工具配置问题查官方文档：
- sing-box: https://sing-box.sagernet.org/
- clash/mihomo: https://wiki.metacubex.one/
- surge: https://blankwonder.gitbooks.io/surge-manual/content/
- xray: https://xtls.github.io/config/
