const MAX_FILE = 50 * 1024 * 1024;
const MAX_IMAGE = 12 * 1024 * 1024;
const MAX_ITEMS = 8;

function safeName(input, fallback) {
  const name = String(input || fallback).replace(/[\\/\x00-\x1f\x7f]/g, '_').trim().slice(0, 120);
  return name && name !== '.' && name !== '..' ? name : fallback;
}
function imageMediaType(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (data.length >= 3 && data.subarray(0, 3).equals(Buffer.from([255,216,255]))) return 'image/jpeg';
  if (data.length >= 12 && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (data.length >= 6 && ['GIF87a','GIF89a'].includes(data.subarray(0, 6).toString())) return 'image/gif';
  return null;
}

/** Prepare authenticated owner media for DSH's SessionController prompt. */
export class MediaHandler {
  constructor({ client, fileUploads, maxFileBytes = MAX_FILE, maxImageBytes = MAX_IMAGE }) {
    if (typeof client?.downloadMedia !== 'function' || typeof fileUploads?.uploadStream !== 'function') {
      throw new TypeError('MediaHandler needs iLink downloadMedia and DSH fileUploads');
    }
    this.client = client;
    this.fileUploads = fileUploads;
    this.maxFileBytes = maxFileBytes;
    this.maxImageBytes = maxImageBytes;
  }
  async prepare(item, sessionId, signal) {
    if (!Array.isArray(item?.media) || !item.media.length) return [{ type: 'text', text: item.text }];
    if (item.media.length > MAX_ITEMS) throw new RangeError('Too many media items');
    const parts = [{ type: 'text', text: item.sourceKind === 'media' ? '请查看以下微信附件。' : item.text }];
    let totalBytes = 0;
    for (const [index, descriptor] of item.media.entries()) {
      signal?.throwIfAborted();
      if (!['image', 'file', 'video'].includes(descriptor.kind)) throw new TypeError('Invalid media kind');
      const limit = descriptor.kind === 'image' ? this.maxImageBytes : this.maxFileBytes;
      if (Number.isFinite(descriptor.size) && descriptor.size > limit) throw new RangeError('Media item too large');
      const bytes = await this.client.downloadMedia(descriptor, signal);
      signal?.throwIfAborted();
      if (!Buffer.isBuffer(bytes) || (descriptor.kind === 'image' && bytes.length === 0) || bytes.length > limit) throw new RangeError('Invalid media bytes');
      totalBytes += bytes.length;
      if (totalBytes > this.maxFileBytes) throw new RangeError('Message media too large');
      if (descriptor.kind === 'image') {
        const mediaType = imageMediaType(bytes);
        if (!mediaType) throw new TypeError('Unrecognized image');
        parts.push({ type: 'image', mediaType, data: bytes.toString('base64'), name: `wechat-image-${index + 1}.${mediaType.split('/')[1]}` });
      } else {
        const name = safeName(descriptor.name, descriptor.kind === 'video' ? `wechat-video-${index + 1}.mp4` : `wechat-file-${index + 1}`);
        const uploaded = await this.fileUploads.uploadStream({ sessionId, data: (async function* () {
          for (let at = 0; at < bytes.length; at += 65536) {
            signal?.throwIfAborted();
            yield bytes.subarray(at, at + 65536);
          }
        })(), name, signal });
        if (typeof uploaded?.receiptId !== 'string' || !uploaded.receiptId) throw new Error('DSH file upload failed');
        parts.push({ type: 'file', receiptId: uploaded.receiptId });
        if (descriptor.kind === 'video') parts.push({ type: 'text', text: `视频文件 ${name} 已附上；可按文件处理，不能假设视频帧已直接进入模型视觉上下文。` });
      }
    }
    return parts;
  }
}
