"""
Rookfall's units, modelled in Blender and exported as glTF for the client.

    blender --background --python scripts/blender/units.py -- --out models/custom --render /tmp/units

`--only <Name>` builds a single unit, `--loaded` previews the worker with his load of gold instead of his pick.

Every unit exists twice: the first age in cloth, leather and plain steel, the second in iron (`iron=True`).
Shared helpers, the palette and the part-id convention live in common.py next to this file - in short, a
material named `LegA_*`/`LegB_*` is a leg, `Right_*`/`Left_*` an arm with whatever it holds, and `Team` is
replaced by the player's colour. The loader takes the two animation pivots from those parts' bounding
boxes, so legs must start at the hip and arms at the shoulder.

The attack animation swings the right arm forward and up, so a weapon is posed low and forward at rest:
that way the swing reads as a blow rather than a wind-up.
"""

import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from common import *  # noqa: F403  (Blender runs this file as a lone script, not as part of a package)

# proportions of a foot unit, in game units - about 0.8 tall, which the renderer scales by UNIT_SCALE
HIP = 0.25          # legs turn around here (parts 1/2)
SHOULDER = 0.53     # arms turn around here (parts 3/4)
HAND = (0.168, 0.285, 0.03)
PARTS = ('Body', 'LegA', 'LegB', 'Right', 'Left')


def armour(iron):
    """(plate, fittings): plain steel with dark fittings in the first age, bright iron over steel in the second."""
    return ('Metal', 'Steel') if iron else ('Steel', 'Metal')


def body(m, C, *, tunic, trouser, boot, sleeve=None, glove='Skin', skin='Skin',
         right_to=None, left_to=None, chest=(0.265, 0.175)):
    """Legs, torso, neck, head and two arms. `right_to`/`left_to` move a hand somewhere else than hanging
    at the side - an archer draws a string, a worker grips a shaft."""
    sleeve = sleeve or tunic
    joint('Hip', (0, HIP, 0))
    joint('Shoulder', (0, SHOULDER, 0))
    for side, part in ((-1, 'LegA'), (1, 'LegB')):
        x, coll = side * 0.062, C[part]
        limb(f'{part}Leg', (x, HIP, 0.0), (x, 0.07, 0.008), (0.088, 0.105), (0.072, 0.088), m(trouser, part), coll)
        box(f'{part}Boot', (0.098, 0.07, 0.155), (x, 0.035, 0.025), m(boot, part), coll)
    limb('Torso', (0, 0.21, 0.0), (0, 0.56, 0.006), (0.215, 0.145), chest, m(tunic), C['Body'])
    box('Belt', (0.235, 0.05, 0.16), (0, 0.295, 0.004), m('Leather'), C['Body'])
    limb('Neck', (0, 0.53, 0.0), (0, 0.62, 0.004), (0.085, 0.085), (0.08, 0.08), m(skin), C['Body'])
    ball('Head', (0, 0.685, 0.008), 0.098, m(skin), C['Body'], segs=8, rings=5, squash=(1, 1.08, 1.02))
    for side, part in ((1, 'Right'), (-1, 'Left')):
        x, coll = side * 0.168, C[part]
        to = (right_to if side > 0 else left_to) or (x * 1.04, 0.31, 0.03)
        limb(f'{part}Arm', (x, SHOULDER, 0.006), to, (0.078, 0.09), (0.062, 0.072), m(sleeve, part), coll)
        hand(m, coll, f'{part}Hand', (x, SHOULDER, 0.006), to, m(glove, part))


def hand(m, coll, name, shoulder, wrist, mat):
    """A fist on the end of an arm: it carries on in the arm's own direction so no gap can open at the wrist."""
    d = Vector(to_bl(wrist)) - Vector(to_bl(shoulder))
    d = d.normalized() * 0.028 if d.length > 1e-5 else Vector((0, 0, -0.028))
    box(name, (0.07, 0.072, 0.078), (wrist[0] + d.x, wrist[1] + d.z, wrist[2] - d.y), mat, coll)


def helmet(m, C, plate, fit, *, crest=True, brow=True):
    ball('Helm', (0, 0.702, 0.006), 0.107, m(plate), C['Body'], segs=8, rings=4, squash=(1, 1.04, 1.02))
    if brow:
        ring('HelmBrow', (0, 0.665, 0.006), 0.101, 0.017, m(fit), C['Body'], 10, 4, normal=(0, 1, 0))
        box('HelmNasal', (0.03, 0.105, 0.03), (0, 0.672, 0.098), m(fit), C['Body'])
    if crest:
        box('Crest', (0.03, 0.075, 0.19), (0, 0.795, -0.005), m('Team'), C['Body'])


def round_shield(m, C, r, face, rim, *, center=(-0.263, 0.40, 0.055), normal=(-0.42, 0.05, 0.9)):
    L = C['Left']
    disc('Shield', center, r, 0.03, m(face, 'Left'), L, verts=12, normal=normal)
    ring('ShieldRim', center, r, 0.024, m(rim, 'Left'), L, 12, 3, normal=normal)
    ball('ShieldBoss', (center[0] + normal[0] * 0.05, center[1] + normal[1] * 0.05, center[2] + normal[2] * 0.05),
         0.046, m(rim, 'Left'), L, segs=8, rings=3, squash=(1, 1, 0.6))


# ---------------------------------------------------------------- the units


def worker(iron):
    """Tunic, hat, and either a pickaxe or a handful of gold in the right hand - the renderer swaps the two
    (see `Tool`/`Load` in common.py). The second age trades straw for felt and tips the pick in iron."""
    m, C = Mats(SECOND if iron else FIRST), collections(*PARTS, 'Tool', 'Load')
    B, R = C['Body'], C['Right']
    tunic = 'Leather' if iron else 'Cloth'
    # the right hand grips the shaft in front of the shoulder, the left hangs
    # both hands reach forward: the right one grips the pick, and together they cradle a load of gold
    body(m, C, tunic=tunic, trouser='Trouser', boot='Dark', sleeve=tunic,
         right_to=(0.172, 0.30, 0.085), left_to=(-0.172, 0.305, 0.075), chest=(0.255, 0.17))
    box('Sash', (0.062, 0.33, 0.195), (-0.048, 0.42, 0.006), m('Team'), B, rot=(0, -0.34, 0))
    box('SashBack', (0.062, 0.30, 0.185), (0.05, 0.43, -0.004), m('Team'), B, rot=(0, 0.34, 0))
    if iron:
        # felt hat with a team band and a feather, and a studded apron over the leather
        strut('HatBrim', (0, 0.757, 0.006), (0, 0.776, 0.006), 0.127, 0.127, 10, m('Felt'), B)
        strut('HatCrown', (0, 0.762, 0.006), (0, 0.862, 0.006), 0.085, 0.072, 8, m('Felt'), B)
        ring('HatBand', (0, 0.792, 0.006), 0.086, 0.016, m('Team'), B, 10, 3, normal=(0, 1, 0))
        limb('Feather', (0.055, 0.825, -0.03), (0.105, 0.945, -0.05), (0.016, 0.042), (0.01, 0.024), m('Feather'), B)
        box('Apron', (0.20, 0.24, 0.03), (0, 0.33, 0.088), m('Dark'), B)
        for i, x in enumerate((-0.06, 0.06)):
            box(f'Stud{i}', (0.035, 0.035, 0.03), (x, 0.46, 0.09), m('Metal'), B)
    else:
        strut('HatBrim', (0, 0.755, 0.006), (0, 0.775, 0.006), 0.127, 0.127, 10, m('Straw'), B)
        strut('HatCrown', (0, 0.762, 0.006), (0, 0.845, 0.006), 0.088, 0.062, 8, m('Straw'), B)
    # pickaxe: the shaft runs through the hand, head down and forward, ready to swing into a rock face.
    # It is the `Tool` part, which the renderer hides as soon as the worker has gold in that hand.
    T, LD = C['Tool'], C['Load']
    beam('PickShaft', (0.198, 0.47, -0.20), (0.142, 0.17, 0.30), 0.017, m('Wood', 'Tool'), T, half2=0.015)
    head = 'Metal' if iron else 'Dark'
    box('PickCollar', (0.052, 0.058, 0.052), (0.142, 0.168, 0.295), m(head, 'Tool'), T)
    strut('PickPoint', (0.142, 0.163, 0.30), (0.133, 0.10, 0.44), 0.03, 0.007, 4, m(head, 'Tool'), T, roll=0.78)
    strut('PickBack', (0.142, 0.175, 0.285), (0.152, 0.245, 0.20), 0.03, 0.01, 4, m(head, 'Tool'), T, roll=0.78)
    # ... and the load that replaces it: a heap of nuggets piled up between both hands, chest high. It is
    # the `Load` part, drawn only while the worker carries gold, and it does not ride an arm - while he is
    # loaded the renderer stops both arms swinging, so the heap stays wedged between his hands.
    # kept just inside the hands (x = +-0.172) so both of them stay visible holding the pile up
    heap = [(-0.112, 0.30, 0.185, 0.085), (0.112, 0.30, 0.185, 0.085), (0.0, 0.29, 0.225, 0.095),
            (0.0, 0.315, 0.12, 0.08), (-0.07, 0.40, 0.195, 0.07), (0.085, 0.40, 0.21, 0.065),
            (0.0, 0.445, 0.165, 0.06), (-0.135, 0.365, 0.145, 0.05), (0.135, 0.36, 0.15, 0.05),
            (0.02, 0.48, 0.19, 0.042)]
    for i, (x, y, z, r) in enumerate(heap):
        rock(f'Nugget{i}', (x, y, z), r, m('Gold', 'Load'), LD)
    # sack slung on the back
    ball('Sack', (0, 0.50, -0.155), 0.105, m('Dark'), B, segs=7, rings=4, squash=(1, 1.1, 0.85))
    box('SackStrap', (0.30, 0.055, 0.19), (0, 0.46, 0.005), m('Leather'), B, rot=(0, 0.36, 0))


def soldier(iron):
    """Cuirass, crested helm, tabard, sword forward and a round shield."""
    m, C = Mats(SECOND if iron else FIRST), collections(*PARTS)
    plate, fit = armour(iron)
    B, R = C['Body'], C['Right']
    body(m, C, tunic=plate, trouser='Dark', boot='Dark', sleeve=plate, glove=fit,
         right_to=(0.172, 0.30, 0.10), chest=(0.27, 0.18))
    helmet(m, C, plate, fit)
    box('Tabard', (0.125, 0.29, 0.035), (0, 0.40, 0.095), m('Team'), B)
    box('TabardBack', (0.125, 0.27, 0.035), (0, 0.40, -0.088), m('Team'), B)
    for side in (-1, 1):
        ball(f'Pauldron{side}', (side * 0.163, 0.545, 0.006), 0.075, m(plate), B, segs=8, rings=3,
             squash=(1, 0.85, 1.05))
        limb(f'Greave{side}', (side * 0.062, 0.20, 0.012), (side * 0.062, 0.08, 0.016),
             (0.095, 0.105), (0.08, 0.095), m(fit, 'LegA' if side < 0 else 'LegB'),
             C['LegA' if side < 0 else 'LegB'])
    # sword held level and forward, so the attack swing lifts it into a chop
    strut('Grip', (0.172, 0.276, -0.02), (0.172, 0.30, 0.085), 0.019, 0.019, 6, m('Leather', 'Right'), R)
    ball('Pommel', (0.172, 0.272, -0.035), 0.024, m(fit, 'Right'), R, segs=6, rings=4)
    box('Guard', (0.10, 0.028, 0.035), (0.172, 0.305, 0.10), m(fit, 'Right'), R, rot=(0.18, 0, 0))
    limb('Blade', (0.172, 0.308, 0.105), (0.172, 0.385, 0.50), (0.024, 0.05), (0.013, 0.03), m('Steel', 'Right'), R)
    round_shield(m, C, 0.155, 'Team', fit)


def militia(iron):
    """The castle's levy: a cap, a padded jack, a spear held low and a small wooden shield."""
    m, C = Mats(SECOND if iron else FIRST), collections(*PARTS)
    _, fit = armour(iron)
    jack = 'Leather' if iron else 'Cloth'
    B, R = C['Body'], C['Right']
    body(m, C, tunic=jack, trouser='Trouser', boot='Dark', sleeve=jack,
         right_to=(0.172, 0.29, 0.085), chest=(0.25, 0.165))
    ball('Cap', (0, 0.70, 0.006), 0.105, m('Leather' if not iron else fit), B, segs=8, rings=4,
         squash=(1, 0.86, 1))
    ring('CapBand', (0, 0.666, 0.006), 0.092, 0.015, m('Team'), B, 10, 3, normal=(0, 1, 0))
    box('Armband', (0.095, 0.075, 0.1), (0.172, 0.455, 0.02), m('Team', 'Right'), C['Right'])
    box('Jerkin', (0.21, 0.2, 0.03), (0, 0.42, 0.085), m('Leather'), B)
    if iron:
        for side in (-1, 1):
            ball(f'Pauldron{side}', (side * 0.158, 0.54, 0.006), 0.068, m(fit), B, segs=7, rings=3,
                 squash=(1, 0.8, 1.05))
    # spear, butt low behind and point forward - the swing carries it up and over
    beam('Spear', (0.19, 0.20, -0.24), (0.145, 0.40, 0.50), 0.017, m('Wood', 'Right'), R, half2=0.014)
    strut('SpearHead', (0.146, 0.402, 0.49), (0.143, 0.414, 0.62), 0.032, 0.004, 6, m('Steel', 'Right'), R)
    ring('SpearCollar', (0.147, 0.40, 0.475), 0.028, 0.012, m(fit, 'Right'), R, 8, 3, normal=(-0.06, 0.26, 0.96))
    round_shield(m, C, 0.125, 'Wood', 'Team', center=(-0.255, 0.395, 0.05))


def archer(iron):
    """Hooded, cloaked, drawing a bow held across the body; the quiver rides on the back."""
    m, C = Mats(SECOND if iron else FIRST), collections(*PARTS)
    plate, fit = armour(iron)
    B, L, R = C['Body'], C['Left'], C['Right']
    jerkin = plate if iron else 'Green'
    body(m, C, tunic=jerkin, trouser='Trouser', boot='Dark', sleeve='Green' if not iron else fit,
         right_to=(0.02, 0.43, -0.05), left_to=(-0.125, 0.45, 0.14), chest=(0.25, 0.165))
    # hood over a team-coloured cowl, and a short cloak down the back
    ball('Hood', (0, 0.702, -0.022), 0.113, m('Team'), B, segs=8, rings=5, squash=(1, 1.04, 1.06))
    strut('HoodTail', (0, 0.74, -0.06), (0, 0.63, -0.20), 0.085, 0.01, 6, m('Team'), B)
    limb('Collar', (0, 0.525, -0.005), (0, 0.585, -0.005), (0.185, 0.165), (0.135, 0.125), m('Team'), B)
    cloth('Cloak', (-0.15, 0.58, -0.08), (0.30, 0, 0), 0.34, m('Green' if not iron else 'Dark'), B, amp=0.05, segs=5)
    # quiver with three arrows
    strut('Quiver', (-0.085, 0.34, -0.12), (-0.135, 0.60, -0.17), 0.05, 0.045, 8, m('Leather'), B, smooth=True)
    for i, dx in enumerate((-0.02, 0.0, 0.02)):
        strut(f'Fletch{i}', (-0.135 + dx, 0.60, -0.17), (-0.15 + dx, 0.70, -0.19), 0.012, 0.022, 4,
              m('Feather'), B)
    # bow: four segments of an arc in the y-z plane, string straight between the tips
    bx, by = -0.12, 0.45
    arc = [(bx, by + 0.30, 0.02), (bx, by + 0.20, 0.115), (bx, by, 0.175), (bx, by - 0.20, 0.115), (bx, by - 0.30, 0.02)]
    for i in range(4):
        a, b = arc[i], arc[i + 1]
        thick = 0.024 if i in (1, 2) else 0.018
        limb(f'Bow{i}', a, b, (thick, thick + 0.008), (thick, thick + 0.008), m('Dark', 'Left'), L)
    limb('String', arc[0], arc[-1], (0.008, 0.008), (0.008, 0.008), m('Rope', 'Left'), L)
    limb('Arrow', (bx, by, 0.02), (bx, by, 0.34), (0.012, 0.012), (0.012, 0.012), m('Wood', 'Left'), L)
    strut('ArrowHead', (bx, by, 0.33), (bx, by, 0.40), 0.024, 0.0, 4, m('Steel', 'Left'), L)


def cavalry(iron):
    """Lancer on a horse. The horse's legs are the animated pairs - front-left with back-right (part 1),
    front-right with back-left (part 2) - so the walk cycle reads as a trot."""
    m, C = Mats(SECOND if iron else FIRST), collections(*PARTS)
    plate, fit = armour(iron)
    B, R, L = C['Body'], C['Right'], C['Left']
    # the horse's legs swing from its shoulder line, the rider's arms from his own
    joint('Hip', (0, 0.42, 0))
    joint('Shoulder', (0, 0.97, 0))
    # ---- horse
    limb('Barrel', (0, 0.50, -0.32), (0, 0.52, 0.30), (0.24, 0.26), (0.25, 0.30), m('Horse'), B)
    limb('Neck', (0, 0.58, 0.26), (0, 0.84, 0.44), (0.13, 0.19), (0.105, 0.135), m('Horse'), B)
    limb('Skull', (0, 0.845, 0.43), (0, 0.775, 0.60), (0.10, 0.13), (0.088, 0.10), m('Horse'), B)
    box('Muzzle', (0.08, 0.07, 0.07), (0, 0.762, 0.625), m('Mane'), B)
    for side in (-1, 1):
        strut(f'Ear{side}', (side * 0.045, 0.875, 0.42), (side * 0.055, 0.935, 0.405), 0.024, 0.0, 5, m('Horse'), B)
    limb('Crest', (0, 0.885, 0.45), (0, 0.60, 0.22), (0.05, 0.155), (0.065, 0.185), m('Mane'), B)
    strut('Tail', (0, 0.50, -0.33), (0, 0.19, -0.44), 0.055, 0.022, 6, m('Mane'), B, smooth=True)
    # legs in diagonal pairs, front pair reaching a little forward and the back pair back
    for x, z, dz, part in ((-0.095, 0.22, 0.03, 'LegA'), (0.095, -0.24, -0.04, 'LegA'),
                           (0.095, 0.22, 0.03, 'LegB'), (-0.095, -0.24, -0.04, 'LegB')):
        coll = C[part]
        limb(f'{part}Leg{z:+.2f}', (x, 0.42, z), (x, 0.07, z + dz), (0.092, 0.11), (0.062, 0.075), m('Horse', part), coll)
        box(f'{part}Hoof{z:+.2f}', (0.098, 0.06, 0.11), (x, 0.032, z + dz + 0.005), m('Mane', part), coll)
    if iron:  # barding over the horse's brow and rump
        box('Chanfron', (0.115, 0.08, 0.18), (0, 0.878, 0.47), m(plate), B)
        box('Crupper', (0.27, 0.06, 0.32), (0, 0.645, -0.18), m(plate), B)
    # ---- tack
    box('Blanket', (0.30, 0.035, 0.34), (0, 0.635, 0.02), m('Team'), B)
    box('Saddle', (0.21, 0.06, 0.22), (0, 0.665, 0.02), m('Leather'), B)
    strut('Girth', (0, 0.50, 0.06), (0, 0.66, 0.06), 0.135, 0.135, 8, m('Leather'), B)
    # ---- rider, seated: legs are static, only the arms move
    for side in (-1, 1):
        limb(f'Thigh{side}', (side * 0.125, 0.70, -0.02), (side * 0.155, 0.50, 0.14), (0.085, 0.13), (0.075, 0.1),
             m('Dark'), B)
        box(f'Boot{side}', (0.085, 0.075, 0.13), (side * 0.158, 0.455, 0.165), m('Dark'), B)
    limb('Rider', (0, 0.66, 0.0), (0, 1.00, 0.01), (0.22, 0.155), (0.265, 0.175), m(plate), B)
    box('Tabard', (0.15, 0.28, 0.035), (0, 0.83, 0.095), m('Team'), B)
    box('TabardBack', (0.15, 0.26, 0.035), (0, 0.83, -0.088), m('Team'), B)
    limb('RiderNeck', (0, 0.97, 0.0), (0, 1.06, 0.004), (0.085, 0.085), (0.08, 0.08), m('Skin'), B)
    ball('RiderHead', (0, 1.125, 0.008), 0.098, m('Skin'), B, segs=8, rings=5, squash=(1, 1.08, 1.02))
    ball('Helm', (0, 1.142, 0.006), 0.107, m(plate), B, segs=8, rings=4, squash=(1, 1.04, 1.02))
    ring('HelmBrow', (0, 1.105, 0.006), 0.101, 0.017, m(fit), B, 10, 4, normal=(0, 1, 0))
    box('HelmNasal', (0.03, 0.105, 0.03), (0, 1.112, 0.098), m(fit), B)
    box('Crest', (0.03, 0.075, 0.19), (0, 1.235, -0.005), m('Team'), B)
    for side in (-1, 1):
        ball(f'Pauldron{side}', (side * 0.163, 0.985, 0.006), 0.075, m(plate), B, segs=8, rings=3,
             squash=(1, 0.85, 1.05))
    # arms: the lance couched on the right, a shield on the left
    limb('RightArm', (0.168, 0.97, 0.006), (0.185, 0.80, 0.05), (0.078, 0.09), (0.062, 0.072), m(plate, 'Right'), R)
    box('RightHand', (0.072, 0.075, 0.08), (0.185, 0.775, 0.058), m(fit, 'Right'), R)
    limb('LeftArm', (-0.168, 0.97, 0.006), (-0.19, 0.81, 0.04), (0.078, 0.09), (0.062, 0.072), m(plate, 'Left'), L)
    beam('Lance', (0.202, 0.85, -0.30), (0.152, 0.67, 0.64), 0.021, m('Wood', 'Right'), R, half2=0.015)
    strut('LanceHead', (0.153, 0.672, 0.62), (0.15, 0.665, 0.76), 0.034, 0.0, 6, m('Steel', 'Right'), R)
    box('LanceGrip', (0.052, 0.052, 0.13), (0.183, 0.778, 0.055), m('Leather', 'Right'), R)
    cloth('Pennant', (0.166, 0.715, 0.53), (0.015, 0, -0.22), 0.12, m('Team', 'Right'), R, amp=0.035, segs=4)
    round_shield(m, C, 0.14, 'Team', fit, center=(-0.272, 0.80, 0.05))


UNITS = {'Worker': worker, 'Soldier': soldier, 'Archer': archer, 'Militia': militia, 'Cavalry': cavalry}


# ---------------------------------------------------------------- build & preview


def main():
    out = arg('--out', 'models/custom')
    preview = arg('--render')
    only = arg('--only')
    loaded = '--loaded' in args()   # preview the worker hauling gold instead of holding his pick
    os.makedirs(os.path.abspath(out), exist_ok=True)
    names = [only] if only else list(UNITS)
    for age, iron in (('FirstAge', False), ('SecondAge', True)):
        for name in names:
            reset_scene()
            at()
            UNITS[name](iron)
            add_preview_gear()
            bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(os.path.join(out, f'{name}_{age}.blend')))
            join_by_material()
            export(os.path.join(out, f'{name}_{age}.glb'))
            print(f'[units] {name}_{age}: {triangles()} triangles')
        if preview:
            reset_scene()
            for i, name in enumerate(names):
                at((i - (len(names) - 1) / 2) * 0.95)
                UNITS[name](iron)
            at()
            drop_parts('Tool' if loaded else 'Load')
            cam = add_preview_gear()
            span = max(2.6, len(names) * 1.0)
            render(cam, f'{preview}_{age}_front', (0.0, 0.62, 3.2), target=(0, 0.62, 0), res=(1300, 500), ortho=span)
            render(cam, f'{preview}_{age}_persp', (2.2, 1.5, 2.6), target=(0, 0.5, 0), res=(1300, 620))
            render(cam, f'{preview}_{age}_back', (0.0, 0.62, -3.2), target=(0, 0.62, 0), res=(1300, 500), ortho=span)
            # the match camera: 55 degrees above the horizon, looking from +Z (see camera.ts)
            render(cam, f'{preview}_{age}_game', (0.0, 2.6, 1.9), target=(0, 0.45, 0), res=(1300, 620), ortho=span)


main()
