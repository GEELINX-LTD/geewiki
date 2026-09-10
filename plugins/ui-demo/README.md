# ui-demo —— 插件自带前端 UI 的示例插件

**这不是内置产品功能**，默认**不启用**。它只用来演示「插件自带前端 UI 产物」这条链路，
以及宿主侧插槽机制的端到端效果。

## 为什么它单独存在

以前这份演示界面（计数器 + 抛错按钮）由 `packages/web/fixtures/` 构建到
`packages/web/public/plugins-ui/@geewiki/wiki/`，也就是**挂在 `@geewiki/wiki` 名下**。
而 `@geewiki/wiki` 是基础层默认激活的插件，于是：**测试脚手架冒充成 wiki 插件的界面贡献**，
在产品页头出现一个 `+1` 按钮、页脚出现一个「触发错误」按钮。

现在：

- `@geewiki/wiki` 不再声明 `geewiki.client`（它确实没有前端界面）；
- 演示界面搬到本插件名下，产物落在**本目录的 `dist/`**（插件自带产物根）。

## 结构

```
plugins/ui-demo/
├── package.json      # 清单在顶层 geewiki 键：provides / requires / entry / client
├── src/index.ts      # 后端入口：注册 GET /api/ui-demo
├── dist/             # 前端产物（生成物，不随仓库提交；由 build:fixtures 产出）
│   ├── client.js
│   └── client.css
└── README.md
```

前端源码仍在 `packages/web/fixtures/src/`（宿主仓库里集中维护一份演示源码），
由 `packages/web/fixtures/vite.config.ts` 构建到本目录。

## 构建

```bash
pnpm --filter @geewiki/web build:fixtures
```

## 启用（看演示）

默认不在 `config/plugins.base.json` 里，所以启动后是**已注册未启用**。
在管理台 `#/plugins` 点「启用」，或：

```bash
# 插件名含 `/`，REST 路径里必须 URL 编码
curl -X POST 'http://127.0.0.1:3000/api/plugins/%40geewiki-plugin%2Fui-demo/enable' \
  -H 'content-type: application/json' -d '{}'
curl http://127.0.0.1:3000/api/ui-demo        # 后端端点
```

启用后页头插槽会出现计数器、页脚插槽会出现错误边界演示件；停用后它们自动消失
（入口表按活状态派生，UI 生命周期跟随插件）。
