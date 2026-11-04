"""speedrun 图标的源文件：所有参数都在这里，只用 python3 标准库。

运行 `python3 brand/icon.py` 生成 brand/icon.svg；出扩展 PNG 用 `node brand/make-icons.mjs`（会先跑这个脚本）。
设计依据和参数含义见 brand/icon.md。
"""
from pathlib import Path

# 画布
SIZE = 128
RX = 30          # 圆角半径
CENTER = (64, 64)  # S 关于这一点中心对称

# S 的中心线：均匀三次 B 样条，只写上半段（从左外侧到中心之前），另一半由中心对称得到
TERMINAL_Y = 104   # 底边那一笔的高度；顶边是 128 - 104 = 24
BOWL_IN = (86, 108)  # 下弯起弯处的控制点
BOWL_OUT = (116, 72)  # 下弯最外侧的控制点，决定弯的宽度和中横的斜度
HALF = [(-90, TERMINAL_Y), (-40, TERMINAL_Y), (10, TERMINAL_Y), BOWL_IN, BOWL_OUT]
STROKE = 25        # 白线宽度，约占画布 20%

# 配色：赛车红 · 墨黑。每块一条两色渐变，坐标在画布坐标系里
RED = ("#FF3B30", "#D7001A", (10, 0), (90, 90))      # 左上区域
INK = ("#0B0B0E", "#26262C", (128, 60), (40, 128))   # 右下区域
LINE = "#FFFFFF"


def control_points():
    cx, cy = CENTER
    mirror = [(2 * cx - x, 2 * cy - y) for x, y in reversed(HALF)]
    return HALF + [CENTER] + mirror


def bspline_to_bezier(pts):
    """均匀三次 B 样条逐段换成三次贝塞尔：曲率连续（C2），整条线没有接缝。"""
    r = lambda v: f"{round(v, 2):g}"
    segs = []
    for i in range(len(pts) - 3):
        p0, p1, p2, p3 = pts[i:i + 4]
        b0 = [(p0[k] + 4 * p1[k] + p2[k]) / 6 for k in (0, 1)]
        b1 = [(2 * p1[k] + p2[k]) / 3 for k in (0, 1)]
        b2 = [(p1[k] + 2 * p2[k]) / 3 for k in (0, 1)]
        b3 = [(p1[k] + 4 * p2[k] + p3[k]) / 6 for k in (0, 1)]
        if not segs:
            segs.append(f"M{r(b0[0])} {r(b0[1])}")
        segs.append(f"C{r(b1[0])} {r(b1[1])} {r(b2[0])} {r(b2[1])} {r(b3[0])} {r(b3[1])}")
    return " ".join(segs)


def gradient(gid, spec):
    a, b, (x1, y1), (x2, y2) = spec
    return (f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">'
            f'<stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>')


def svg():
    s = bspline_to_bezier(control_points())
    # 左上区域：沿 S 从左外侧走到右外侧，再绕画布外的左上方回来
    upper = f"{s} L200 -60 L-60 -60 Z"
    return f"""<!-- speedrun 图标：整个图标面就是一个 S。由 brand/icon.py 生成，不要手改；设计说明见 brand/icon.md。 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}">
  <defs>
    {gradient("red", RED)}
    {gradient("ink", INK)}
    <clipPath id="tile"><rect width="{SIZE}" height="{SIZE}" rx="{RX}"/></clipPath>
  </defs>
  <g clip-path="url(#tile)">
    <rect width="{SIZE}" height="{SIZE}" fill="url(#ink)"/>
    <path d="{upper}" fill="url(#red)"/>
    <path d="{s}" fill="none" stroke="{LINE}" stroke-width="{STROKE}" stroke-linecap="round"/>
  </g>
</svg>
"""


if __name__ == "__main__":
    out = Path(__file__).with_name("icon.svg")
    out.write_text(svg())
    print(f"wrote {out}")
