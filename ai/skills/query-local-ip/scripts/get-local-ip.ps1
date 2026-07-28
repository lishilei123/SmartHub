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

$addresses = Get-NetIPAddress -AddressFamily IPv4, IPv6 |
    Where-Object {
        -not $_.SkipAsSource -and
        $_.IPAddress -ne '127.0.0.1' -and
        $_.IPAddress -ne '::1' -and
        $_.AddressState -in @('Preferred', 'Tentative')
    } |
    ForEach-Object {
        $family = if ($_.AddressFamily -eq 2) { 'IPv4' } else { 'IPv6' }
        [pscustomobject]@{
            interface = $_.InterfaceAlias
            family = $family
            address = $_.IPAddress
            prefixLength = $_.PrefixLength
            scope = Get-AddressScope -Address $_.IPAddress -Family $family
        }
    } |
    Sort-Object @{ Expression = { if ($_.family -eq 'IPv4') { 0 } else { 1 } } }, interface, address

$primaryIpv4 = $addresses |
    Where-Object { $_.family -eq 'IPv4' -and $_.scope -eq 'private' } |
    Select-Object -First 1 -ExpandProperty address

[pscustomobject]@{
    hostname = [System.Net.Dns]::GetHostName()
    primaryIpv4 = $primaryIpv4
    addresses = @($addresses)
} | ConvertTo-Json -Depth 5 -Compress
