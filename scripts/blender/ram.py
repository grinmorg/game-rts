"""
Rookfall's battering ram, modelled in Blender and exported as glTF for the client.

    blender --background --python scripts/blender/ram.py -- --out models/custom --render /tmp/ram

Shared helpers and the conventions the client relies on (part ids from material names, game space vs
Blender space, the palette) live in common.py next to this file. Unlike the catapult, nothing here turns
around a pivot: the log is part 9, which the vertex shader thrusts straight forward along +z on a blow,
so it may sit wherever it looks right.
"""

import math
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from common import *  # noqa: F403  (Blender runs this file as a lone script, not as part of a package)

LOG_Y = 0.50        # the log hangs at this height - high enough to read from the match camera
LOG_BACK = -0.46    # its butt end
LOG_HEAD = 0.62     # the iron head, out in front of the frame


def build(iron):
    mats = Mats(SECOND if iron else FIRST)
    colls = collections('Frame', 'Log', 'Wheels', 'Canopy', 'Banner')
    F, L, WH, C, B = colls['Frame'], colls['Log'], colls['Wheels'], colls['Canopy'], colls['Banner']

    # ---- chassis: two side rails on the wheels, cross beams at both ends, a plank deck between them
    for s in (-1, 1):
        beam(f'Rail{s}', (s * 0.26, 0.23, -0.50), (s * 0.26, 0.23, 0.50), 0.055, mats('Wood'), F)
    for i, z in enumerate((-0.44, 0.44)):
        box(f'Cross{i}', (0.70, 0.10, 0.12), (0, 0.24, z), mats('Dark'), F)
    for i, z in enumerate((-0.26, -0.06, 0.14, 0.34)):
        box(f'Plank{i}', (0.52, 0.03, 0.14), (0, 0.295, z), mats('Dark'), F)
    # iron corner straps, doubled up once the second age has the metal to spare
    for s in (-1, 1):
        for zs in (-1, 1):
            box(f'Strap{s}{zs}', (0.125, 0.135, 0.045), (s * 0.26, 0.23, zs * 0.40), mats('Metal'), F)
            if iron:
                box(f'Strap2{s}{zs}', (0.125, 0.135, 0.04), (s * 0.26, 0.23, zs * 0.16), mats('Metal'), F)

    # ---- the frame the log swings under: four uprights carrying a ridge beam down the middle
    for s in (-1, 1):
        for zs in (-1, 1):
            beam(f'Post{s}{zs}', (s * 0.26, 0.28, zs * 0.34), (s * 0.21, 0.82, zs * 0.30), 0.042, mats('Wood'), F, half2=0.034)
        beam(f'Brace{s}', (s * 0.26, 0.30, -0.34), (s * 0.22, 0.76, 0.28), 0.024, mats('Dark'), F)
    strut('Ridge', (0.0, 0.84, -0.36), (0.0, 0.84, 0.36), 0.05, 0.05, 8, mats('Wood'), F, smooth=True)
    for s in (-1, 1):
        box(f'RidgeCap{s}', (0.46, 0.07, 0.09), (0, 0.83, s * 0.31), mats('Dark'), F)

    # ---- the log itself (part 9): a tapered timber, iron-banded, with a ram's head on the front
    beam('Log', (0.0, LOG_Y, LOG_BACK), (0.0, LOG_Y, LOG_HEAD - 0.12), 0.085, mats('Wood', 'Log'), L, half2=0.072)
    for i, z in enumerate((-0.30, -0.06, 0.22)):
        ring(f'LogBand{i}', (0.0, LOG_Y, z), 0.095, 0.018, mats('Metal', 'Log'), L, 10, 4, normal=(0, 0, 1))
    strut('LogHead', (0.0, LOG_Y, LOG_HEAD - 0.16), (0.0, LOG_Y, LOG_HEAD), 0.105, 0.075, 10,
          mats('Metal', 'Log'), L, smooth=True)
    # a pair of blunt horns on the head - this is a ram, and from above that is the only way to tell
    for s in (-1, 1):
        strut(f'Horn{s}', (s * 0.055, LOG_Y + 0.045, LOG_HEAD - 0.05), (s * 0.105, LOG_Y + 0.02, LOG_HEAD + 0.07),
              0.032, 0.014, 6, mats('Metal' if iron else 'Steel', 'Log'), L, smooth=True)
    box('LogButt', (0.16, 0.16, 0.06), (0.0, LOG_Y, LOG_BACK - 0.02), mats('Dark', 'Log'), L)
    # the ropes it hangs on, from the ridge beam down to the bands
    for z in (-0.30, 0.22):
        for s in (-1, 1):
            strut(f'Rope{z}{s}', (s * 0.02, 0.82, z), (s * 0.09, LOG_Y + 0.02, z), 0.013, 0.013, 5, mats('Rope', 'Log'), L)

    # ---- canopy over the rear third only: the crew has somewhere to stand and the log stays in plain
    # sight, which is what the match camera is looking down at
    for s in (-1, 1):
        box(f'Roof{s}', (0.30, 0.035, 0.34), (s * 0.145, 0.80, -0.24), mats('Team'), C,
            rot=(0, 0, math.radians(s * 18)))
    for i, z in enumerate((-0.38, -0.14)):
        strut(f'Batten{i}', (-0.28, 0.805, z), (0.28, 0.805, z), 0.018, 0.018, 4, mats('Dark'), C)
    # a short hide apron on each flank of the covered part, low enough not to swallow the wheels
    for s in (-1, 1):
        box(f'Hide{s}', (0.03, 0.22, 0.32), (s * 0.265, 0.62, -0.24), mats('Leather'), C)

    # ---- team colours: the roof above carries most of it, a pennant and a front board carry the rest
    beam('Pole', (0.0, 0.80, -0.40), (0.0, 1.12, -0.40), 0.018, mats('Dark'), B)
    strut('PoleTip', (0.0, 1.12, -0.40), (0.0, 1.18, -0.40), 0.030, 0.0, 6, mats('Metal'), B)
    cloth('Pennant', (0.005, 1.08, -0.395), (0.0, 0, -0.26), 0.20, mats('Team'), B, amp=0.06)
    # a mantlet on the front posts, set low so it shields the crew without hiding the head
    box('Board', (0.42, 0.17, 0.03), (0, 0.42, 0.365), mats('Team'), B, rot=(math.radians(-28), 0, 0))
    for s in (-1, 1):
        box(f'BoardTrim{s}', (0.045, 0.19, 0.038), (s * 0.225, 0.42, 0.365), mats('Dark'), B, rot=(math.radians(-28), 0, 0))

    # ---- wheels (part 5): spoked timber, iron-tyred in the second age
    for sx in (-1, 1):
        for sz in (-1, 1):
            c = (sx * 0.38, 0.16, sz * 0.32)
            tag = f'{"L" if sx < 0 else "R"}{"B" if sz < 0 else "F"}'
            ring(f'Rim{tag}', c, 0.125, 0.034, mats('Metal' if iron else 'Wood', 'Wheel'), WH, 12, 4)
            strut(f'Hub{tag}', (c[0] - 0.05, c[1], c[2]), (c[0] + 0.05, c[1], c[2]), 0.046, 0.046, 8,
                  mats('Metal', 'Wheel'), WH, smooth=True)
            for k in range(6):
                a = k * math.pi / 3
                p1 = (c[0], c[1] + math.sin(a) * 0.126, c[2] + math.cos(a) * 0.126)
                beam(f'Spoke{tag}{k}', c, p1, 0.018, mats('Wood', 'Wheel'), WH)


def thrust(dist):
    """Slide the log forward the way the renderer's shader does (part 9 along +z) - the preview renders use
    it to check that the head clears the frame at full stroke."""
    import bpy
    from mathutils import Matrix
    m = Matrix.Translation(to_bl_dir((0.0, 0.0, dist)))
    for o in bpy.data.collections['Log'].objects:
        o.matrix_world = m @ o.matrix_world


def main():
    import bpy
    out = arg('--out', 'models/custom')
    preview = arg('--render')
    pose = float(arg('--pose', 0.0))
    os.makedirs(os.path.abspath(out), exist_ok=True)
    for age, iron in (('FirstAge', False), ('SecondAge', True)):
        reset_scene()
        build(iron)
        if pose:
            thrust(pose)
        cam = add_preview_gear()
        if not pose:
            bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(os.path.join(out, f'Ram_{age}.blend')))
            join_by_material()
            export(os.path.join(out, f'Ram_{age}.glb'))
        if preview:
            render(cam, f'{preview}_{age}_persp', (2.0, 1.5, -2.2))
            render(cam, f'{preview}_{age}_side', (2.6, 0.7, 0.0))
            render(cam, f'{preview}_{age}_front', (0.1, 0.8, 2.6))
            # the match camera: 55 degrees above the horizon, looking from +Z (see camera.ts)
            render(cam, f'{preview}_{age}_game', (1.4, 3.7, 2.6))
        print(f'[ram] {age}: {len(bpy.data.objects)} objects, {triangles()} triangles')


main()
