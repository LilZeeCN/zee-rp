"""Regress visual defects through the real expansion, layout and Axvg emit path."""
import base64
import copy
import io
import sys
import tempfile
import unittest
from pathlib import Path
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from proto import (expand_declarative_tree, measure_node, layout_node, emit_tree_to_axvg,
                   compose_device_shell, measure_text, THEMES)
from rp_language import compile_language, LanguageError
from rp_dsl import dsl_to_spec


def render(root):
    node = expand_declarative_tree(copy.deepcopy(root))
    measure_node(node)
    layout_node(node, 0, 0, 120, 120)
    return node, emit_tree_to_axvg(node, THEMES['mobile-hifi'])


class VisualPolish(unittest.TestCase):
    def test_centered_single_label_inherits_alignment(self):
        for explicit in (None, 'left', 'right'):
            label = {'type': 'label', 'name': 'digit', 'text': '1', 'w': 16, 'h': 20}
            if explicit: label['align'] = explicit
            node, emitted = render({'type': 'box', 'name': 'circle', 'w': 28, 'h': 28,
                'align': 'center', 'justify': 'center', 'children': [label]})
            self.assertEqual(node['children'][0]['align'], explicit or 'center')
            text = next(c for c in emitted['flatChildren'] if c.get('text') == '1')
            self.assertEqual(text['align'], explicit or 'center')

    def test_image_radius_and_opacity_survive_native_emit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'square.png'
            Image.new('RGBA', (80, 80), (255, 0, 0, 255)).save(path)
            for radius in (0, 20):
                _, emitted = render({'type': 'image', 'name': 'photo', 'src': str(path),
                    'w': 80, 'h': 80, 'radius': radius, 'opacity': 0.5})
                ch = emitted['flatChildren'][0]
                data = emitted['axvg']['imageMap'][ch['imageKey']]
                im = Image.open(io.BytesIO(base64.b64decode(data))).convert('RGBA')
                self.assertIn(im.getpixel((im.width//2, im.height//2))[3], (127, 128))
                self.assertEqual(im.getpixel((0, 0))[3], 0 if radius else 128)

    def test_device_screen_corners_mask_foreground_content(self):
        _, emitted = render({'type': 'box', 'name': 'screen', 'w': 402, 'h': 874,
            'fill': '#FFFFFF', 'children': []})
        shell = compose_device_shell(emitted, 'test', 'iphone-17-pro')
        mask = next((c for c in shell['flatChildren'] if 'screen-mask' in c['name']), None)
        self.assertIsNotNone(mask)
        im = Image.open(io.BytesIO(base64.b64decode(shell['axvg']['imageMap'][mask['imageKey']]))).convert('RGBA')
        self.assertEqual(im.getpixel((0, 0))[3], 0)
        self.assertEqual(im.getpixel((0, im.height//2))[3], 255)
        self.assertEqual(im.getpixel((im.width//2, im.height//2))[3], 0)

    def test_tracking_width_is_already_measured(self):
        n = {'type': 'label', 'name': 'tag', 'text': 'COUNTDOWN', 'fontSize': 11, 'letterSpacing': 1}
        width, _ = measure_node(n)
        self.assertGreaterEqual(width, measure_text('COUNTDOWN', 11)[0] + 8)

    def test_hug_panel_uses_largest_state(self):
        node = {'type': 'dynamic-panel', 'name': 'flip', 'w': 300, 'h': 'hug', 'states': [
            {'name': 'front', 'tree': {'type': 'box', 'w': 300, 'h': 260}},
            {'name': 'back', 'tree': {'type': 'box', 'w': 300, 'h': 500}}]}
        self.assertEqual(measure_node(node)[1], 500)

    def test_tab_indicator_and_equal_items(self):
        spec = dsl_to_spec('''rp/1 target=9 domain=mobile theme=mobile-hifi
page #home [402x874]
  tab-bar #nav [fillx56] active="one" activeIndicator="underline" activeVariant="ghost" justify="center" itemFlex=1 items=[{"id":"one","label":"今日","goto":"home"},{"id":"two","label":"手记","goto":"home"}]
''')
        lowered, _ = compile_language(spec)
        bar = lowered['pages'][0]['root']
        self.assertEqual(bar['justify'], 'center')
        self.assertEqual(len(bar['children']), 2)
        self.assertTrue(all(c['flex'] == 1 for c in bar['children']))
        for item in bar['children']:
            self.assertTrue(any(c.get('name', '').startswith('box-') or c.get('h') == 3 for c in item['children']))
        invalid = copy.deepcopy(spec)
        invalid['pages'][0]['root']['activeIndicator'] = 'wrong'
        with self.assertRaises(LanguageError): compile_language(invalid)


if __name__ == '__main__': unittest.main()
