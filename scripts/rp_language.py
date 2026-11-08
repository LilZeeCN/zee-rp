"""RP/1 semantic frontend. Pure JSON in -> checked IR and legacy layout spec out.

No eval, GUI, filesystem reads, or implicit record defaults. References are
resolved before native generation; IDs describe source identity, not native GUIDs.
"""

# 2026-11-08 RP/1 编译链拆分:实现整体迁入 scripts/rplang/(按依赖序原样迁移),
# 本文件为 facade——镜像全部顶层名,`from rp_language import X` 消费面不变。
import rplang as _pkg

for _n in dir(_pkg):
    if _n.startswith('__'):
        continue
    globals()[_n] = getattr(_pkg, _n)