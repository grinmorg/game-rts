"""
Rookfall's catapult, modelled in Blender and exported as glTF for the client.

    blender --background --python scripts/blender/catapult.py -- --out models/custom --render /tmp/cat

Shared helpers and the conventions the client relies on (part ids from material names, game space vs
Blender space, the palette) live in common.py next to this file. The throwing arm turns around the axle
at PIVOT, which the renderer's vertex shader hard-codes for part 6 - move it here and the swing breaks.
"""

import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from common import *  # noqa: F403  (Blender runs this file as a lone script, not as part of a package)

PIVOT = (0.0, 0.30, 0.20)
ARM_TIP = (0.0, 0.46, -0.80)


def build(iron):
    mats = Mats(SECOND if iron else FIRST)
    colls = collections('Frame', 'Winch', 'Arm', 'Wheels', 'Banner')
    F, W, A, WH, B = colls['Frame'], colls['Winch'], colls['Arm'], colls['Wheels'], colls['Banner']

    # ---- chassis: two side rails, cross beams at both ends, a plank deck over the front half
    for s in (-1, 1):
        beam(f'Rail{s}', (s * 0.28, 0.25, -0.54), (s * 0.28, 0.25, 0.54), 0.058, mats('Wood'), F)
    box('BeamFront', (0.74, 0.11, 0.13), (0, 0.26, 0.46), mats('Dark'), F)
    box('BeamRear', (0.74, 0.11, 0.13), (0, 0.26, -0.46), mats('Dark'), F)
    for i, z in enumerate((0.30, 0.41, 0.52)):
        box(f'Plank{i}', (0.50, 0.03, 0.09), (0, 0.325, z), mats('Dark'), F)
    for i, z in enumerate((-0.10, 0.06)):
        box(f'Tie{i}', (0.50, 0.055, 0.085), (0, 0.235, z), mats('Dark'), F)
    # iron corner straps - the second age wraps the whole chassis in them
    for s in (-1, 1):
        for zs in (-1, 1):
            box(f'Strap{s}{zs}', (0.13, 0.145, 0.045), (s * 0.28, 0.25, zs * 0.44), mats('Metal'), F)
            if iron:
                box(f'Strap2{s}{zs}', (0.13, 0.145, 0.04), (s * 0.28, 0.25, zs * 0.2), mats('Metal'), F)

    # ---- torsion assembly: the rope skein the arm is sprung from, on two blocks over the rails
    for s in (-1, 1):
        box(f'SkeinBlock{s}', (0.11, 0.22, 0.20), (s * 0.28, 0.27, PIVOT[2]), mats('Wood'), F)
        strut(f'SkeinWasher{s}', (s * 0.245, PIVOT[1], PIVOT[2]), (s * 0.20, PIVOT[1], PIVOT[2]),
              0.095, 0.095, 10, mats('Metal'), F, smooth=True)
        strut(f'Skein{s}', (s * 0.205, PIVOT[1], PIVOT[2]), (s * 0.075, PIVOT[1], PIVOT[2]),
              0.082, 0.082, 10, mats('Rope'), F, smooth=True)
        for i in range(2):
            ring(f'SkeinWrap{s}{i}', (s * (0.10 + i * 0.07), PIVOT[1], PIVOT[2]), 0.083, 0.016, mats('Rope'), F, 8, 3)
        # tensioning bar sticking out of the washer
        box(f'Tension{s}', (0.03, 0.03, 0.22), (s * 0.245, PIVOT[1] + 0.02, PIVOT[2] + 0.02), mats('Metal'), F)

    # ---- A-frame: the uprights and the padded beam the arm slams into at the top of its swing
    for s in (-1, 1):
        beam(f'Post{s}', (s * 0.28, 0.28, 0.36), (s * 0.26, 1.00, 0.30), 0.045, mats('Wood'), F, half2=0.036)
        beam(f'Brace{s}', (s * 0.28, 0.30, -0.12), (s * 0.265, 0.80, 0.265), 0.028, mats('Dark'), F)
    strut('Stopper', (-0.30, 0.98, 0.30), (0.30, 0.98, 0.30), 0.062, 0.062, 10, mats('Wood'), F, smooth=True)
    for s in (-1, 1):
        ring(f'StopperPad{s}', (s * 0.11, 0.98, 0.30), 0.072, 0.026, mats('Rope'), F, 10, 5)

    # ---- winch: the drum the arm is cocked down to, in iron bearings on the rear of the rails
    strut('Drum', (-0.25, 0.28, -0.44), (0.25, 0.28, -0.44), 0.058, 0.058, 10, mats('Dark'), W, smooth=True)
    for i in range(5):
        ring(f'DrumRope{i}', (-0.13 + i * 0.065, 0.28, -0.44), 0.064, 0.016, mats('Rope'), W, 8, 3)
    for s in (-1, 1):
        box(f'WinchBearing{s}', (0.10, 0.16, 0.12), (s * 0.28, 0.28, -0.44), mats('Metal'), W)
    # ratchet, pawl and crank on the right-hand end, outboard of the rail where they can be seen
    strut('Ratchet', (0.29, 0.28, -0.44), (0.315, 0.28, -0.44), 0.095, 0.095, 12, mats('Metal'), W)
    beam('Pawl', (0.315, 0.47, -0.52), (0.315, 0.34, -0.45), 0.014, mats('Metal'), W)
    beam('Crank', (0.34, 0.28, -0.44), (0.34, 0.42, -0.44), 0.021, mats('Metal'), W)
    strut('Handle', (0.33, 0.42, -0.44), (0.44, 0.42, -0.44), 0.024, 0.024, 6, mats('Dark'), W, smooth=True)
    # the cocking rope, off the drum and up to the hook under the arm
    strut('Rope', (0.0, 0.34, -0.44), (0.0, 0.40, -0.68), 0.013, 0.013, 5, mats('Rope'), W)

    # ---- throwing arm (part 6): tapered beam, iron collar at the axle, bucket and boulder at the tip
    beam('Arm', (0.0, 0.295, 0.31), ARM_TIP, 0.062, mats('Wood', 'Arm'), A, half2=0.040)
    strut('ArmCollar', (-0.075, PIVOT[1], PIVOT[2]), (0.075, PIVOT[1], PIVOT[2]), 0.085, 0.085, 8, mats('Metal', 'Arm'), A)
    for i, t in enumerate((0.35, 0.62)):
        p = tuple(PIVOT[k] + (ARM_TIP[k] - PIVOT[k]) * t for k in range(3))
        box(f'ArmStrap{i}', (0.115, 0.03, 0.06), (p[0], p[1], p[2]), mats('Metal', 'Arm'), A)
    # the bucket sits across the arm, opening up and slightly back
    strut('Bucket', (0.0, 0.455, -0.795), (0.0, 0.615, -0.835), 0.048, 0.115, 10, mats('Dark', 'Arm'), A)
    ring('BucketBand', (0.0, 0.585, -0.827), 0.105, 0.015, mats('Metal', 'Arm'), A, 10, 3, normal=(0, 1, 0))
    rock('Boulder', (0.0, 0.575, -0.822), 0.082, mats('Stone', 'Arm'), A)
    box('ArmHook', (0.05, 0.055, 0.05), (0.0, 0.385, -0.685), mats('Metal', 'Arm'), A)

    # ---- wheels (part 5): spoked, hubbed, iron-tyred in the second age
    for sx in (-1, 1):
        for sz in (-1, 1):
            c = (sx * 0.42, 0.17, sz * 0.36)
            tag = f'{"L" if sx < 0 else "R"}{"B" if sz < 0 else "F"}'
            # the second age runs on steel-shod wheels, the first on bare timber
            ring(f'Rim{tag}', c, 0.134, 0.036, mats('Metal' if iron else 'Wood', 'Wheel'), WH, 12, 4)
            strut(f'Hub{tag}', (c[0] - 0.055, c[1], c[2]), (c[0] + 0.055, c[1], c[2]), 0.05, 0.05, 8,
                  mats('Metal', 'Wheel'), WH, smooth=True)
            for k in range(6):
                a = k * math.pi / 3
                p1 = (c[0], c[1] + math.sin(a) * 0.135, c[2] + math.cos(a) * 0.135)
                beam(f'Spoke{tag}{k}', c, p1, 0.019, mats('Wood', 'Wheel'), WH)

    # ---- team colours: a banner at the back corner and a painted board on the front beam
    beam('Pole', (0.30, 0.28, -0.30), (0.30, 0.98, -0.30), 0.019, mats('Dark'), B)
    strut('PoleTip', (0.30, 0.98, -0.30), (0.30, 1.04, -0.30), 0.032, 0.0, 6, mats('Metal'), B)
    cloth('Banner', (0.305, 0.93, -0.295), (-0.157, 0, -0.256), 0.26, mats('Team'), B, amp=0.07)
    # a mantlet leaning off the front beam: the flat the top-down camera sees most of the team colour on
    box('Board', (0.47, 0.25, 0.025), (0, 0.40, 0.47), mats('Team'), B, rot=(math.radians(-42), 0, 0))
    for s in (-1, 1):
        box(f'BoardTrim{s}', (0.04, 0.28, 0.035), (s * 0.27, 0.40, 0.47), mats('Dark'), B, rot=(math.radians(-42), 0, 0))


def pose_arm(angle):
    """Swing the arm the way the renderer's shader does (rotate part 6 around the axle) - used by the preview
    renders to check that the arm clears the frame and comes to rest against the padded beam."""
    piv = to_bl(PIVOT)
    m = Matrix.Translation(piv) @ Matrix.Rotation(angle, 4, 'X') @ Matrix.Translation(-piv)
    for o in bpy.data.collections['Arm'].objects:
        o.matrix_world = m @ o.matrix_world


def main():
    out = arg('--out', 'models/custom')
    preview = arg('--render')
    pose = float(arg('--pose', 0.0))
    os.makedirs(os.path.abspath(out), exist_ok=True)
    for age, iron in (('FirstAge', False), ('SecondAge', True)):
        reset_scene()
        build(iron)
        if pose:
            pose_arm(pose)
        cam = add_preview_gear()
        if not pose:
            bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(os.path.join(out, f'Catapult_{age}.blend')))
            join_by_material()
            export(os.path.join(out, f'Catapult_{age}.glb'))
        if preview:
            render(cam, f'{preview}_{age}_persp', (2.0, 1.5, -2.2))
            render(cam, f'{preview}_{age}_side', (2.6, 0.7, 0.0))
            render(cam, f'{preview}_{age}_wide', (3.8, 1.6, 0.0), target=(0, 1.0, -0.1))
            render(cam, f'{preview}_{age}_front', (0.1, 0.8, 2.6))
            # the match camera: 55 degrees above the horizon, looking from +Z (see camera.ts)
            render(cam, f'{preview}_{age}_game', (1.4, 3.7, 2.6))
            render(cam, f'{preview}_{age}_gameback', (-1.4, 3.7, -2.9))
        print(f'[catapult] {age}: {len(bpy.data.objects)} objects, {triangles()} triangles')


main()
