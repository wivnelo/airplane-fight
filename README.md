# Airplane Fight · 打飞机

Airplane Fight 正从练手原型推进为正式浏览器游戏。产品目标是：**不用占用很长时间，容易上手，可以比较比分，轻松但有适度挑战。** 面向手机触摸和桌面浏览器；旧实现可以完整重构，不作为新玩法的强制约束。

当前是经过第一阶段稳定性修复的可试玩原型，尚未达到公开发布标准。已实现手机输入、生命周期和排行榜基础可靠性修复；自动射击、150 秒和 3 次容错仍未启用，不删除旧原型、不部署。

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
| 查看榜单 | 「排行榜」；进行中的本局暂停，关闭后点击「继续游戏」 |
| 返回画面 | 「返回游戏」或 Escape；已结束的一局不能恢复 |
| 音效 | 左上角音效开关 |

开榜、切后台/失焦或过长卡帧会暂停计时和输入，返回后主动继续。当前没有独立暂停按钮、自动射击、键盘左右移动、固定时长局、关卡或 Boss。新方案中的这些差异不应误读为已经实现。

## 本地运行

验证基线：Node 24.19.0、npm 11.9.0、Python 3、Chromium；不是最低版本或完整兼容性承诺。

```bash
git clone https://github.com/wivnelo/airplane-fight.git
cd airplane-fight
```

安装并启动同源游戏页面和排行榜（要求 Node 24+，使用内置 SQLite）：

```bash
cd backend
npm ci
npm start
```

在同一电脑打开 `http://127.0.0.1:3000`，Ctrl+C 停止服务。前端无需构建。默认监听回环地址；`HOST`、`PORT` 可覆盖，但本次不提供公开部署配置。前端 HTTP 模式请求同源 `/api`，不再把其他设备的 localhost 当服务器。

前端也可直接打开 `frontend/index.html`，或用静态服务器提供页面；此方式用于离线体验，排行榜需要同源 API 或反向代理。file 模式的回环 API 会被默认来源策略拒绝，不建议将 `null` 来源加入允许列表。

排行榜不可用时仍可玩，本局无有效对局凭证则不提交。已取得凭证的待提交成绩保存在当前浏览器，失败可重试；清除浏览器数据、禁用存储或超过凭证有效期仍可能无法恢复。网络/浏览器特征变化也可能使凭证失效，界面会显示未同步/拒绝原因类别。

后端首次启动从 `backend/data/leaderboard.json` **只读导入一次**，写入新的 `leaderboard.sqlite`；历史 JSON 不修改。原始 9 条成绩已在隔离副本验证导入。`DATA_DIR` 可指定独立数据目录；所有写入/故障测试使用临时目录，见 [测试手册](docs/TESTING.md)。数据库及 WAL 文件不入库。

默认只允许同源浏览器 API 请求；开发时可用 `ALLOWED_ORIGINS` 设置精确、逗号分隔的来源列表。服务器不信任转发 IP 请求头；反向代理、TLS 终止、共享网络身份和多实例限流必须在部署前单独配置/验收。

## 当前技术架构

| 层 | 文件/技术 | 职责 |
| --- | --- | --- |
| 页面 | `frontend/index.html` | HUD、游戏区域、开始/结束覆盖层、榜单面板 |
| 外观 | `frontend/styles.css` | CSS 飞机/子弹/道具、动画、布局 |
| 游戏 | `frontend/game.js` | 状态对象、可暂停的有效游戏时间、Pointer Events、分步碰撞、计分 |
| 音效 | Web Audio | 合成命中音，无外部音频依赖 |
| 成绩同步 | `frontend/scores.js` | 逐局凭证、提交队列、本地保存、超时与重试 |
| API | `backend/server.js` | Express、同源静态页面、来源与请求频率限制、严格分数/时长校验 |
| 存储 | `backend/store.js` / SQLite | 事务、最高分、幂等提交、只读历史导入、失败回滚 |
| 历史 | `backend/data/leaderboard.json` | 保留的旧榜单源文件，不再直接写入 |

前端为原生 JavaScript，无框架/构建步骤或外部图片音频包。锁定依赖基线包含 Express 4.21.2、cors 2.8.5。重构时的建议模块边界见玩法方案，尚未实施。

## API 与防作弊边界

| 方法 | 路径 | 当前行为 |
| --- | --- | --- |
| GET | `/health` | 进程及数据库可读取时 200；不可用时 503，不伪装空榜 |
| GET | `/api/leaderboard` | `{ entries: [...] }`，最多 50 条；数据库保留更多历史条目 |
| POST | `/api/runs` | 开始本局，返回 runId、随机 token、ruleset、expiresAt |
| POST | `/api/leaderboard` | 提交 `{ runId, token, score, durationMs }`；首次 201，同内容重试 200，已用凭证改分 409 |

score/durationMs 必须为非负安全整数；没有凭证的旧版直接报分请求不再接受。凭证绑定服务端推导的网络/浏览器特征，保留 7 天。令牌仅存散列到数据库；客户端为重试暂存凭证，避免共享浏览器数据或在日志中输出它。

已限制来源、8KB JSON 请求体、每 IP 每分钟 120 次写请求，并拦截明显超出当前生成规则或服务端对局时间的成绩。时间检查为异步开局请求保留 5 秒裕量，敌机上限按现有每批最多 3 架、生成间隔最小 150ms 推导。原规则版本为 `prototype-v1`，没有引入新局长或生命规则。

**这是基础滥用防护，不是完整防作弊。** 客户端仍可伪造合理范围内的分数，修改 UA 等仍可能改变推导身份；没有服务端回放/权威模拟，也不是竞技榜。不能用有效凭证、限流或提交成功证明真实游戏过程。原有历史成绩没有追溯验证，保留在娱乐榜中。

## 基础检查与协作

```bash
# 仓库根目录
node --check frontend/game.js
node --check backend/server.js
node --check backend/store.js
node --check frontend/scores.js
node -e "for (const f of ['backend/package.json','backend/package-lock.json','backend/data/leaderboard.json']) JSON.parse(require('node:fs').readFileSync(f,'utf8')); console.log('JSON OK')"
# 后端运行时，只读检查
curl --fail http://localhost:3000/health
curl --fail http://localhost:3000/api/leaderboard
# 有告警时可能非零退出，不自动修复
npm --prefix backend audit
```

```bash
npm --prefix backend test
# 需 Python playwright 包及 Chromium；自动启动临时服务/数据库并清理
python3 tests/browser_smoke.py
```

已有 Node 回归测试与 Chromium 流程检查，没有 build/lint 脚本。浏览器检查含受控场景，真机和真实扬声器仍需单独验证。语法通过和 HTTP 200 不等于完整游戏验收。

当前授权包括第一阶段稳定性、手机操作及后续排行榜可靠性/基础防作弊开发；具体新机制/数值仍需评审。Figma 继续暂停，不付费升级、不制作替代设计。实现采用独立分支/草稿 PR，不合并、不公开部署；旧原型与历史榜单保留。
