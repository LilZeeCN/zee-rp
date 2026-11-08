# rplang:scripts/rp_language.py 的拆分包(2026-11-08)。

from . import core as _core
from . import frontend as _frontend
from . import runtime as _runtime
from . import tail as _tail

for _n in dir(_core):
    if not _n.startswith('__'):
        globals()[_n] = getattr(_core, _n)
for _n in dir(_frontend):
    if not _n.startswith('__'):
        globals()[_n] = getattr(_frontend, _n)
for _n in dir(_runtime):
    if not _n.startswith('__'):
        globals()[_n] = getattr(_runtime, _n)
for _n in dir(_tail):
    if not _n.startswith('__'):
        globals()[_n] = getattr(_tail, _n)
