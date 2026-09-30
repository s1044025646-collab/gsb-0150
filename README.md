# 离散控制回路响应与 PID 参数评估后端

面向**一阶惯性 + 整数采样延迟**对象的本地评估后端。只提供 API、CLI、虚构对象/扰动夹具和自动化测试；
**不包含**网页界面、数字门电路仿真，也不连接任何真实设备。

- 语言/运行时：TypeScript（编译到 `dist/`）、Node.js（建议 ≥ 22.5，开发环境为 Node 25）
- 存储：内置 `node:sqlite`（`DatabaseSync`），零第三方原生依赖
- 网络：仅绑定 `127.0.0.1`，默认端口 `0`（操作系统自动分配空闲端口）
- 所有数据库与临时文件都在本项目目录内（`data/`、`.local/`）

## 模型与采样时序（同一拍的严格顺序）

对象（零阶保持离散递推）：

```
tau*dy/dt = -y + K*u(t-d) + load
a = exp(-Ts/tau), b = 1-a
y[k+1] = a*y[k] + b*(K*uDelayed[k] + load[k])
```

延迟 `d = delaySamples` 为执行器通道上的**整数拍数**：

- `d = 0`：本拍算出的 `u[k]` **当拍**作用于对象；
- `d = 1`：`u[k]` 到下一拍才作用，延迟线初始值为初始稳态执行量。

每个采样拍按以下固定顺序执行（见 `src/core/engine.ts`）：

1. 应用本拍事件（设定值阶跃 / 保持型输出负载扰动）；
2. 读取测量 `y[k]`；
3. 计算 PID：`P=Kp*e`；`I += Ki*e*Ts`；
   `D = -Kd*(yf[k]-yf[k-1])/Ts`——**微分作用于测量值**，设定值突变不产生微分冲击；
   `yf` 为一阶滤波（`alpha=tf/(tf+Ts)`，`tf=0` 退化为原始一拍差分）；
4. 饱和到 `[uMin, uMax]`；
5. 抗积分饱和（二选一）：
   - `freeze` 条件积分：顶住限位且积分方向继续推向该限位时冻结积分；
   - `backcalc` 回算：`I += Ki*e*Ts + Kaw*(uSat-vUnsat)*Ts`，饱和期间有界、离饱和后自校正；
6. 应用延迟：新指令入队尾，队头 `u[k-d]` 驱动对象；
7. ZOH 递推推进对象（含保持型负载）；
8. 写入样本；出现非有限值或 `|y|>1e12` 立即**停止并记录原因**。

记录行中的 `y` 为本拍推进后的输出，`error/P/I/D` 对应该拍开始时读到的测量。

## 评估指标（`GET /runs/:id/report`）

- 超调量 `overshoot`（相对阶跃幅度；零阶跃为 `null`）
- 稳态误差 `steadyStateError`（末段 10% 样本平均绝对误差）
- 时间加权积分绝对误差 `iae = Σ|e|*Ts`
- 整定时间：进入误差带并**一直保持到末样本**的最早时刻；
  仅“首次过线”不算整定；始终未保持则 `settled=false`、`settlingTimeSeconds=null`

## 依赖安装

```powershell
npm install
```

只安装 `typescript` 与 `@types/node` 两个开发依赖。

## 构建与测试

```powershell
npm run build       # tsc 编译到 dist/
npm test            # 构建并运行全部自动化测试（node:test）
npm run typecheck   # 仅类型检查
npm run demo        # 可重复端到端演示（临时库，结束自动清理）
```

测试覆盖：离散解析值、解析开环阶跃、纯比例稳态偏置、误差（IAE）累计、
冻结/回算两种抗饱和恢复、无微分冲击、d=0/d=1 延迟、不稳定参数失败路径、
断点续算逐样本一致、历史与检查点重启复现、重复提交幂等、参数校验失败、
事务回滚、分页，以及 HTTP API 的错误码与完整流程。

## 启动与停止（只管理本项目进程）

```powershell
npm start                 # 构建并启动，127.0.0.1 + 自动端口
npm run stop              # 依据 .local/server.json 只停止本项目启动的 pid
```

启动后控制台会打印实际端口，同时写入 `.local/server.json`（pid/port/host）。
可用环境变量覆盖（均为可选项）：

- `PID_EVAL_PORT`（默认 `0` 自动分配）
- `PID_EVAL_HOME`（默认 `<项目>/data`，数据库目录）
- `PID_EVAL_PIDFILE`（默认 `<项目>/.local/server.json`）
- `PID_EVAL_NOW`（测试用：注入单调递增时钟，毫秒 epoch）

`npm run stop` 只向本项目 pid 文件中记录的进程发 `SIGTERM`，不触碰其他进程。

## HTTP API（节选）

所有错误统一为 `{ "error": { "code", "message", "details" } }`，错误码：
`VALIDATION(400)`、`BAD_JSON(400)`、`NOT_FOUND(404)`、
`CONFLICT(409)`、`RUN_NOT_RUNNING(409)`、`INTERNAL(500)`。

- `POST /plants/:name` / `GET /plants` / `GET /plants/:name?version=`（对象版本化）
- `POST /controllers/:name` / `GET /controllers` / `GET /controllers/:name?version=`
- `POST /runs`（**必须带 `idempotencyKey`**，重复提交返回同一 run）
- `POST /runs/:id/advance` `{ "n": 10 }`、`/pause`、`/resume`
- `GET /runs/:id`、`/runs/:id/report`、`/runs/:id/ops`
- `GET /runs/:id/samples?limit=&offset=`（分页，返回 `total/limit/offset`）
- `POST /compare`：同一情景比较多组 PID（带 `scenarioKey`，同样幂等）

创建 run 的最小 JSON：

```json
{
  "idempotencyKey": "demo-1",
  "plant": { "gain": 2, "tau": 5, "ts": 0.5, "delaySamples": 0, "uMin": -5, "uMax": 5 },
  "pid": { "kp": 0.4, "ki": 0.08, "kd": 0.1, "tf": 0.5, "antiWindup": "freeze", "kaw": 1 },
  "setpoint": 1,
  "y0": 0,
  "maxSamples": 120,
  "settlingFraction": 0.05,
  "events": [
    { "key": "sp-up", "atSample": 40, "kind": "setpoint", "value": 2 },
    { "key": "load",  "atSample": 30, "kind": "disturbance", "value": -0.8 }
  ]
}
```

## CLI

```powershell
npm run cli -- fixtures list
npm run cli -- plant create --name tank --json '@.local/p.json'
npm run cli -- plant list
npm run cli -- controller create --name c1 --json '@.local/c.json' --note tuned
npm run cli -- run create --scenario delayed
npm run cli -- run show    --id <id>
npm run cli -- run advance --id <id> --n 20     # 打印 BEFORE -> AFTER 状态
npm run cli -- run pause   --id <id>
npm run cli -- run resume  --id <id>
npm run cli -- run terms   --id <id>            # 最新一拍 P/I/D 分量
npm run cli -- run samples --id <id> --limit 10 --offset 0
npm run cli -- run report  --id <id>
npm run cli -- run export  --id <id> --out .local/seq.csv
npm run cli -- compare --scenario loadDisturbance
```

说明：

- `--json` 支持内联 JSON，或用 `@文件路径` 读取 JSON 文件（Windows PowerShell 下推荐后者，避免引号转义）。
- CLI 使用独立库 `data/cli.sqlite`，API 使用 `data/app.sqlite`；删除 `data/` 即可全部重置。
- 可用 `PID_EVAL_DB` 环境变量指定 CLI 数据库路径。

## 虚构夹具

`src/fixtures/fixtures.ts` 提供虚构对象、扰动与场景（纯合成数据）：
`pureProportionalStep`、`integralWindup`、`setpointChange`、
`loadDisturbance`、`delayed`、`unstable`（用于失败路径演示）。

## 断点续算与持久化

- 每个 run 的完整内部状态（积分、滤波量、延迟队列、计数、状态机）以 JSON 检查点存于 `runs.state_json`；
- 每次推进把「检查点 + 新样本」放在**同一事务**提交；
- 暂停/恢复或重启进程后从检查点继续，与一次性连续运行逐样本一致（测试 `pause/resume`、`survive a database reopen` 校验）。

## 目录

```
src/core/      类型、校验、引擎、指标、服务编排、错误码
src/db/        可重复迁移 + 仓储（事务、幂等、分页）
src/api/       本机 HTTP 服务与路由
src/cli/       命令行
src/fixtures/  虚构对象/扰动/场景
test/          node:test 自动化测试
scripts/       可重复演示、停止脚本
```
