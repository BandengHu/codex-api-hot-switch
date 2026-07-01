const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const root = path.resolve(__dirname, "..")
const publicDir = path.join(root, "public")
const outputPath = path.join(publicDir, "app-icon-switch.ico")
const source512Path = path.join(publicDir, "app-icon-switch-512.png")
const source256Path = path.join(publicDir, "app-icon-switch-256.png")
const sourceFiles = [
  "app-icon-switch-256.png",
  "app-icon-switch-64.png",
  "app-icon-switch-32.png",
]

function ensureResizedPng() {
  const sourceStat = fs.statSync(source512Path)
  const outputStat = fs.existsSync(source256Path) ? fs.statSync(source256Path) : null
  if (outputStat && outputStat.mtimeMs >= sourceStat.mtimeMs) {
    return
  }

  const script = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing.Common
$source = $env:SOURCE_PNG
$output = $env:OUTPUT_PNG
$image = [System.Drawing.Image]::FromFile($source)
try {
  $bitmap = [System.Drawing.Bitmap]::new(256, 256)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($image, 0, 0, 256, 256)
      $bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $graphics.Dispose()
    }
  } finally {
    $bitmap.Dispose()
  }
} finally {
  $image.Dispose()
}
`
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", script], {
    cwd: root,
    env: {
      ...process.env,
      SOURCE_PNG: source512Path,
      OUTPUT_PNG: source256Path,
    },
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(
      [
        "Failed to generate 256px Windows icon image with pwsh.",
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }
}

function readPng(fileName) {
  const filePath = path.join(publicDir, fileName)
  const buffer = fs.readFileSync(filePath)
  if (
    buffer.length < 24 ||
    buffer[0] !== 0x89 ||
    buffer.slice(1, 4).toString("ascii") !== "PNG"
  ) {
    throw new Error(`${fileName} is not a PNG file`)
  }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width !== height) {
    throw new Error(`${fileName} must be square for ICO output`)
  }
  if (width > 256 || height > 256) {
    throw new Error(`${fileName} is ${width}x${height}; ICO entries must be <= 256`)
  }
  return { buffer, width, height }
}

function buildIco(images) {
  const headerSize = 6
  const entrySize = 16
  const directorySize = headerSize + images.length * entrySize
  let imageOffset = directorySize
  const totalSize = directorySize + images.reduce((sum, image) => sum + image.buffer.length, 0)
  const ico = Buffer.alloc(totalSize)

  ico.writeUInt16LE(0, 0)
  ico.writeUInt16LE(1, 2)
  ico.writeUInt16LE(images.length, 4)

  images.forEach((image, index) => {
    const entryOffset = headerSize + index * entrySize
    ico[entryOffset] = image.width === 256 ? 0 : image.width
    ico[entryOffset + 1] = image.height === 256 ? 0 : image.height
    ico[entryOffset + 2] = 0
    ico[entryOffset + 3] = 0
    ico.writeUInt16LE(1, entryOffset + 4)
    ico.writeUInt16LE(32, entryOffset + 6)
    ico.writeUInt32LE(image.buffer.length, entryOffset + 8)
    ico.writeUInt32LE(imageOffset, entryOffset + 12)
    image.buffer.copy(ico, imageOffset)
    imageOffset += image.buffer.length
  })

  return ico
}

ensureResizedPng()
const images = sourceFiles.map(readPng)
fs.writeFileSync(outputPath, buildIco(images))
console.log(`Wrote ${path.relative(root, outputPath)} with ${images.length} image entries`)
