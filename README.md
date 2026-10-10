# Airplane Fight · 打飞机小游戏

基于 HTML、CSS 和原生 JavaScript 的竖屏射击小游戏，支持鼠标、触摸与空格键射击，配有火力道具、护盾、合成音效和可选的本地排行榜服务。

> **当前已知问题：**`frontend/game.js` 文件末尾混入了一条非 JavaScript 的 SQL 文本，会触发语法错误，导致整个游戏脚本无法加载。运行前需修正该处。本文描述代码中的玩法与启动方式，当前提交不能直接开箱游玩。

## 玩法与功能

- 鼠标或触摸左右移动飞机，按住鼠标、触摸或空格键持续射击。
- 击落敌机得分，没有护盾时撞到敌机会结束游戏。
- 难度随时间提高，敌机速度和生成频率逐步上升。
- 每 30 秒随机生成道具：双发、三发、四发或护盾。
- 火力道具分别持续 20 / 15 / 10 秒，护盾持续 5 秒。
- 命中时播放合成音效与爆炸动画，可关闭音效。
- 可选排行榜，记录同一浏览器与网络组合的最高成绩。

## 获取源码

```bash
git clone https://github.com/wivnelo/airplane-fight.git
cd airplane-fight
```

先修正上述脚本语法问题，再进行以下操作。

## 仅体验游戏

用现代浏览器打开 `frontend/index.html`，点击「开始游戏」。前端无需构建，也不依赖排行榜服务才能进行游戏。

后端未启动时，排行榜加载和成绩提交会失败，界面会显示连接提示。

| 操作 | 控制方式 |
| --- | --- |
| 左右移动 | 鼠标移动或手指拖动 |
| 持续射击 | 按住鼠标、触摸或空格键 |
| 查看成绩 | 点击「排行榜」 |
| 返回游戏 | 点击「返回游戏」或按 Escape 关闭排行榜 |
| 切换音效 | 点击「音效」 |

## 启动排行榜服务

需要 Node.js 和 npm。后端使用 Express 与本地 JSON 文件。

```bash
cd backend
npm ci
npm start
```

默认 API 地址为 `http://localhost:3000`，可访问 `http://localhost:3000/health` 检查服务。

前端在 `frontend/game.js` 顶部通过 `API_BASE` 配置地址，默认值为 `http://localhost:3000/api`。修改后端端口时，也需要同步修改前端地址。

手机访问电脑提供的前端页面时，`localhost` 指手机自身；要使用电脑上的排行榜，需将 `API_BASE` 改为手机可访问的电脑地址，并确保网络可达。后端只提供 API，不托管前端页面。

## 排行榜 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | 返回服务状态与时间 |
| GET | `/api/leaderboard` | 返回最高 50 条成绩，响应为 `{ entries: [...] }` |
| POST | `/api/leaderboard` | 提交 `{ "score": 42 }`，保留同一指纹的最高分 |

数据保存在 `backend/data/leaderboard.json`，前端只显示前 10 条。

服务端将 IP、User-Agent 和 Accept-Language 组合后计算 SHA-256 摘要，生成指纹及「飞行员」昵称。这是网络和浏览器特征推导的标识，**不是可靠的设备身份**；换网络或浏览器可能产生新标识。

## 项目结构

```text
frontend/
  index.html       页面结构
  styles.css       游戏样式
  game.js          游戏逻辑、音效与 API 调用
backend/
  package.json     后端依赖与启动命令
  server.js        排行榜 API
  data/
    leaderboard.json
```

## 当前边界

- 排行榜接受客户端上报分数，没有账号认证或服务端反作弊。
- JSON 文件存储没有并发写入保护，适合本地演示。
- 服务端允许任意来源的跨域请求；公开部署前需要单独评估访问控制和数据处理。
- HTTPS 页面不能直接请求普通 HTTP 排行榜服务。
- 仓库目前没有自动化测试脚本，浏览器兼容性与手机体验需要实际验证。

发现问题可通过 [Issues](https://github.com/wivnelo/airplane-fight/issues) 反馈，附上浏览器、设备和复现步骤。
