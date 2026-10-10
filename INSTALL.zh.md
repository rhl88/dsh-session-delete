# dsh-session-delete 安装说明

DeepSeek Harness（DSH）插件：在侧边栏会话菜单里加入**删除会话**（永久移除会话记录与完整历史，补足只能归档的限制）。

## 安装

```pwsh
# ① 从 GitHub 仓库安装（推荐；插件目录里展示的就是这条）
dsh plugin add github:rhl88/dsh-session-delete

# ② 从本地目录 / 预构建 tarball 安装
dsh plugin add D:\path\to\dsh-session-delete
dsh plugin add D:\path\to\local-dsh-session-delete-1.0.0.tgz

# ③ 等价的手工方式（在 profile 目录里）
cd C:\Users\Administrator\.dsh\profiles\desktop
pnpm add github:rhl88/dsh-session-delete
# 再把该目录 package.json 的 dsh.profile.bundles 设为：
#   ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/dsh-session-delete"]

# 装完重启 DeepSeek Harness，并刷新 GUI 页面
```

`dsh plugin add` / 插件页安装会**默认启用**该 bundle，不需要再手改 `dsh.profile.bundles`；手工 `pnpm add` 才需要自己加进列表。

## 注意事项

- **只装一份。** 行 id（`session-delete`）与浏览器插槽 id 是固定的，同时选中两份安装（例如本包与 `@local/dsh-session-delete-v2`）会冲突。切换前先移除另一份：`pnpm remove @local/dsh-session-delete-v2`
- **改宿主端代码需要重启应用。** desktop 组合把 HMR 行的模块监视关掉了（`root: []`），只重载 profile 配置；且重新导入同一模块 URL 会命中 ESM 缓存。要免重启验证新版本，只能换包名或换目录（新的模块 URL）。
- 客户端一半只要浏览器模块基线（`react`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives`），宿主一半只用 node 内置模块；包内**没有声明任何依赖**，因此没有版本兼容门槛。

## 删除行为

移除：会话日志目录 `~/.dsh/sessions/<项目目录>/<会话id>/`、投影缓存 `~/.dsh/storages/session_projcache/sessions/<会话id>.json`，并从工作区记账、置顶、归档集合中清除，随后广播 `api-session/removed`，侧边栏立即更新。

不删除（v1）：内容寻址的附件字节（跨会话共享）、子代理会话日志、全文检索索引行（下次搜索会自动对账剔除）。

安全侧设计：所有注册表调用都带超时且失败不致命——工作区操作队列卡住时仍会删除文件，并在响应里返回 `degraded` 说明；活动会话未释放句柄则返回 409 且不动文件，稍后重试即可。

## 排查日志

- `session-delete.debug.log`：宿主端逐步日志（请求、围栏、请求体、stat、定位、归档、等待释放、删除、缓存、记账、响应），另有 90 秒请求看门狗。
- `session-delete.client.log`：浏览器端进度标记（确认 → 归档 → 发起删除 → HTTP 状态）。

两个文件都在已部署的 `index.js` 同目录下，可随时删除。

## 自测

```pwsh
node test/paths.test.js         # 路径编码，与本机真实 ~/.dsh 布局比对
node test/module-load.test.js   # 宿主/客户端模块形态、仅基线依赖
node test/delete-flow.test.js   # 真实路由 + 真实磁盘夹具：普通删除、注册表卡死、
                                # 活动会话、信任围栏、未知会话、畸形请求、stat 卡死
```
