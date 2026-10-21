"""Generate original MIT-licensed demo artwork; no vendor assets or fonts are copied."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets' / 'mobile-primitives'


def font(size, bold=False):
    for path in ['/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def save(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)


def mobile_assets():
    for name in ['back', 'right', 'up', 'down', 'search']:
        im = Image.new('RGBA', (64, 64))
        d = ImageDraw.Draw(im)
        if name == 'search':
            d.ellipse((12, 10, 42, 40), outline='#536174', width=5)
            d.line((39, 38, 55, 54), fill='#536174', width=5)
        else:
            points = {'back': [(39, 12), (20, 32), (39, 52)], 'right': [(24, 12), (43, 32), (24, 52)],
                      'up': [(12, 40), (32, 20), (52, 40)], 'down': [(12, 24), (32, 44), (52, 24)]}[name]
            d.line(points, fill='#536174', width=5, joint='curve')
        save(im, ASSETS / 'icons' / f'icon-{name}.png')
    shells = {}
    for name, outer, screen, color in [
        ('iphone-x-black', [420, 860], [25, 21, 375, 812], '#202938'),
        ('iphone-x-white', [420, 860], [25, 21, 375, 812], '#DCE3ED'),
        ('iphone-6-8', [430, 866], [30, 99, 375, 667], '#202938'),
    ]:
        ow, oh = outer
        sx, sy, sw, sh = screen
        pieces = []
        for label, x, y, w, h in [('frame-top', 0, 0, ow, sy), ('frame-left', 0, sy, sx, sh),
                                   ('frame-right', sx + sw, sy, ow - sx - sw, sh),
                                   ('frame-bottom', 0, sy + sh, ow, oh - sy - sh)]:
            rel = f'shells/{name}/{label}.png'
            save(Image.new('RGBA', (w, h), color), ASSETS / rel)
            pieces.append({'name': label, 'file': rel, 'x': x, 'y': y, 'w': w, 'h': h})
        shells[name] = {'outerSize': outer, 'screenRect': screen, 'pieces': pieces}
    shells['iphone-x'] = dict(shells['iphone-x-black'])
    (ASSETS / 'manifest.json').write_text(json.dumps({
        'version': '1.0.0', 'description': 'Original geometric demo frames. Device names are compatibility aliases, not vendor artwork.',
        'shells': shells, 'icons': {n: f'icons/icon-{n}.png' for n in ['back', 'right', 'up', 'down', 'search']}
    }, indent=2) + '\n')
    probe = Image.new('RGB', (32, 16), '#2563EB')
    ImageDraw.Draw(probe).rectangle((16, 0, 31, 15), fill='#14B8A6')
    save(probe, ROOT / 'examples/rp-language/assets/native-probe.png')


def screenshot():
    im = Image.new('RGB', (960, 620), '#E8EEF6')
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, 160, 620), fill='#17233B')
    d.text((22, 24), 'ZEE LAB', font=font(24, True), fill='white')
    for i, label in enumerate(['Overview', 'Projects', 'Reports', 'Settings']):
        y = 98 + i * 49
        if i == 0:
            d.rounded_rectangle((12, y - 10, 148, y + 28), radius=7, fill='#2E4A7E')
        d.text((25, y), label, font=font(15), fill='#D6E1F5')
    d.rectangle((161, 0, 960, 68), fill='white')
    d.text((189, 23), 'Project overview', font=font(23, True), fill='#17233B')
    d.rounded_rectangle((816, 18, 928, 49), radius=6, fill='#2563EB')
    d.text((833, 25), 'New report', font=font(14), fill='white')
    for i, (label, value, extra) in enumerate([('Revenue', '$12,480', '+12.4%'), ('Active users', '1,280', '+8.6%'), ('Completed', '96', '+16 this week')]):
        x = 184 + i * 253
        d.rounded_rectangle((x, 92, x + 235, 208), radius=10, fill='white', outline='#CBD5E1', width=2)
        d.text((x + 18, 109), label, font=font(14), fill='#64748B')
        d.text((x + 18, 139), value, font=font(28, True), fill='#17233B')
        d.text((x + 18, 179), extra, font=font(12), fill='#159B7D')
    d.rounded_rectangle((184, 230, 659, 456), radius=10, fill='white', outline='#CBD5E1', width=2)
    d.text((203, 247), 'Weekly activity', font=font(17, True), fill='#17233B')
    for y in [300, 340, 380, 420]:
        d.line((209, y, 636, y), fill='#E5EAF1', width=1)
    for i, h in enumerate([54, 91, 72, 118, 103, 137]):
        x = 229 + 64 * i
        d.rounded_rectangle((x, 420 - h, x + 26, 420), radius=3, fill='#4A7DF2')
        d.text((x, 430), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i], font=font(11), fill='#64748B')
    d.rounded_rectangle((679, 230, 926, 456), radius=10, fill='white', outline='#CBD5E1', width=2)
    d.text((697, 247), 'Project status', font=font(17, True), fill='#17233B')
    d.pieslice((738, 286, 866, 414), -90, 126, fill='#2563EB')
    d.pieslice((738, 286, 866, 414), 126, 216, fill='#14B8A6')
    d.pieslice((738, 286, 866, 414), 216, 270, fill='#F4AD45')
    d.rounded_rectangle((184, 478, 926, 594), radius=10, fill='white', outline='#CBD5E1', width=2)
    d.text((204, 493), 'Recent projects', font=font(16, True), fill='#17233B')
    for i, (label, state) in enumerate([('Prototype review', 'In progress'), ('Design system', 'Completed')]):
        y = 525 + i * 29
        d.text((204, y), label, font=font(14), fill='#334155')
        d.text((690, y), state, font=font(13), fill='#159B7D')
    save(im, ROOT / 'examples/screenshot/source.png')


if __name__ == '__main__':
    mobile_assets()
    screenshot()
    print('Generated original mobile primitives, visual probe, and screenshot demo.')
