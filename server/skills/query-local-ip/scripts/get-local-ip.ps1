$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Get-AddressScope {
    param(
        [Parameter(Mandatory)]
        [string]$Address,
        [Parameter(Mandatory)]
        [string]$Family
    )

    if ($Family -eq 'IPv4') {
        if ($Address -match '^10\.' -or $Address -match '^192\.168\.' -or $Address -match '^172\.(1[6-9]|2[0-9]|3[01])\.') { return 'private' }
        if ($Address -match '^169\.254\.') { return 'link_local' }
        return 'global'
    }

    if ($Address -match '^(?i:fe[89ab])') { return 'link_local' }
    if ($Address -match '^(?i:f[cd])') { return 'private' }
    return 'global'
}

# 使用跨平台的 .NET 类获取所有网卡接口
$adapters = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()
$addresses = @()

foreach ($adapter in $adapters) {
    # 过滤掉 Loopback 环回接口以及未处于 Up (运行中) 状态的网卡
    if ($adapter.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback -or
        $adapter.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) {
        continue
    }

    $ipProps = $adapter.GetIPProperties()

    # 遍历每个网卡绑定的单播地址
    foreach ($unicast in $ipProps.UnicastAddresses) {
        $ip = $unicast.Address.ToString()

        # 进一步防御性过滤本地环回地址
        if ($ip -eq '127.0.0.1' -or $ip -eq '::1') {
            continue
        }

        # 区分 IPv4 和 IPv6
        $family = if ($unicast.Address.AddressFamily -eq 'InterNetwork') { 'IPv4' }
                  elseif ($unicast.Address.AddressFamily -eq 'InterNetworkV6') { 'IPv6' }
                  else { continue }

        $addresses += [pscustomobject]@{
            interface    = $adapter.Name
            family       = $family
            address      = $ip
            prefixLength = $unicast.PrefixLength
            scope        = Get-AddressScope -Address $ip -Family $family
        }
    }
}

# 排序逻辑：IPv4 优先，然后按接口名称，最后按 IP 地址
$sortedAddresses = $addresses | 
    Sort-Object @{ Expression = { if ($_.family -eq 'IPv4') { 0 } else { 1 } } }, interface, address

# 选取第一个 private 的 IPv4 作为 primaryIpv4
$primaryIpv4 = $sortedAddresses |
    Where-Object { $_.family -eq 'IPv4' -and $_.scope -eq 'private' } |
    Select-Object -First 1 -ExpandProperty address

[pscustomobject]@{
    hostname    = [System.Net.Dns]::GetHostName()
    primaryIpv4 = $primaryIpv4
    addresses   = @($sortedAddresses)
} | ConvertTo-Json -Depth 5 -Compress