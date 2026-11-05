"""speedrun 图标的源文件：所有参数都在这里，只用 python3 标准库。

运行 `python3 brand/icon.py` 生成 brand/icon.svg；出扩展 PNG 用 `node brand/make-icons.mjs`（会先跑这个脚本）。
设计依据和参数含义见 brand/icon.md。
"""
from pathlib import Path

# 画布
SIZE = 128
RX = 30          # 圆角半径
CENTER = (64, 64)  # 图形关于这一点中心对称

# 闪电 S 的轮廓：只写前一半的 4 个顶点，另一半由中心对称得到
HALF = [
    (112, 12),  # 右上尖角
    (44, 12),   # 顶边左端
    (18, 70),   # 左侧最外点
    (76, 70),   # 左下缺口的最深处，x 越大缺口越深、越像 S
]

# 配色：闪电黄 · 墨黑，都是纯色
YELLOW = "#FFD60A"  # 底色
INK = "#17171C"     # 闪电 S


def outline():
    cx, cy = CENTER
    return HALF + [(2 * cx - x, 2 * cy - y) for x, y in HALF]


def svg():
    points = " ".join(f"{x},{y}" for x, y in outline())
    return f"""<!-- speedrun 图标：一个折成闪电的 S。由 brand/icon.py 生成，不要手改；设计说明见 brand/icon.md。 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}">
  <rect width="{SIZE}" height="{SIZE}" rx="{RX}" fill="{YELLOW}"/>
  <polygon points="{points}" fill="{INK}"/>
</svg>
"""


if __name__ == "__main__":
    out = Path(__file__).with_name("icon.svg")
    out.write_text(svg())
    print(f"wrote {out}")
