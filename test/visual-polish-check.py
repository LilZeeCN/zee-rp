"""Regress visual defects through the real expansion, layout and Axvg emit path."""
import base64
import copy
import io
import sys
import tempfile
import unittest
from pathlib import Path
from PIL import Image, ImageChops

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from proto import (expand_declarative_tree, measure_node, layout_node, emit_tree_to_axvg,
                   compose_device_shell, measure_text, render_flat_children_png, audit_prototype, THEMES)
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
        # Outside the bezel the mask repaints the white frame, so square content corners stay hidden.
        self.assertEqual(im.getpixel((0, 0)), (255, 255, 255, 255))
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

    def test_tab_labels_stay_centered_for_both_active_pages(self):
        spec = dsl_to_spec('''rp/1 target=9 domain=mobile theme=mobile-hifi
tab-bar:
  item home "今日"
  item detail "录入"
page #home name="首页" device=iphone-17
  phone-shell #shell title="A" gap=12
page #detail name="详情" device=iphone-17
  phone-shell #shell2 title="B" gap=12
''')
        lowered, _ = compile_language(spec)
        for page in lowered['pages']:
            node = expand_declarative_tree(copy.deepcopy(page['root']))
            measure_node(node)
            layout_node(node, 0, 0, page['canvas']['w'], page['canvas']['h'])
            emitted = emit_tree_to_axvg(node, THEMES['mobile-hifi'])
            buttons = []
            def collect(item):
                if item.get('name', '').startswith('btn-tab_'):
                    buttons.append(item)
                for child in item.get('scene', {}).get('items', []): collect(child)
            for item in emitted['axvg']['scene']['items']: collect(item)
            self.assertEqual(len(buttons), 2)
            self.assertEqual([item['textAlignment'] for item in buttons], [1, 1], page['slug'])

    def test_offline_preview_honors_explicit_vertical_alignment(self):
        positions = []
        for alignment in (0, 1, 2):
            image = render_flat_children_png(100, 50, '#FFFFFF', [{
                'kind': 'text', 'name': 'btn-label', 'text': '今日', 'size': 12,
                'x': 0, 'y': 0, 'w': 100, 'h': 50, 'color': '#000000',
                'align': 'center', 'textAlignment': alignment,
            }])
            bbox = ImageChops.difference(image, Image.new('RGB', image.size, 'white')).getbbox()
            self.assertIsNotNone(bbox)
            positions.append(bbox)
        self.assertLessEqual(positions[0][1], 1)
        self.assertAlmostEqual((positions[1][1] + positions[1][3]) / 2, 25, delta=1)
        self.assertGreaterEqual(positions[2][3], 49)

    def test_audit_detects_native_alignment_even_when_preview_metadata_is_centered(self):
        node, emitted = render({'type': 'button', 'name': 'btn-check', 'text': '今日', 'w': 120, 'h': 38})
        plan = {'pageName': 'test', 'widgetNames': ['btn-check']}
        self.assertTrue(audit_prototype(node, emitted, plan)['structural_gates']['button_text_alignment_ok'])
        def break_alignment(item):
            if item.get('name') == 'btn-check': item['textAlignment'] = 0
            for child in item.get('scene', {}).get('items', []): break_alignment(child)
        for item in emitted['axvg']['scene']['items']: break_alignment(item)
        broken = audit_prototype(node, emitted, plan)
        self.assertFalse(broken['structural_gates']['button_text_alignment_ok'])
        self.assertTrue(any(f['gate'] == 'button_text_alignment_ok' and f['widget'] == 'btn-check'
                            for f in broken['failures']))


if __name__ == '__main__': unittest.main()
