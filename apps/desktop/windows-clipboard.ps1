$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$requestData = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($requestData.operation -eq 'copy') {
    $copyPath = [string]$requestData.path
    if (-not [System.IO.File]::Exists($copyPath)) { throw 'The requested file no longer exists.' }
    $fileList = New-Object System.Collections.Specialized.StringCollection
    [void]$fileList.Add($copyPath)
    [System.Windows.Forms.Clipboard]::SetFileDropList($fileList)
} elseif ($requestData.operation -ne 'inspect') { throw 'Unsupported clipboard operation.' }
$resultData = @{
    fileDrop = [System.Windows.Forms.Clipboard]::ContainsFileDropList()
    paths = @([System.Windows.Forms.Clipboard]::GetFileDropList())
    formats = @([System.Windows.Forms.Clipboard]::GetDataObject().GetFormats())
}
[Console]::Out.Write(($resultData | ConvertTo-Json -Compress))
