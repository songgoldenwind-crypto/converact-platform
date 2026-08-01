# Converact 非生产测试服务器

Converact 后续受控测试的 canonical SSH 目标是：

```sh
ssh ubuntu@101.42.7.139
```

该主机是 **non-production** 测试服务器。地址与用户的唯一机器可读权威是
[`scripts/lib/converact-validation-server.sh`](../../scripts/lib/converact-validation-server.sh)，需要连接时可使用：

```sh
. ./scripts/lib/converact-validation-server.sh
ssh "$CONVERACT_VALIDATION_SSH_TARGET"
```

不得把此主机默认视为生产环境，也不得仅凭该主机的结果授予生产资格。每次测试证据仍需记录源提交、配置摘要、主机规格、时间范围、原始输出以及未证明项。

## 2026-08-01 切换基线

切换时进行了只读盘点，再以可恢复方式停止已有应用服务：

- 运行中的应用容器为 0；容器、镜像、卷和数据均未删除；
- PM2 中四个既有应用保留定义但处于 `stopped`；
- Nginx 与既有证书续期 timer 处于 `inactive`；
- 应用端口没有监听者；SSH 与必要系统服务保持运行。

这些只是切换时的观测结果，不是永久事实。测试前必须重新盘点，测试使用独立项目名，并在退出时清理自身创建的资源。验收脚本会捕获测试前全部运行容器，并要求清理后恢复为完全相同的容器基线。

## 历史证据纪律

旧服务器地址仍会出现在日期化报告和 `docs/evidence/` 中。它们描述的是当时实际执行环境；**历史证据中的旧地址不得批量替换**。从本次切换之后产生的新测试或证据才使用本页定义的新目标。

仓库和证据中不得记录 SSH 密钥、密码、token 或其他凭据。
