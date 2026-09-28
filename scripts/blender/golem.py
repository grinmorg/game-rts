"""
Pocket of Empire's stone golem - a neutral wild creature in three sizes - modelled in Blender and exported as glTF.

    blender --background --python scripts/blender/golem.py -- --out models/custom --render /tmp/golem

`--only Small|Medium|Large` builds a single size.

One design, scaled: the golem is drawn just under one unit tall to the crown of its head (`HEIGHT`) and every
coordinate is multiplied by the size's factor on the way in (`g`), the Hip and Shoulder joints included; the
finished golem is then narrowed a touch to the size's width (`squeeze`), so the big ones are a little slimmer
for their height. The bigger golems only add growth on top - moss on the medium one, more moss, a sapling
and dark crags on the large one, which the sapling makes taller than the other two by a hand.

It is a heap of faceted boulders, each the convex hull of a few points scattered over an ellipsoid, jittered
and chiselled flat in places from a seed of the part's own name, so every run - and every size - gets the
same stones. Shared helpers, the palette and the part-id convention live in common.py next to this file:
`LegA_*`/`LegB_*` are the legs, swinging around the Hip height, `Right_*`/`Left_*` the arms, swinging around
the Shoulder height, and everything else rides the body. The golem belongs to nobody, so there is no `Team`
material on it.

The attack swings the right arm forward and up by 1.7 rad, so the arm hangs at rest with the fist a little
in front of the knees: the swing then carries the fist out past the face as a straight punch. Each leg and
each arm starts with a stone centred on its pivot, which turns in place and hides the seam.
"""

import math
import os
import random
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402  (for the live `at()` offset, which the star import only copies)
from common import *  # noqa: F403,E402  (Blender runs this file as a lone script, not as part of a package)
from mathutils import Euler  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402

# light warm greys that stand out on the grass, three of them so the chunks stay apart in flat colour;
# the growth is darker and more olive than the grass it will be seen against
GOLEM = dict(FIRST, **{
    'Granite': 0xb8b5ad,   # the light chunks - head, jaw, shoulders, forearms, fists
    'Pebble': 0xa3a098,    # mid grey - chest, hump, upper arms, feet
    'Crag': 0x8f8b84,      # the dark ones - belly, thighs, fingers
    'Flint': 0x726e68,     # darker still - the crags on the large golem's back
    'Socket': 0x4a4540,    # a dark hollow round each eye, so the yellow reads as a glow
    'Eye': 0xffd23a,
    'Rune': 0x3a322c,
    'Moss': 0x6f8a36,
    'Leaf': 0x3d8b37,
    'Bark': 0x6e4828,
    'Grass': 0x6aa845,     # preview ground only, never exported
})

HEIGHT = 0.974      # the design is drawn this tall to the crown of the head ...
SIZES = {'Small': (0.62, 0.55), 'Medium': (0.95, 0.80), 'Large': (1.35, 1.10)}   # ... exported (tall, wide)
HIP = 0.20          # legs turn around here (parts 1/2), in design units
SHOULDER = 0.66     # arms turn around here (parts 3/4)
PARTS = ('Body', 'LegA', 'LegB', 'Right', 'Left', 'Growth')
K = 1.0             # design -> model units for the size being built (set by `build`)


def g(x, y, z):
    """A design-space point in model units for the size being built."""
    return (x * K, y * K, z * K)


def to_game(p):
    """Blender (x, y, z) -> game (x, y, z), undoing the lineup offset as well."""
    o = common.ORIGIN
    return Vector((p[0] - o.x, p[2] - o.y, -p[1] - o.z))


# ---------------------------------------------------------------- stones


def boulder(name, c, r, mat, coll, n=14, jag=0.25, cuts=2, tilt=(0, 0, 0), floor=None, up=None,
            seed=None, flip=False, sym=False, flat=None):
    """A faceted rock around design point `c` with radii `r` (across game x, y, z): the convex hull of `n`
    points spread over a sphere and jittered, `cuts` of its sides chiselled flat, then stretched to the
    ellipsoid and turned by `tilt` (a game-space euler) - or so its y axis points along `up`, for a stone
    lying on another one. `floor` presses the bottom of the stone flat onto that height, into a sole.

    The jitter is seeded by the name (or `seed`), so a part is the same stone in every size. A pair of eyes
    or brows shares one seed and the left one is `flip`ped across x; `sym` makes a stone mirror-symmetric
    in itself - the head and the jaw, so the golem does not squint. `flat` = (direction, depth) chisels one
    more face exactly where it is wanted: the forehead the rune is cut into."""
    rng = random.Random(f'golem:{seed or name}')
    spin = Euler((rng.uniform(0, 6.3), rng.uniform(0, 6.3), rng.uniform(0, 6.3))).to_matrix()
    turn = (Vector((0, 1, 0)).rotation_difference(Vector(up).normalized()).to_matrix() if up is not None
            else Euler(tilt).to_matrix())
    planes = [(Vector([rng.uniform(-1, 1) for _ in range(3)]).normalized(), rng.uniform(0.62, 0.8))
              for _ in range(cuts)]
    if flat:
        planes.append((Vector(flat[0]).normalized(), flat[1]))
    golden = math.pi * (3 - math.sqrt(5))
    pts = []
    for i in range(n):
        y = 1 - 2 * (i + 0.5) / n
        s = math.sqrt(max(0.0, 1 - y * y))
        d = spin @ Vector((math.cos(golden * i) * s, y, math.sin(golden * i) * s))
        d = (d + Vector([rng.uniform(-jag, jag) for _ in range(3)]) * 0.6).normalized()
        d *= 1 + rng.uniform(-jag, jag) * 0.4
        for pn, h in planes:           # knock the point back onto a chiselled face
            over = d.dot(pn) - h
            if over > 0:
                d -= pn * over
        pts.append(d)
    if sym:                            # keep the right half, snap the middle onto x = 0, mirror
        half = [Vector((0.0 if p.x < 0.08 else p.x, p.y, p.z)) for p in pts if p.x > -0.08]
        pts = half + [Vector((-p.x, p.y, p.z)) for p in half if p.x > 0]
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    for d in pts:
        if flip:
            d = Vector((-d.x, d.y, d.z))
        p = turn @ Vector((d.x * r[0], d.y * r[1], d.z * r[2])) * K + Vector(g(*c))
        if floor is not None and p.y < (floor + r[1] * 0.3) * K:
            p.y = floor * K
        bm.verts.new(to_bl(p))
    # points that nearly touch would only leave slivers and pin-pricks on the hull
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=min(r) * K * 0.2)
    hull = bmesh.ops.convex_hull(bm, input=bm.verts[:])
    loose = {v for v in hull['geom_interior'] + hull['geom_unused'] if isinstance(v, bmesh.types.BMVert)}
    bmesh.ops.delete(bm, geom=list(loose), context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, mat, coll)


class Surface:
    """Rays against one stone, in game space - so eyes, runes and moss sit on its facets wherever the
    jitter put them, instead of floating over the ellipsoid it was made from."""

    def __init__(self, obj, center):
        self.obj = obj
        self.bvh = BVHTree.FromPolygons([to_game(v.co) for v in obj.data.vertices],
                                        [tuple(p.vertices) for p in obj.data.polygons])
        self.c = Vector(g(*center))

    def hit(self, direction, offset=(0, 0, 0)):
        """Where a ray from outside the stone, running back along `direction` through its centre shifted by
        `offset` (design units), meets the surface: (point, normal) in game space."""
        d = Vector(direction).normalized()
        loc, nrm, _, _ = self.bvh.ray_cast(self.c + Vector(offset) * K + d * 3.0 * K, -d)
        if loc is None:
            raise RuntimeError(f'ray {direction} missed the stone')
        return loc, nrm


def pad(name, surf, direction, r, thick, mat, coll, sink=0.35, offset=(0, 0, 0), n=12, **kw):
    """A flat stone lying on another one - the hollow an eye sits in."""
    p, nrm = surf.hit(direction, offset)
    c = (p - nrm * thick * K * sink) / K
    return boulder(name, tuple(c), (r[0], thick, r[1]), mat, coll, n=n, jag=0.15, cuts=0, up=nrm, **kw)


def cap(name, surf, direction, spread, mat, coll, lift=0.014, tufts=3):
    """Moss draped over a stone: a copy of its facets that look along `direction` (within `spread`, as a
    cosine), lifted a little off them and skirted down to the rock, so it follows the stone's facets
    instead of lying on it like a lid. A few `tufts` along the rim break up its straight edges."""
    src = surf.obj.data
    c = to_bl(surf.c)                  # the stone's centre, in Blender space like its vertices
    d = to_bl_dir(direction).normalized()
    faces = [f for f in src.polygons if (f.center - c).normalized().dot(d) > spread]
    bm = bmesh.new()
    lifted, ground, uses = {}, {}, {}
    for f in faces:
        for vi in f.vertices:
            co = src.vertices[vi].co
            if vi not in lifted:
                lifted[vi] = bm.verts.new(co + (co - c).normalized() * lift * K)
                ground[vi] = bm.verts.new(co - (co - c).normalized() * lift * K * 0.5)
        bm.faces.new([lifted[vi] for vi in f.vertices])
        for k in range(len(f.vertices)):
            e = tuple(sorted((f.vertices[k], f.vertices[(k + 1) % len(f.vertices)])))
            uses[e] = uses.get(e, 0) + 1
    rim = [e for e, count in uses.items() if count == 1]
    for a, b in rim:                       # the skirt: every edge only one cap face uses is on the rim
        bm.faces.new((lifted[a], lifted[b], ground[b], ground[a]))
    rng = random.Random(f'golem:{name}')
    for i, (a, b) in enumerate(rng.sample(sorted(rim), min(tufts, len(rim)))):
        mid = (src.vertices[a].co + src.vertices[b].co) / 2
        up = to_game(mid) - to_game(c)
        r = rng.uniform(0.028, 0.04)
        boulder(f'{name}Tuft{i}', tuple(to_game(mid) / K), (r, r * 0.5, r * 1.2), mat, coll, n=8, jag=0.2,
                cuts=0, up=up)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    top = next(iter(bm.faces))
    top_c = top.calc_center_median()
    if top.normal.dot(top_c - c) < 0:      # the recalc may have turned the whole shell inside out
        for f in bm.faces:
            f.normal_flip()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, mat, coll)


def carve(name, surf, direction, radius, turns, width, mat, coll, per_turn=30):
    """A spiral rune laid on the stone as a thin ribbon, sampled densely enough to follow its facets."""
    n = Vector(direction).normalized()
    u = Vector((1, 0, 0))
    u = (u - n * u.dot(n)).normalized()
    v = n.cross(u)
    steps = max(4, int(turns * per_turn))
    rows = []
    for i in range(steps + 1):
        t = i / steps
        a = t * turns * 2 * math.pi
        rr = radius * (0.18 + 0.82 * t)
        radial = u * math.cos(a) + v * math.sin(a)
        row = []
        for s in (-0.5, 0.5):
            p, nrm = surf.hit(direction, offset=tuple(radial * (rr + s * width)))
            row.append(p + nrm * 0.007 * K)
        rows.append(row)
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    verts = [[bm.verts.new(to_bl(p)) for p in row] for row in rows]
    out = to_bl_dir(n)
    for i in range(steps):
        f = bm.faces.new((verts[i][0], verts[i][1], verts[i + 1][1], verts[i + 1][0]))
        f.normal_update()
        if f.normal.dot(out) < 0:
            f.normal_flip()
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return finish(obj, mat, coll)


def squeeze(colls, factor):
    """Narrow everything built into `colls` across x by `factor` about the model's centre line - the
    bigger golems are a touch slimmer for their height, which a uniform scale alone cannot give."""
    ox = common.ORIGIN.x
    m = Matrix.Translation((ox, 0, 0)) @ Matrix.Diagonal((factor, 1, 1, 1)) @ Matrix.Translation((-ox, 0, 0))
    for coll in colls:
        for o in coll.objects:
            if o.type == 'MESH':
                o.data.transform(o.matrix_world.inverted_safe() @ m @ o.matrix_world)
                o.data.update()


# ---------------------------------------------------------------- the golem


# the forehead facet the rune is cut into: straight at the match camera, which looks down at 55 degrees
BROW_DIR = (0, 0.75, 0.66)


def build(size):
    """The whole golem at one size, into fresh collections."""
    global K
    tall, wide = SIZES[size]
    K = tall / HEIGHT
    m, C = Mats(GOLEM), collections(*PARTS)
    B, G = C['Body'], C['Growth']
    joint('Hip', g(0, HIP, 0))
    joint('Shoulder', g(0, SHOULDER, 0))

    # ---- short stumpy legs: a thigh stone turning on the hip, a flat-soled foot under it
    for side, part in ((-1, 'LegA'), (1, 'LegB')):
        L = C[part]
        boulder(f'{part}Thigh', (side * 0.105, HIP, 0.0), (0.095, 0.1, 0.095), m('Crag', part), L, n=12)
        boulder(f'{part}Foot', (side * 0.11, 0.06, 0.035), (0.095, 0.07, 0.12), m('Pebble', part), L,
                n=12, floor=0.0)

    # ---- the hunched body: belly, a massive chest leaning forward, a hump the head sinks into
    boulder('Belly', (0, 0.29, 0.0), (0.17, 0.12, 0.15), m('Crag'), B, n=14)
    boulder('Chest', (0, 0.47, 0.02), (0.29, 0.2, 0.2), m('Pebble'), B, n=18, tilt=(0.3, 0, 0))
    hump_c = (0, 0.70, -0.12)
    hump = Surface(boulder('Hump', hump_c, (0.26, 0.17, 0.17), m('Pebble'), B, n=16), hump_c)

    # ---- head: a big round boulder pushed forward, a wide jaw slab under the eyes, a heavy brow over them
    head_c = (0, 0.79, 0.13)
    face = Surface(boulder('Head', head_c, (0.235, 0.195, 0.205), m('Granite'), B, n=30, cuts=1, sym=True,
                           flat=(BROW_DIR, 0.87)), head_c)
    boulder('Jaw', (0, 0.60, 0.21), (0.255, 0.125, 0.165), m('Granite'), B, n=18, sym=True)
    for side in (-1, 1):
        flip = side < 0
        # the brow in two slabs meeting low over the nose, so the golem frowns
        boulder(f'Brow{side}', (side * 0.09, 0.855, 0.23), (0.12, 0.045, 0.08), m('Granite'), B, n=12, cuts=1,
                tilt=(0.15, 0.0, side * 0.3), seed='Brow', flip=flip)
        # a dark hollow first, then the glowing slit on top of it
        pad(f'Socket{side}', face, (0, 0, 1), (0.095, 0.056), 0.03, m('Socket'), B, sink=0.2,
            offset=(side * 0.095, -0.045, 0), seed='Socket', flip=flip)
        # the eye bulges out of the hollow and looks a little up, so the match camera catches it under the
        # brow; its inner corner dips, which makes the frown
        p, nrm = face.hit((0, 0, 1), (side * 0.095, -0.045, 0))
        boulder(f'Eye{side}', tuple((p + nrm * 0.022 * K) / K), (0.072, 0.036, 0.032), m('Eye'), B, n=12,
                jag=0.1, cuts=0, tilt=(-0.45, 0.0, side * 0.2), seed='Eye', flip=flip)
    # the labyrinth rune, on the forehead facet
    carve('Rune', face, BROW_DIR, 0.085, 2.2, 0.02, m('Rune'), B)

    # ---- shoulder boulders, riding high so the head sits down between them
    shoulders = {}
    for side in (-1, 1):
        c = (side * 0.29, 0.69, -0.03)
        shoulders[side] = Surface(boulder(f'Shoulder{side}', c, (0.165, 0.155, 0.165), m('Granite'), B, n=16), c)

    # ---- long arms from the shoulder pivot: a short upper arm mostly hidden under the shoulder, a big
    # forearm, and a fist bigger than both, nearly on the ground and a little forward
    for side, part in ((1, 'Right'), (-1, 'Left')):
        A, x = C[part], side * 0.28
        boulder(f'{part}Joint', (x, SHOULDER, 0.0), (0.075, 0.075, 0.075), m('Pebble', part), A, n=10, cuts=0)
        boulder(f'{part}Upper', (x * 1.05, 0.53, 0.02), (0.095, 0.13, 0.095), m('Pebble', part), A, n=10)
        boulder(f'{part}Fore', (x * 1.08, 0.36, 0.075), (0.12, 0.14, 0.115), m('Granite', part), A, n=12)
        boulder(f'{part}Fist', (x * 1.09, 0.15, 0.12), (0.15, 0.14, 0.155), m('Granite', part), A, n=14)
        # fingers curled under the front of the fist: the swing turns that face forward, so they lead the punch
        for i, dx in enumerate((-0.068, 0.0, 0.068)):
            boulder(f'{part}Finger{i}', (x * 1.09 + dx, 0.1, 0.245), (0.047, 0.065, 0.05), m('Crag', part), A,
                    n=10, cuts=1, tilt=(0.6, 0, 0))

    if size in ('Medium', 'Large'):
        moss(m, G, face, shoulders, hump, size)
    if size == 'Large':
        sapling(m, G, shoulders[-1])
        crags(m, B)

    # narrow the whole golem to the size's width, measured off what was just built
    lo, hi = bounds(C.values())
    squeeze(C.values(), wide / (hi.x - lo.x))


def moss(m, G, face, shoulders, hump, size):
    """Moss grown over the crown of the head, off to one side of the rune, and over a shoulder; the large
    golem has been sitting still long enough for it to cover both shoulders and the hump."""
    cap('MossHead', face, (-0.45, 0.8, -0.4), 0.84, m('Moss'), G)
    cap('MossShoulder1', shoulders[1], (0.25, 1.0, -0.15), 0.8, m('Moss'), G)
    if size == 'Large':
        cap('MossShoulder-1', shoulders[-1], (-0.1, 1.0, 0.05), 0.72, m('Moss'), G)
        cap('MossHump', hump, (0.3, 0.6, -0.8), 0.85, m('Moss'), G)


def sapling(m, G, shoulder):
    """A young tree rooted in the moss on the left shoulder: a thin bent trunk, two twigs, three leaf clumps."""
    base, _ = shoulder.hit((-0.1, 1.0, 0.05))
    b = base / K

    def off(dx, dy, dz):
        """A point this far from the root, in model units."""
        return g(b.x + dx, b.y + dy, b.z + dz)

    strut('Trunk0', off(0, -0.02, 0), off(0.012, 0.075, -0.005), 0.02 * K, 0.015 * K, 6, m('Bark'), G)
    strut('Trunk1', off(0.012, 0.07, -0.005), off(-0.005, 0.15, -0.02), 0.015 * K, 0.009 * K, 6, m('Bark'), G)
    strut('Twig0', off(0.008, 0.06, -0.005), off(-0.06, 0.1, 0.02), 0.009 * K, 0.005 * K, 5, m('Bark'), G)
    strut('Twig1', off(0.004, 0.11, -0.012), off(0.055, 0.14, 0.01), 0.008 * K, 0.004 * K, 5, m('Bark'), G)
    for name, c, r in (('Leaves0', (-0.005, 0.18, -0.02), 0.062), ('Leaves1', (-0.07, 0.11, 0.025), 0.045),
                       ('Leaves2', (0.065, 0.145, 0.012), 0.042)):
        boulder(name, tuple(b + Vector(c)), (r, r * 0.8, r), m('Leaf'), G, n=12, jag=0.3, cuts=0)


def crags(m, B):
    """Dark crags breaking out of the back, as if the old one had grown out of a hillside."""
    for i, (c, r, tilt) in enumerate((((-0.14, 0.78, -0.22), (0.085, 0.075, 0.09), (-0.5, 0.3, 0.4)),
                                     ((0.12, 0.74, -0.25), (0.075, 0.07, 0.085), (-0.6, -0.4, -0.3)),
                                     ((0.02, 0.6, -0.26), (0.09, 0.075, 0.08), (-0.9, 0.2, 0.1)),
                                     ((-0.02, 0.84, -0.17), (0.065, 0.06, 0.07), (-0.3, 0.0, 0.2)))):
        boulder(f'Crag{i}', c, r, m('Flint'), B, n=10, cuts=2, tilt=tilt)


# ---------------------------------------------------------------- preview poses


def swing(part, angle, pivot_y):
    """Turn a part about the game X axis through (y = pivot_y, z = 0) the way the vertex shader does - the
    preview renders use it to check the punch and the stride."""
    piv = to_bl((0, pivot_y, 0))
    turn = Matrix.Translation(piv) @ Matrix.Rotation(angle, 4, 'X') @ Matrix.Translation(-piv)
    for o in bpy.data.collections[part].objects:
        o.matrix_world = turn @ o.matrix_world


def pose(kind):
    """`attack`: the punch at full stretch. `walk`: mid-stride, legs +-0.6, arms +-0.4, body bobbed up."""
    hip, sh = HIP * K, SHOULDER * K
    if kind == 'attack':
        swing('Right', -1.7, sh)
        swing('Left', -0.3, sh)
    elif kind == 'walk':
        swing('LegA', 0.6, hip)
        swing('LegB', -0.6, hip)
        swing('Right', 0.4, sh)
        swing('Left', -0.4, sh)
        for part in ('Body', 'Growth'):
            for o in bpy.data.collections[part].objects:
                o.matrix_world = Matrix.Translation(to_bl_dir((0, 0.03, 0))) @ o.matrix_world


def ground():
    """A patch of grass under the preview, so the greys can be judged against what they will stand on."""
    box('Ground', (8, 0.02, 8), (0, -0.011, 0), material('Grass', GOLEM), bpy.context.scene.collection)


def bounds(colls=None):
    """(min, max) in game space of every mesh - or of those in `colls`."""
    lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    objs = [o for c in colls for o in c.objects] if colls is not None else bpy.data.objects
    for o in objs:
        if o.type == 'MESH':
            for v in o.data.vertices:
                p = to_game(o.matrix_world @ v.co)
                lo = Vector(map(min, lo, p))
                hi = Vector(map(max, hi, p))
    return lo, hi


def views(cam, prefix, s):
    """Front, side, three-quarter and the match camera, framed for a golem `s` tall."""
    mid = s * 0.5
    render(cam, f'{prefix}_front', (0.0, mid, 6.0), target=(0, mid, 0), res=(700, 700), ortho=s * 1.5)
    render(cam, f'{prefix}_side', (6.0, mid, 0.0), target=(0, mid, 0), res=(700, 700), ortho=s * 1.5)
    render(cam, f'{prefix}_persp', (s * 1.7, s * 1.15, s * 1.9), target=(0, mid * 0.95, 0), res=(700, 700))
    # the match camera: 55 degrees above the horizon, looking from +Z (see camera.ts)
    e = math.radians(55)
    render(cam, f'{prefix}_game', (0.0, mid + 6 * math.sin(e), 6 * math.cos(e)), target=(0, mid, 0),
           res=(700, 700), ortho=s * 1.5)


def main():
    out = arg('--out', 'models/custom')
    preview = arg('--render')
    only = arg('--only')
    os.makedirs(os.path.abspath(out), exist_ok=True)
    names = [only] if only else list(SIZES)
    for size in names:
        reset_scene()
        at()
        build(size)
        cam = add_preview_gear()
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(os.path.join(out, f'Golem_{size}.blend')))
        join_by_material()
        export(os.path.join(out, f'Golem_{size}.glb'))
        lo, hi = bounds()
        w, h, d = hi - lo
        print(f'[golem] {size}: {triangles()} triangles, {w:.3f} x {h:.3f} x {d:.3f} (w x h x d, '
              f'z {lo.z:+.3f}..{hi.z:+.3f}), hip {HIP * K:.3f}, shoulder {SHOULDER * K:.3f}')
        if preview:
            s = SIZES[size][0]
            ground()
            views(cam, f'{preview}{size}', s)
            for kind in ('attack', 'walk'):
                reset_scene()
                build(size)
                pose(kind)
                ground()
                views(add_preview_gear(), f'{preview}{size}_{kind}', s)
    if preview and not only:
        # all three side by side, small to large
        reset_scene()
        x = -1.0
        for size in SIZES:
            s = SIZES[size][0]
            at(x + s * 0.45)
            build(size)
            x += s * 0.9 + 0.25
        at()
        ground()
        cam = add_preview_gear()
        e = math.radians(55)
        cx = (x - 0.25 - 1.0) / 2
        render(cam, f'{preview}lineup_front', (cx, 0.65, 8.0), target=(cx, 0.65, 0), res=(1300, 620), ortho=3.4)
        render(cam, f'{preview}lineup_game', (cx, 0.6 + 8 * math.sin(e), 8 * math.cos(e)), target=(cx, 0.6, 0),
               res=(1300, 620), ortho=3.4)
        render(cam, f'{preview}lineup_persp', (cx + 2.6, 2.0, 4.4), target=(cx, 0.55, 0), res=(1300, 620))


main()
