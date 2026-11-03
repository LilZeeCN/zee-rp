"""Deterministic media derivative: normalized focal crop, protected region and token fade."""
import json
import sys
from PIL import Image, ImageOps

job = json.load(sys.stdin)
src = Image.open(job['sourcePath'])
# 有损转换必须自首（T-F-1）：透明通道与多帧动画在转 JPG 时会无声丢失。
warnings = []
frames = getattr(src, 'n_frames', 1)
if frames > 1:
    warnings.append({'code': 'W_MEDIA_ANIMATION_DROPPED', 'message': f'源图为动图（{frames} 帧），只取第 1 帧，动画信息丢失'})
has_alpha = src.mode in ('RGBA', 'LA', 'PA') or (src.mode == 'P' and 'transparency' in src.info)
if has_alpha and src.convert('RGBA').getchannel('A').getextrema()[0] < 255:
    warnings.append({'code': 'W_MEDIA_ALPHA_DROPPED', 'message': '源图含透明通道，转 JPG 后透明被填实，透明信息丢失'})
im = ImageOps.exif_transpose(src).convert('RGB')
W, H = im.size
c = job['recipe']
aspect = c['w'] / c['h']
ch = c['fh'] * H
cw = ch * aspect
if cw > W:
    cw, ch = W, W / aspect
left = min(max(c['fx'] * W - cw / 2, 0), W - cw)
top = min(max(c['fy'] * H - ch / 2, 0), H - ch)
box = tuple(round(x) for x in (left, top, left + cw, top + ch))
region = c.get('protectedRegion')
if region:
    x, y, w, h = region['x'] * W, region['y'] * H, region['w'] * W, region['h'] * H
    if x < box[0] or y < box[1] or x + w > box[2] or y + h > box[3]:
        print(json.dumps({'ok': False, 'code': 'E_MEDIA_SUBJECT_CROP', 'message': '保护主体超出裁切框，请调整焦点、裁切高度或图框比例', 'crop': box}))
        sys.exit(0)
out = im.crop(box).resize((c['w'] * c['scale'], c['h'] * c['scale']), Image.Resampling.LANCZOS)
if 'fadeColor' in c:
    paper = Image.new('RGB', out.size, c['fadeColor'])
    mask = Image.new('L', out.size, 0)
    y0, H2 = round(c['fadeFrom'] * c['scale']), out.height
    for y in range(y0, H2):
        t = (y - y0) / max(1, H2 - 1 - y0)
        mask.paste(round(255 * t * t * (3 - 2 * t)), (0, y, out.width, y + 1))
    out = Image.composite(paper, out, mask)
out.save(job['outputPath'], 'JPEG', quality=86, optimize=True, progressive=True)
print(json.dumps({'ok': True, 'crop': box, 'originalSize': [W, H], 'width': out.width, 'height': out.height,
                  'sourceFormat': src.format or None, 'warnings': warnings}))
