# CloudflareSub

一个基于 **Cloudflare Workers**
的轻量级订阅生成工具，用于整理节点链接并生成多种客户端可用的订阅格式。

该项目适合个人部署、自用或学习 Cloudflare Workers 的基本开发方式。

------------------------------------------------------------------------

# 功能

-   支持输入多个节点链接
-   支持批量替换服务器地址为指定 IP 或域名
-   自动生成多个客户端订阅格式
-   支持二维码生成，方便移动端导入
-   支持基础去重处理
-   支持自定义 token 过期时间
-   支持自定义导入到客户端的订阅名称
-   支持管理页登录保护，默认密码为 `admin`
-   内置一组默认 Cloudflare 优选 IP，页面里可以直接删除或修改
-   支持 Cloudflare Workers 一键部署

当前支持的订阅格式：

-   原始节点订阅
-   Clash 订阅
-   Surge 订阅

------------------------------------------------------------------------

# 新增配置

-   登录密码：默认是 `admin`，也可以在 Workers 变量里设置 `ADMIN_PASSWORD` 覆盖。
-   Token 过期时间：在页面中填写天数，生成后会作为 KV 记录的有效期。
-   客户端导入名称：在页面中填写，生成的订阅响应会带上对应标题，同时节点名称也会使用该名称。
-   优选 IP：页面默认预填项目内置列表，仍然支持手动增删改。

------------------------------------------------------------------------

# 部署方式

以下方式适合在本地使用 Wrangler 部署到 Cloudflare Workers。

## 1. 准备环境

-   安装 Node.js 18 或更高版本
-   准备一个 Cloudflare 账号
-   确认当前目录已经是本项目代码目录

安装依赖：

```bash
npm install
```

登录 Cloudflare：

```bash
npx wrangler login
```

## 2. 创建 KV 存储

本项目需要一个 KV 命名空间保存短链接、订阅内容和登录会话：

```bash
npx wrangler kv namespace create SUB_STORE
```

命令会输出一段类似下面的配置：

```toml
[[kv_namespaces]]
binding = "SUB_STORE"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

把输出内容复制到 `wrangler.toml` 末尾。

## 3. 配置密钥

设置订阅访问 token，生成的订阅链接会自动带上这个 token：

```bash
npx wrangler secret put SUB_ACCESS_TOKEN
```

设置后台登录密码。默认密码是 `admin`，建议部署时改成自己的密码：

```bash
npx wrangler secret put ADMIN_PASSWORD
```

## 4. 本地检查

运行基础测试：

```bash
npm run check
```

需要本地预览时可以运行：

```bash
npm run dev
```

## 5. 部署

```bash
npm run deploy
```

部署完成后，Wrangler 会输出访问地址。打开地址后先登录后台，再粘贴节点链接并生成订阅。

## 6. 使用说明

-   登录密码默认是 `admin`，如果设置了 `ADMIN_PASSWORD`，以你设置的值为准。
-   Token 过期时间在页面里填写，生成后会作为 KV 记录有效期。
-   客户端导入名称会写入订阅响应标题，也会用于生成节点名称。
-   优选 IP 列表默认已预填，可以直接删除、追加或替换。

视频教程：
https://youtu.be/E5PI0LsQ43M
------------------------------------------------------------------------

# License

MIT License
