"""Arrange real rendered state screenshots; never synthesize page content."""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
request = json.loads(Path(sys.argv[1]).read_text())
columns = request['columns']
width, gap, header = 300, 24, 52
rows = max(len(column['frames']) for column in columns)
images = {(i, j): Image.open(frame['path']).convert('RGB') for i, column in enumerate(columns) for j, frame in enumerate(column['frames']) if frame.get('path')}
heights = [max((round(images[i, j].height * width / images[i, j].width) for i in range(len(columns)) if (i, j) in images), default=100) for j in range(rows)]
sheet = Image.new('RGB', (gap + len(columns) * (width + gap), gap + sum(h + header + gap for h in heights)), '#181c22')
draw = ImageDraw.Draw(sheet)
font = None
for path in ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf']:
    try:
        font = ImageFont.truetype(path, 16)
        break
    except OSError:
        pass
font = font or ImageFont.load_default()
for i, column in enumerate(columns):
    y = gap
    for j, frame in enumerate(column['frames']):
        x = gap + i * (width + gap)
        label = column['label']
        while font.getlength(label) > width:
            label = label[:-2] + '…'
        draw.text((x, y + 3), label, fill='#edf1ed', font=font)
        draw.text((x, y + 26), frame['id'], fill='#aab9ba', font=font)
        if (i, j) in images:
            im = images[i, j]
            im = im.resize((width, round(im.height * width / im.width)), Image.Resampling.LANCZOS)
            sheet.paste(im, (x, y + header))
        else:
            draw.rectangle((x, y + header, x + width, y + header + heights[j]), fill='#302326')
            draw.text((x + 10, y + header + 16), '未通过 / ' + frame.get('code', frame.get('status', 'failed')), fill='#ffc4bf', font=font)
        y += heights[j] + header + gap
sheet.save(sys.argv[2])
