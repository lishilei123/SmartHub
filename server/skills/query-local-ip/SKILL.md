---
name: query-local-ip
description: Query the local IPv4 and IPv6 addresses of the host running the SmartHub service. Use when a user asks for the local IP, LAN address, network-interface address, IPv4, or IPv6 of this machine or the SmartHub server.
---

# 查询本机 IP

调用 `skill_execute_script`，参数固定为：

```json
{
  "script": "scripts/get-local-ip.ps1",
  "args": []
}
```

`skillKey` 由 SmartHub 根据当前 Agent 已绑定 Skill 和脚本声明唯一解析，不需要模型填写。

使用工具返回的 `parsed.addresses` 作答，列出接口名称、地址族、IP 地址和作用域。优先展示 `primaryIpv4`；若存在多个有效地址，保留全部结果，避免擅自判断唯一地址。

不得猜测或编造 IP。工具失败或未返回地址时，直接说明失败原因或未发现非回环地址。

这里的“本机”指运行 SmartHub 服务的主机，不是浏览器所在客户端。该脚本查询网卡地址，不查询公网出口 IP；用户明确询问公网 IP 时应说明这个边界。

