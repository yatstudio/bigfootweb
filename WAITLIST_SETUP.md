# Bigfoot Waitlist — 最简 TXT 文件方案

当前预约系统使用一个极小的 Node 服务，不再依赖 Google Sheet、Cloudflare KV 或数据库。

## 文件

- 主页预约表单：`/zh.html`、`/index.html`
- 单独预约页：`/beta.html`
- 隐藏查看页：`/_bf8848.html`
- 后端服务：`/server.mjs`
- 数据文件：`/data/waitlist.txt`，线上建议放到持久化目录 `/data/waitlist.txt`

## 工作方式

1. 用户在官网提交 email。
2. 前端 POST 到 `/api/waitlist`。
3. `server.mjs` 将每条预约追加为一行 JSON，写入 `waitlist.txt`。
4. 你打开 `/_bf8848.html`，输入查看密码，即可读取 TXT 并展示表格。

每行格式类似：

```json
{"createdAt":"2026-06-06T03:08:49.054Z","email":"user@example.com","platform":"Mac","source":"zh-home","ip":"127.0.0.1","userAgent":"..."}
```

## 本地运行

```bash
cd /Users/yat/bigfoot-capital-site
WAITLIST_ADMIN_PASSWORD='你的查看密码' npm start
```

默认访问：

- 主页：`http://127.0.0.1:8765/`
- 查看页：`http://127.0.0.1:8765/_bf8848.html`

## 线上部署建议

这个方案需要“可运行 Node 服务 + 持久化磁盘”。不能只部署到纯静态 Cloudflare Pages，因为纯静态环境不能写本地 TXT 文件。

推荐最省事部署：Zeabur / Render / Railway / VPS 任一即可。

### Zeabur 推荐配置

- Start Command: `npm start`
- Environment Variables:
  - `WAITLIST_ADMIN_PASSWORD=你的查看密码`
  - `WAITLIST_DATA_DIR=/data`
  - `HOST=0.0.0.0`
- Volume:
  - 挂载路径：`/data`

这样预约会写到：

```text
/data/waitlist.txt
```

注意：如果不挂载 Volume，服务重启或重新部署后 TXT 可能丢失。

## 安全边界

这是低成本轻量方案，适合当前少量内测用户：

- 查看页有服务端密码校验；
- 密码不要写在前端源码里，应放环境变量；
- TXT 文件目录 `data/` 已加入 `.gitignore`，不会提交到 Git；
- 后续用户量变大，再迁移到 SQLite/PostgreSQL/Airtable 都容易。
