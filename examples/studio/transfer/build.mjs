// Three authored, editable studies. These are candidates, not user-approved benchmarks.
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const link = page => ({ click: [{ type: 'link', page }] });
const box = (id, x, y, w, h, fill, extra = {}) => ({ id, type: 'box', layout: 'stack', x, y, w, h, fill, ...extra });
const text = (id, value, x, y, w, h, size, color, extra = {}) => ({ id, type: 'label', text: value, x, y, w, h, fontSize: size, color, lineHeight: size + 8, fontFamily: 'PingFang SC', ...extra });
const para = (id, value, x, y, w, h, size, color, extra = {}) => ({ ...text(id, value, x, y, w, h, size, color, { wrap: true, ...extra }), type: 'paragraph' });
const button = (id, value, x, y, w, fill, color, page) => ({ id, type: 'button', text: value, x, y, w, h: 54, fontSize: 16, fontWeight: 600, fill, color, radius: 14, on: link(page) });
const image = (id, src, x, y, w, h) => ({ id, type: 'image', src, x, y, w, h });
const rule = (id, y, color) => box(id, 28, y, 346, 1, color);
function page(id, name, bg, ink, nodes) {
  return { id, name, device: 'iphone-17-pro', root: { id: `${id}_shell`, type: 'phone-shell', device: 'iphone-17-pro', statusBar: false, padding: 0, gap: 0, fill: bg,
    children: [box(`${id}_screen`, 0, 0, 402, 874, bg, { children: [
      text(`${id}_time`, '9:41', 34, 15, 56, 24, 16, ink, { fontWeight: 600 }),
      text(`${id}_signal`, '5G  ▰', 302, 15, 70, 24, 13, ink), ...nodes,
    ] })] } };
}
function optic(id, x, y, scale, ink, accent, kind = 'camera') {
  if (kind === 'binoculars') return box(id, x, y, 78, 68, '#FFFFFF00', { children: [
    box(`${id}_left`, 9, 10, 24, 42, ink, { radius: 9 }), box(`${id}_right`, 45, 10, 24, 42, ink, { radius: 9 }),
    box(`${id}_bridge`, 29, 20, 20, 9, ink), box(`${id}_lens_l`, 7, 34, 29, 29, accent, { radius: 15 }),
    box(`${id}_lens_r`, 43, 34, 29, 29, accent, { radius: 15 }), box(`${id}_glass_l`, 14, 41, 15, 15, ink, { radius: 8 }), box(`${id}_glass_r`, 50, 41, 15, 15, ink, { radius: 8 }),
  ] });
  if (kind === 'tripod') return box(id, x, y, 78, 68, '#FFFFFF00', { children: [
    box(`${id}_mount`, 24, 9, 29, 8, ink, { radius: 3 }), box(`${id}_shaft`, 36, 17, 5, 43, ink, { radius: 2 }),
    ...Array.from({ length: 8 }, (_, i) => [box(`${id}_leg_l_${i}`, 34 - i * 3, 25 + i * 4, 5, 7, ink, { radius: 2 }), box(`${id}_leg_r_${i}`, 38 + i * 3, 25 + i * 4, 5, 7, ink, { radius: 2 })]).flat(),
  ] });
  return box(id, x, y, 78 * scale, 68 * scale, '#FFFFFF00', { children: [
    box(`${id}_body`, 12 * scale, 12 * scale, 54 * scale, 42 * scale, ink, { radius: 10 * scale }),
    box(`${id}_top`, 23 * scale, 6 * scale, 24 * scale, 12 * scale, ink, { radius: 3 * scale }),
    box(`${id}_lens`, 26 * scale, 17 * scale, 35 * scale, 35 * scale, accent, { radius: 18 * scale }),
    box(`${id}_glass`, 33 * scale, 24 * scale, 21 * scale, 21 * scale, ink, { radius: 11 * scale }),
  ] });
}
export function buildTransferSources(outputDir = here) {
  mkdirSync(join(outputDir, 'assets'), { recursive: true });
  for (const name of ['sp_photo.jpg', 'jr_photo.jpg']) copyFileSync(join(here, '../qiyu-field-notes/assets', name), join(outputDir, 'assets', name));
  const cream = '#F4F1E9', ink = '#272B24', red = '#A63E2D';
  const museum = { language: 'rp/1', target: 9, name: '翼间 · 自然观察特展', device: 'iphone-17-pro', palette: { bg: cream, ink, brand: red }, pages: [
    page('museum_home', '01 翼间 展览', cream, ink, [
      text('museum_wordmark', '翼间  /  WINGSPACE', 28, 68, 310, 28, 16, ink, { fontWeight: 600 }),
      text('museum_issue', '自然观察特展     VOL. 06', 28, 112, 340, 24, 11, '#6C7166', { letterSpacing: 1 }),
      para('museum_title', '把目光，\n交给自然。', 28, 146, 340, 116, 42, ink, { fontFamily: 'Songti SC', lineHeight: 53 }),
      image('museum_photo', 'assets/sp_photo.jpg', 28, 280, 346, 362),
      box('museum_caption_bg', 28, 592, 346, 50, ink),
      text('museum_caption', '01    普通翠鸟：蓝色的一瞬', 43, 605, 316, 24, 13, '#F4F1E9'),
      text('museum_date', '10.26—12.08', 28, 666, 240, 36, 25, ink, { fontFamily: 'Georgia' }),
      text('museum_venue', '城市自然馆 · 二层临展厅', 28, 710, 346, 26, 13, '#6C7166'),
      button('museum_open', '看看这场展览    ↗', 28, 770, 346, red, '#FFFFFF', 'museum_detail'),
    ]),
    page('museum_detail', '02 展览 导览', cream, ink, [
      text('museum_back', '←  展览', 28, 68, 140, 28, 15, ink, { on: link('museum_home') }),
      text('museum_detail_no', 'FIELD NOTES  /  01', 28, 124, 340, 24, 11, red, { letterSpacing: 1 }),
      para('museum_detail_title', '蓝色，并不只在天空。', 28, 160, 346, 94, 34, ink, { fontFamily: 'Songti SC', lineHeight: 45 }),
      image('museum_detail_photo', 'assets/jr_photo.jpg', 28, 266, 346, 228),
      para('museum_story', '沿着河流、芦苇与城市边缘，认识那些与我们共享日常的飞羽。慢一点，才能看见它们。', 28, 516, 346, 96, 16, ink, { lineHeight: 29 }),
      rule('museum_line', 634, '#D8D9CE'),
      text('museum_time_label', '参观时间', 28, 656, 100, 26, 12, '#6C7166'),
      text('museum_time_value', '10月26日  14:00—16:00', 128, 653, 246, 32, 16, ink),
      text('museum_cost', '免费入场 · 预约后获得电子凭证', 28, 706, 346, 26, 13, '#6C7166'),
      button('museum_book', '预约这一场参观', 28, 770, 346, red, '#FFFFFF', 'museum_done'),
    ]),
    page('museum_done', '03 预约 已完成', ink, '#FFFFFF', [
      text('museum_done_brand', 'WINGSPACE', 28, 72, 340, 28, 13, '#B9C0AF', { letterSpacing: 3 }),
      text('museum_done_title', '把这一天，留给自然。', 28, 154, 346, 98, 34, '#F4F1E9', { fontFamily: 'Songti SC', wrap: true, lineHeight: 46 }),
      box('museum_ticket', 28, 292, 346, 372, cream, { radius: 4 }),
      text('museum_ticket_label', '预约成功  /  ADMIT ONE', 52, 320, 298, 28, 12, red, { letterSpacing: 1 }),
      text('museum_ticket_title', '翼间 · 自然观察特展', 52, 372, 298, 32, 22, ink, { fontFamily: 'Songti SC' }),
      text('museum_ticket_date', '10 / 26', 52, 432, 298, 62, 48, ink, { fontFamily: 'Georgia' }),
      text('museum_ticket_time', '14:00—16:00   ·   1人', 52, 512, 298, 28, 16, ink),
      box('museum_ticket_rule', 52, 566, 298, 1, '#CACDC2'),
      text('museum_ticket_place', '城市自然馆 · 二层临展厅', 52, 592, 298, 26, 14, '#6C7166'),
      text('museum_ticket_hint', '到馆出示此凭证即可入场', 28, 696, 346, 28, 13, '#B9C0AF'),
      button('museum_home_back', '回到展览', 28, 770, 346, cream, ink, 'museum_home'),
    ]),
  ] };
  const blue = '#1D3DCE', navy = '#17203C', gray = '#6C748B', bg = '#F4F6FA';
  const equipment = { language: 'rp/1', target: 9, name: '借物 · 实验室设备', device: 'iphone-17-pro', palette: { bg, ink: navy, brand: blue }, pages: [
    page('equipment_home', '01 借物 设备', bg, navy, [
      text('equipment_wordmark', '借物', 28, 70, 200, 38, 27, navy, { fontWeight: 600 }),
      text('equipment_room', '光学实验室   A302', 28, 118, 346, 24, 13, gray),
      box('equipment_summary', 28, 166, 346, 106, blue, { radius: 20 }),
      text('equipment_summary_label', '今天有设备可借', 48, 186, 240, 24, 14, '#DDE5FF'),
      text('equipment_count', '03', 48, 218, 120, 42, 34, '#FFFFFF', { fontFamily: 'Georgia', lineHeight: 40 }),
      text('equipment_units', '件 / 无需排队', 148, 232, 200, 24, 13, '#DDE5FF'),
      text('equipment_list_title', '可借设备', 28, 308, 250, 30, 20, navy, { fontWeight: 600 }),
      ...['索尼 A7 IV', '尼康 10×42 望远镜', '三脚架 190X'].flatMap((name, i) => {
        const y = 362 + i * 142;
        return [box(`equipment_row_${i}`, 28, y, 346, 122, '#FFFFFF', { radius: 16, ...(i === 0 ? { on: link('equipment_detail') } : {}), children: [
          box(`equipment_tile_${i}`, 14, 18, 82, 86, '#EDF0F7', { radius: 12 }), optic(`equipment_icon_${i}`, 15, 28, 1, navy, '#8898E3', ['camera', 'binoculars', 'tripod'][i]),
          text(`equipment_name_${i}`, name, 114, 22, 210, 32, 17, navy, { fontWeight: 600 }),
          text(`equipment_code_${i}`, ['CAM-008 · 全画幅相机', 'BIN-014 · 户外观察', 'TRI-003 · 稳定支撑'][i], 114, 56, 210, 24, 11, gray),
          text(`equipment_status_${i}`, '● 可借  ·  最长7天', 114, 85, 210, 23, 11, '#20745D')] })];
      }),
      text('equipment_hint', '点击相机，查看借用详情', 28, 810, 346, 24, 12, gray),
    ]),
    page('equipment_detail', '02 相机 借用', bg, navy, [
      text('equipment_back', '←  设备', 28, 68, 160, 28, 15, navy, { on: link('equipment_home') }),
      box('equipment_detail_tile', 28, 124, 346, 190, '#E4EAFB', { radius: 22 }),
      optic('equipment_detail_icon', 110, 140, 2.3, navy, '#8496E9'),
      text('equipment_detail_title', '索尼 A7 IV', 28, 346, 346, 44, 30, navy, { fontWeight: 600 }),
      text('equipment_detail_code', 'CAM-008    /    状态良好', 28, 400, 346, 24, 13, gray),
      rule('equipment_rule', 448, '#DCE2ED'),
      text('equipment_spec', '全画幅 · 3300万像素 · 含镜头与电池', 28, 474, 346, 28, 14, navy),
      text('equipment_checkout', '借用周期', 28, 538, 346, 28, 13, gray),
      box('equipment_dates_bg', 28, 576, 346, 90, '#FFFFFF', { radius: 14 }),
      text('equipment_dates', '10月26日    →    11月02日', 48, 604, 306, 32, 19, navy, { fontWeight: 500 }),
      text('equipment_pickup', '领取地点  A302器材室 · 今日17:00前', 28, 700, 346, 30, 13, gray),
      button('equipment_borrow', '确认借用  ·  7天', 28, 770, 346, blue, '#FFFFFF', 'equipment_done'),
    ]),
    page('equipment_done', '03 借用 凭证', bg, navy, [
      text('equipment_done_brand', '借用已登记', 28, 70, 346, 34, 18, navy, { fontWeight: 600 }),
      box('equipment_check_bg', 159, 154, 84, 84, '#DEEEE7', { radius: 42 }),
      text('equipment_check', '✓', 176, 167, 50, 54, 35, '#20745D', { align: 'center' }),
      text('equipment_done_title', '准备好，出发观察。', 28, 280, 346, 44, 28, navy, { fontWeight: 600 }),
      para('equipment_done_desc', '带上学生证，到器材室领取设备。\n请在归还前检查配件是否齐全。', 28, 344, 346, 70, 15, gray, { lineHeight: 29 }),
      box('equipment_receipt', 28, 464, 346, 236, '#FFFFFF', { radius: 20 }),
      text('equipment_receipt_label', 'BORROWING RECEIPT', 48, 488, 306, 24, 11, gray, { letterSpacing: 1 }),
      text('equipment_receipt_item', '索尼 A7 IV', 48, 534, 306, 34, 21, navy, { fontWeight: 600 }),
      text('equipment_due_label', '请于以下时间归还', 48, 592, 306, 24, 12, gray),
      text('equipment_due', '11月02日  17:00', 48, 630, 306, 36, 24, blue, { fontFamily: 'Georgia' }),
      button('equipment_home_back', '回到设备', 28, 770, 346, blue, '#FFFFFF', 'equipment_home'),
    ]),
  ] };
  const paper = '#F7F3EA', purple = '#513F72', muted = '#7F7589';
  const learning = { language: 'rp/1', target: 9, name: '拾知 · 每日一张', device: 'iphone-17-pro', palette: { bg: paper, ink: '#302938', brand: purple }, pages: [
    page('learning_home', '01 拾知 今日', paper, '#302938', [
      text('learning_brand', '拾知  /  DAILY RECALL', 28, 70, 346, 30, 15, purple, { fontWeight: 600 }),
      text('learning_date', 'MONDAY, OCT 26', 28, 130, 346, 24, 11, muted, { letterSpacing: 1.5 }),
      para('learning_head', '记住一点，\n就向前一点。', 28, 174, 346, 116, 40, '#302938', { fontFamily: 'Songti SC', lineHeight: 53 }),
      box('learning_orbit', 242, 310, 130, 130, '#E8DDC8', { radius: 65 }),
      box('learning_orbit_inner', 277, 345, 60, 60, paper, { radius: 30 }),
      text('learning_count', '01', 28, 326, 210, 94, 68, purple, { fontFamily: 'Georgia', lineHeight: 90 }),
      text('learning_count_label', '张待复习 · 约1分钟', 28, 432, 346, 26, 14, muted),
      rule('learning_rule', 500, '#DDD3C4'),
      text('learning_subject', '计算机网络', 28, 536, 346, 32, 20, '#302938', { fontWeight: 600 }),
      para('learning_preview', '今天，把“三次握手”\n讲给自己听。', 28, 588, 346, 80, 23, purple, { fontFamily: 'Songti SC', lineHeight: 35 }),
      text('learning_method', '先回忆，再翻面。答错也没关系。', 28, 706, 346, 26, 13, muted),
      button('learning_start', '开始这张卡片    →', 28, 770, 346, purple, '#FFFFFF', 'learning_card'),
    ]),
    page('learning_card', '02 回忆 与翻面', paper, '#302938', [
      text('learning_back', '←  今日', 28, 70, 160, 28, 15, purple, { on: link('learning_home') }),
      text('learning_progress', '01 / 01', 278, 72, 96, 28, 14, muted, { align: 'right' }),
      box('learning_progress_track', 28, 126, 346, 3, '#DCD2E7'),
      box('learning_progress_done', 28, 126, 173, 3, purple),
      text('learning_card_label', '计算机网络   ·   连接管理', 28, 174, 346, 26, 12, muted),
      para('learning_question', 'TCP 为什么需要\n三次握手？', 28, 228, 346, 120, 34, '#302938', { fontFamily: 'Songti SC', lineHeight: 48 }),
      box('learning_answer_bg', 28, 390, 346, 238, '#EAE2F0', { radius: 20, visible: false }),
      para('learning_answer', '确认双方的发送与接收能力，\n并同步初始序列号。\n\n第三次确认，使服务端知道：\n客户端已收到自己的响应。', 48, 414, 306, 190, 17, purple, { lineHeight: 30, visible: false }),
      para('learning_prompt', '先试着用自己的话回答。\n准备好后，翻开答案。', 28, 432, 346, 100, 17, muted, { lineHeight: 30 }),
      { ...button('learning_flip', '翻开答案', 28, 664, 346, '#EAE2F0', purple, 'learning_card'), on: { click: [
        { type: 'show', target: 'learning_answer_bg' }, { type: 'show', target: 'learning_answer' }, { type: 'hide', target: 'learning_prompt' }, { type: 'show', target: 'learning_remember' }, { type: 'hide', target: 'learning_flip' },
      ] } },
      { ...button('learning_remember', '我记住了    ✓', 28, 770, 346, purple, '#FFFFFF', 'learning_done'), visible: false },
    ]),
    page('learning_done', '03 今日 完成', purple, paper, [
      text('learning_done_label', 'TODAY, WELL LEARNED.', 28, 74, 346, 26, 11, '#D5C7E4', { letterSpacing: 1.5 }),
      text('learning_done_number', '1', 28, 170, 346, 164, 72, paper, { fontFamily: 'Georgia', lineHeight: 96 }),
      text('learning_done_unit', '张卡片，留在脑海里。', 28, 360, 346, 40, 23, paper, { fontFamily: 'Songti SC' }),
      box('learning_done_rule', 28, 446, 346, 1, '#817092'),
      para('learning_done_desc', '今天的复习完成了。\n合上页面，让知识慢慢生根。', 28, 488, 346, 92, 21, '#E8DFF0', { fontFamily: 'Songti SC', lineHeight: 37 }),
      text('learning_done_hint', '本次已完成：计算机网络 · 三次握手', 28, 696, 346, 28, 13, '#D5C7E4'),
      button('learning_home_back', '回到今日', 28, 770, 346, paper, purple, 'learning_home'),
    ]),
  ] };
  const sources = { museum, equipment, learning };
  for (const [name, source] of Object.entries(sources)) writeFileSync(join(outputDir, `${name}.json`), JSON.stringify(source, null, 2));
  return sources;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) buildTransferSources();
