# proto_engine:scripts/proto.py 的拆分包(2026-11-08)。
# __init__ 按原文件节序镜像全部顶层名,import proto 的属性面与单体时代逐名一致。

from . import fonts as _fonts
from . import tokens as _tokens
from . import expander as _expander
from . import layout as _layout
from . import audit as _audit
from . import builder as _builder
from . import compiler as _compiler

for _n in dir(_fonts):
    if not _n.startswith("__"):
        globals()[_n] = getattr(_fonts, _n)
for _n in dir(_tokens):
    if not _n.startswith("__"):
        globals()[_n] = getattr(_tokens, _n)
for _n in dir(_expander):
    if not _n.startswith("__"):
        globals()[_n] = getattr(_expander, _n)
for _n in dir(_layout):
    if not _n.startswith("__"):
        globals()[_n] = getattr(_layout, _n)
for _n in dir(_audit):
    if not _n.startswith("__"):
        globals()[_n] = getattr(_audit, _n)
for _n in dir(_builder):
    if not _n.startswith("__"):
        globals()[_n] = getattr(_builder, _n)
for _n in dir(_compiler):
    if not _n.startswith("__"):
        globals()[_n] = getattr(_compiler, _n)
