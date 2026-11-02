# Airplane Fight · 打飞机

Airplane Fight 正从练手原型推进为正式浏览器游戏。产品目标是：**不用占用很长时间，容易上手，可以比较比分，轻松但有适度挑战。** 面向手机触摸和桌面浏览器；旧实现可以完整重构，不作为新玩法的强制约束。

当前代码仍是可玩的本地原型，尚未达到公开发布标准。本轮先整理文档和可评审方案，不直接实现未选定机制、不删除原型、不部署。

## 项目入口

本 README 是唯一项目总入口；[STATUS.md](STATUS.md) 是当前进展、缺陷、验证结果、阻塞、决策与发布判断的唯一状态入口。知识库概览链接到本 README，不复制另一份状态报告。

| 文档 | 用途 |
| --- | --- |
| [STATUS](STATUS.md) | 当前状态、实证缺陷、已验/未验、分阶段验收 |
| [玩法与界面方案](docs/GAME_DESIGN.md) | 默认推荐的短局休闲拼分方案；与已实现功能明确区分 |
| [运行与验证](docs/TESTING.md) | 隔离测试、命令、复测步骤和证据要求 |
| [Figma 设计交接](docs/DESIGN.md) | 视觉与界面交付要求；实际进度统一见 STATUS |

## 当前原型已实现的玩法

以下描述当前代码，不代表新版本必须保留：

- 鼠标或手指左右移动飞机，按住鼠标、触摸或空格键持续射击。
- 击落敌机得 1 分；没有护盾时撞到敌机会结束本局，可以立即重新开始。
- 敌机速度、生成频率及射速随时间提升，成群敌机概率还与得分有关。
- 每 30 秒尝试生成随机道具：双发 20 秒、三发 15 秒、四发 10 秒、护盾 5 秒。子弹或飞机接触均可领取。
- 火力道具替换当前火力；护盾期间撞敌可摧毁敌机并计分。
- CSS 爆炸动画、Web Audio 合成音效和音效开关。
- 可选排行榜保留同一推导指纹的最高分，服务端前 50 条、界面前 10 条。

| 操作 | 当前原型控制 |
| --- | --- |
| 开始/重开 | 「开始游戏」按钮 |
| 左右移动 | 游戏区域内移动鼠标或拖动手指 |
| 持续射击 | 按住鼠标、触摸或空格键 |
| 查看榜单 | 「排行榜」；当前有误结束本局缺陷，见 STATUS AF-01 |
| 返回画面 | 「返回游戏」或 Escape；不是恢复已结束的一局 |
| 音效 | 左上角音效开关 |

当前没有独立暂停按钮、自动射击、键盘左右移动、固定时长局、关卡或 Boss。新方案中的这些差异不应误读为已经实现。

## 本地运行

验证基线：Node 24.19.0、npm 11.9.0、Python 3、Chromium；不是最低版本或完整兼容性承诺。

```bash
git clone https://github.com/wivnelo/airplane-fight.git
cd airplane-fight
```

终端 A，安装并启动可选排行榜：

```bash
cd backend
npm ci
npm start
```

终端 B，从仓库根目录提供本机静态页面：

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory frontend
```

同一电脑浏览器打开 `http://127.0.0.1:8080`；两个终端各用 Ctrl+C 停止服务。前端无需构建，也可直接打开 `frontend/index.html`；本次浏览器验证使用 HTTP 静态服务。

后端未启动时仍可玩；打开排行榜可看到连接错误。当前部分道具/提交提示写入隐藏面板，因此“没有提示”不等于提交成功。

`frontend/game.js` 的 `API_BASE` 固定为 `http://localhost:3000/api`。后端 `PORT` 可配置，但不会自动改变前端地址。手机上的 localhost 指手机自身；上述回环地址仅供同一电脑开发，不是公网/手机分享方案。后端只提供 API，不托管前端；正式地址和 HTTPS 方案须在发布阶段完成。

后端会写 `backend/data/leaderboard.json`；并发/异常/写入测试按 [隔离流程](docs/TESTING.md) 执行，保护已有数据。仓库目前跟踪 `backend/node_modules`，安装后需检查工作树，不把依赖变化混入文档提交。

## 当前技术架构

| 层 | 文件/技术 | 职责 |
| --- | --- | --- |
| 页面 | `frontend/index.html` | HUD、游戏区域、开始/结束覆盖层、榜单面板 |
| 外观 | `frontend/styles.css` | CSS 飞机/子弹/道具、动画、布局 |
| 游戏 | `frontend/game.js` | 状态对象、requestAnimationFrame、输入、生成、DOM 矩形碰撞、计分和 API 调用 |
| 音效 | Web Audio | 合成命中音，无外部音频依赖 |
| API | `backend/server.js` | Express、CORS、成绩规范化和指纹推导 |
| 存储 | `backend/data/leaderboard.json` | 本地 JSON 文件，无事务/并发保护 |

前端为原生 JavaScript，无框架/构建步骤或外部图片音频包。锁定依赖基线包含 Express 4.21.2、cors 2.8.5。重构时的建议模块边界见玩法方案，尚未实施。

## API 与数据边界

| 方法 | 路径 | 当前行为 |
| --- | --- | --- |
| GET | `/health` | `{ ok: true, timestamp }`，仅验证进程响应，不检查存储 |
| GET | `/api/leaderboard` | `{ entries: [...] }`，最多 50 条 |
| POST | `/api/leaderboard` | `{ "score": 42 }`；新指纹 201、已有指纹 200，返回 entry 与榜单 |

条目字段为 id、fingerprint、displayName、score、playedAt。网络地址、User-Agent 和 Accept-Language 组合散列为指纹，不是可靠账号或设备身份。当前信任客户端分数、允许任意来源 CORS；不能用于可信竞技排名。具体实证风险见 STATUS。

## 基础检查与协作

```bash
# 仓库根目录
node --check frontend/game.js
node --check backend/server.js
node -e "for (const f of ['backend/package.json','backend/package-lock.json','backend/data/leaderboard.json']) JSON.parse(require('node:fs').readFileSync(f,'utf8')); console.log('JSON OK')"
# 后端运行时，只读检查
curl --fail http://localhost:3000/health
curl --fail http://localhost:3000/api/leaderboard
# 有告警时可能非零退出，不自动修复
npm --prefix backend audit
```

没有 npm test、build 或 lint 脚本；语法通过和 HTTP 200 不等于游戏验收。浏览器及写入验证见 TESTING。

当前授权为审阅、文档和像素 Figma 方案，并整理后续工作；具体新机制/数值尚需评审和试玩验证。本轮仅文档分支和草稿 PR，不包含业务实现、主分支合并或部署。原型数据保留，不提交密钥或无关安装产物。
