[CmdletBinding()]
param(
    [ValidateSet('math', 'english', 'physics')]
    [string[]]$Course = @('math', 'english', 'physics'),

    [switch]$Upload,
    [switch]$Force,

    [ValidateRange(0, 51)]
    [int]$Crf = 21,

    [ValidateSet('ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow')]
    [string]$Preset = 'medium',

    [string]$InputDirectory = '',
    [string]$OutputDirectory = '',
    [string]$EnvFile = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($InputDirectory)) {
    $InputDirectory = Join-Path $projectRoot '初高衔接视频'
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $InputDirectory 'streaming-ready'
}

$InputDirectory = [System.IO.Path]::GetFullPath($InputDirectory)
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

$courseSpecs = [ordered]@{
    math = [pscustomobject]@{ Source = '数学原视频.mp4'; Output = 'math.mp4' }
    english = [pscustomobject]@{ Source = '英语原视频.mp4'; Output = 'english.mp4' }
    physics = [pscustomobject]@{ Source = '物理原视频.mp4'; Output = 'physics.mp4' }
}

function Get-RequiredTool {
    param([Parameter(Mandatory)][string]$Name)

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "缺少 $Name。请先安装 FFmpeg 并确保 $Name 已加入 PATH。"
    }
    return $command.Source
}

function Get-MediaInfo {
    param(
        [Parameter(Mandatory)][string]$ProbePath,
        [Parameter(Mandatory)][string]$MediaPath
    )

    $raw = & $ProbePath -v error -show_entries 'format=duration,size:stream=codec_type,codec_name,pix_fmt' -of json -- $MediaPath
    if ($LASTEXITCODE -ne 0) {
        throw "无法读取媒体参数：$MediaPath"
    }

    $metadata = $raw | ConvertFrom-Json
    $video = $metadata.streams | Where-Object codec_type -eq 'video' | Select-Object -First 1
    $audio = $metadata.streams | Where-Object codec_type -eq 'audio' | Select-Object -First 1
    if (-not $video) {
        throw "视频轨道不存在：$MediaPath"
    }

    return [pscustomobject]@{
        VideoCodec = [string]$video.codec_name
        PixelFormat = [string]$video.pix_fmt
        AudioCodec = if ($audio) { [string]$audio.codec_name } else { '' }
        DurationSeconds = [double]$metadata.format.duration
        SizeBytes = [long]$metadata.format.size
    }
}

$ffmpeg = Get-RequiredTool -Name 'ffmpeg'
$ffprobe = Get-RequiredTool -Name 'ffprobe'
$node = if ($Upload) { Get-RequiredTool -Name 'node' } else { $null }

if (-not (Test-Path -LiteralPath $InputDirectory -PathType Container)) {
    throw "输入目录不存在：$InputDirectory"
}
if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
}

$prepared = [System.Collections.Generic.List[string]]::new()

foreach ($courseId in $Course) {
    $spec = $courseSpecs[$courseId]
    $sourcePath = Join-Path $InputDirectory $spec.Source
    $outputPath = Join-Path $OutputDirectory $spec.Output

    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "找不到 $courseId 源视频：$sourcePath"
    }

    if ((Test-Path -LiteralPath $outputPath -PathType Leaf) -and -not $Force) {
        Write-Host "[$courseId] 已存在，跳过转换：$outputPath"
        $prepared.Add($outputPath)
        continue
    }

    $sourceInfo = Get-MediaInfo -ProbePath $ffprobe -MediaPath $sourcePath
    $copyVideo = $sourceInfo.VideoCodec -eq 'h264' -and $sourceInfo.PixelFormat -eq 'yuv420p'
    $copyAudio = [string]::IsNullOrWhiteSpace($sourceInfo.AudioCodec) -or $sourceInfo.AudioCodec -eq 'aac'
    $mode = if ($copyVideo -and $copyAudio) { '无损重封装 + faststart' } else { 'H.264/AAC 转码 + faststart' }
    Write-Host "[$courseId] $mode"
    Write-Host "  输入：$sourcePath"
    Write-Host "  输出：$outputPath"

    $temporaryPath = Join-Path $OutputDirectory ".$($spec.Output).$([guid]::NewGuid().ToString('N')).partial.mp4"
    $videoArguments = if ($copyVideo) {
        @('-c:v', 'copy')
    } else {
        @('-c:v', 'libx264', '-preset', $Preset, '-crf', [string]$Crf, '-pix_fmt', 'yuv420p')
    }
    $audioArguments = if ($copyAudio) {
        @('-c:a', 'copy')
    } else {
        @('-c:a', 'aac', '-b:a', '128k')
    }
    $ffmpegArguments = @(
        '-hide_banner', '-y',
        '-i', $sourcePath,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-sn', '-dn'
    ) + $videoArguments + $audioArguments + @(
        '-movflags', '+faststart',
        $temporaryPath
    )

    & $ffmpeg @ffmpegArguments
    if ($LASTEXITCODE -ne 0) {
        throw "[$courseId] FFmpeg 处理失败；原视频未改动。临时文件保留在：$temporaryPath"
    }

    $resultInfo = Get-MediaInfo -ProbePath $ffprobe -MediaPath $temporaryPath
    if ($resultInfo.VideoCodec -ne 'h264' -or (-not [string]::IsNullOrWhiteSpace($resultInfo.AudioCodec) -and $resultInfo.AudioCodec -ne 'aac')) {
        throw "[$courseId] 输出格式不符合 H.264/AAC 要求：$temporaryPath"
    }

    Move-Item -LiteralPath $temporaryPath -Destination $outputPath -Force:$Force
    $prepared.Add($outputPath)
    Write-Host ("[$courseId] 完成：{0:N1} MB，{1:N1} 分钟" -f ($resultInfo.SizeBytes / 1MB), ($resultInfo.DurationSeconds / 60))
}

if ($Upload) {
    $uploadScript = Join-Path $PSScriptRoot 'upload-course-videos.js'
    if ([string]::IsNullOrWhiteSpace($EnvFile)) {
        $projectEnvFile = Join-Path $projectRoot '.env'
        $videoEnvFile = Join-Path $InputDirectory '.env'
        $EnvFile = if (Test-Path -LiteralPath $projectEnvFile -PathType Leaf) {
            $projectEnvFile
        } elseif (Test-Path -LiteralPath $videoEnvFile -PathType Leaf) {
            $videoEnvFile
        } else {
            throw "找不到 R2 配置。请在 $projectEnvFile 或 $videoEnvFile 中配置 .env。"
        }
    }
    $EnvFile = [System.IO.Path]::GetFullPath($EnvFile)
    $uploadArguments = @($uploadScript, '--input', $OutputDirectory, '--courses', ($Course -join ','), '--env-file', $EnvFile)
    & $node @uploadArguments
    if ($LASTEXITCODE -ne 0) {
        throw 'R2 上传失败；本地转换结果已保留。'
    }
}

Write-Host ''
Write-Host "处理完成，共 $($prepared.Count) 个课程视频。"
if (-not $Upload) {
    Write-Host '如需上传到私有 R2，确认本地 .env 已配置后加 -Upload。'
}
