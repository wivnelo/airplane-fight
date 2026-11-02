# 运行与验证手册

[项目入口](../README.md) · [当前结果与缺陷](../STATUS.md)。本页是操作流程，不宣称所有步骤已经通过。

## 基础检查

仓库根目录，Node/npm 已安装；Python 3 用于静态服务，curl 用于 HTTP 检查：

```bash
node --version
npm --version
git status --short
node --check frontend/game.js
node --check backend/server.js
node -e "for (const f of ['backend/package.json','backend/package-lock.json','backend/data/leaderboard.json']) JSON.parse(require('node:fs').readFileSync(f,'utf8')); console.log('JSON OK')"
npm --prefix backend audit
```

审计需要网络，有告警可能非零退出；不自动运行 audit fix。项目仅 start/dev 脚本，没有 test/build/lint。正常启动见 README。

## 隔离写入与故障测试

只针对临时副本。先确认 3000/8080 端口未被需要保留的服务占用，不结束未知服务。终端 A，从仓库根目录执行：

```bash
review_dir=$(mktemp -d /tmp/airplane-fight-review.XXXXXX)
mkdir -p "$review_dir/backend/data"
cp backend/server.js backend/package.json backend/package-lock.json "$review_dir/backend/"
cp -R frontend "$review_dir/frontend"
printf '[]\n' > "$review_dir/backend/data/leaderboard.json"
npm ci --prefix "$review_dir/backend"
printf '测试副本：%s\n' "$review_dir"
PORT=3000 node "$review_dir/backend/server.js"
```

终端 B，替换为 A 输出的实际路径再执行：

```bash
review_dir=/tmp/airplane-fight-review.REPLACE_WITH_ACTUAL_SUFFIX
python3 -m http.server 8080 --bind 127.0.0.1 --directory "$review_dir/frontend"
```

浏览器打开 `http://127.0.0.1:8080`。端口 3000 对应当前写死的前端 API；需改端口时只改临时副本并记录差异。第三个终端只对临时 API 做以下提交：

```bash
curl --fail http://localhost:3000/health
curl --fail http://localhost:3000/api/leaderboard
curl --fail -X POST http://localhost:3000/api/leaderboard \
  -H 'Content-Type: application/json' -H 'User-Agent: airplane-review' \
  --data '{"score":42}'
curl --fail -X POST http://localhost:3000/api/leaderboard \
  -H 'Content-Type: application/json' -H 'User-Agent: airplane-review' \
  --data '{"score":10}'
```

核对同一指纹仍为 42 分；重启临时 API 检查持久化。并发 20 请求、损坏 JSON、写入异常、伪造请求头/分数只用于临时数据，断言见 STATUS AF-02/03/04；记录请求数量、响应与最终存储。一次并发测试不等于持续负载验收。不要对真实榜单发测试 POST。

## 原型浏览器复测

| 场景 | 操作/证据 |
| --- | --- |
| 开始/移动/射击 | 点击开始，鼠标左右到边缘，按住/松开鼠标和空格，观察计分 |
| 死亡/重开 | 自然碰撞结束，再开始，核对分数/实体/道具重置 |
| 榜单 | 有敌机或子弹时开榜再返回，记录误死亡/误计分 |
| 触摸 | 触摸、横向拖动、松手、带纵向位移拖动；记录滚页/取消/射击状态 |
| 尺寸 | 飞机在右缘，600 宽缩至 320；记录位置和可见性；检查 320×568/390×844/844×390 |
| 道具 | 四类领取、生效、到期；区分自然获得和调用原有函数布置场景 |
| 网络 | API 不可达/返回错；首局提交延迟后次局结束，核对成绩与可见状态 |
| 音效 | 开关标识；听音另在有声音输出的设备确认 |
| 生命周期 | 切后台/失焦再返回，记录时间/输入；新版本依确认后的方案验收 |

新方案实现后需更新操作步骤，自动射击和新 UI 不能用原型按住射击的结果替代验证。Playwright 等自动化工具当前不是项目依赖；临时测试不宣称为已建立测试套件。没有浏览器则明确未验，不用代码推测冒充实测。

## 证据与结束

记录 commit、设备/浏览器/视口、步骤、预期/实际、是否受控场景、AF 编号。截图必须能实际交付；无法上传则保留文字复现，不能伪造附件链接。

终端 A/B 各 Ctrl+C 停止本次服务，确认测试端口关闭。保留必要证据后清理自己创建的临时目录。`git status --short`、`git diff --name-only` 应显示仅授权范围；源码、榜单和安装产物不得混入文档提交。
