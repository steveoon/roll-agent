---
"@roll-agent/runtime": minor
---

feat(runtime): `roll__read_file` 支持读取图片文件

- 通过 magic bytes（PNG/JPEG/GIF/WebP 文件头签名）识别图像，命中后以 base64 图像内容（content model output 的 file part）进入模型上下文，自动复用现有的工具图像搬运（`relocateToolImagesToUserMessages`）与「保留最近 2 张」老化策略
- 补齐了「工具截图落盘后模型无法回读」的能力缺口：browser-use 等流程存到磁盘的截图，现在可由模型直接 `read_file` 载入识别
- 图像分支只接管文本路径本就拒绝的文件（含 NUL 字节）：以 `GIF89a` 等签名开头的合法 UTF-8 文本仍走文本路径、照常可编辑，不会被误当图像
- 各格式做完整性尾校验（PNG IEND / JPEG EOI / GIF trailer / WebP RIFF 尺寸），截断或损坏的图像显式拒绝，不会进入上下文毒化会话
- 新增 `maxImageFileBytes` 设置（默认 5MB，对齐主流 provider 单图上限），超限图像与无签名二进制文件仍显式拒绝，文本路径行为不变（edit/write/verify 工具不受影响）
- 压缩器 token 估算对消息中的 file part 改按固定常数计（原按 base64 字符长度折算，读入大图会虚估出数十万 token，触发虚假 context-pressure 压缩把图立即挤出上下文）
- 图像读取忽略 `offset`/`limit`，工具描述已注明
