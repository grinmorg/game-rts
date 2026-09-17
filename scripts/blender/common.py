"""
Shared Blender helpers for Rookfall's own models (the asset pack's buildings are used as they come).

Conventions every model here follows - see packages/client/src/game/models.ts:
  * Game space is +X right, +Y up, +Z forward, one unit per map cell, the model standing on y = 0 and
    facing +Z. Blender is Z-up, so a game point (x, y, z) lives at Blender (x, -z, y); every helper takes
    game coordinates and converts.
  * The instanced vertex shader animates by part id, which the loader reads off the material name:
        LegA_*  -> 1   left leg  (front-left + back-right pair on a horse)
        LegB_*  -> 2   right leg (front-right + back-left pair)
        Right_* -> 3   right arm and whatever it holds; this is the arm that swings on an attack
        Left_*  -> 4   left arm and shield
        Wheel_* -> 5   wheels
        Arm_*   -> 6   the catapult's throwing arm
        Tool_*  -> 7   what the right hand holds when it is empty-handed (the worker's pickaxe)
        Load_*  -> 8   what it holds instead while carrying gold
        anything else  static body
    Parts 7 and 8 ride the right arm like part 3 does; the renderer shows one and hides the other, so the
    worker drops his pick the moment he picks up a load.
    The two pivots those parts turn around are marked by empties named `Hip` and `Shoulder` (see `joint`),
    which export as ordinary glTF nodes.
  * The material named `Team` is replaced by the player's colour; the rest only contribute their base
    colour, which is baked into vertex colours on load. Keep everything low-poly - one draw call holds
    every unit of a type on the field.
"""

import bmesh
import bpy
import math
import os
import sys
from mathutils import Matrix, Quaternion, Vector

# ---------------------------------------------------------------- colours


def _srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin(hexcol):
    """sRGB hex -> the linear floats Blender stores and glTF exports, so the in-game colour matches the hex."""
    r, g, b = ((hexcol >> 16) & 255) / 255, ((hexcol >> 8) & 255) / 255, (hexcol & 255) / 255
    return tuple(_srgb_to_linear(c) for c in (r, g, b))


# One table per age. Names that mean the same thing across models share a key, so a model can just ask for
# `Metal` and get plain steel in the first age, bright iron in the second.
FIRST = {
    'Wood': 0x8a5a2b, 'Dark': 0x5b3a1e, 'Metal': 0x5a6068, 'Steel': 0xa8b0bb, 'Rope': 0xc9b28a,
    'Stone': 0x7a7672, 'Skin': 0xe8b98a, 'Cloth': 0x6b5a45, 'Leather': 0x7a4a26, 'Straw': 0xd8b463,
    'Trouser': 0x4a3a2a, 'Green': 0x4f6b3a, 'Horse': 0x6b4a2f, 'Mane': 0x2e1f14, 'Feather': 0xf4f1e6,
    'Felt': 0x3b2a1f, 'Gold': 0xffd54a, 'Team': 0xffffff,
}
SECOND = dict(FIRST, **{
    'Wood': 0x7d5126, 'Dark': 0x4b3018, 'Metal': 0xc2cad4, 'Rope': 0xd6c199,
    'Leather': 0x6b4022, 'Green': 0x40573a, 'Horse': 0x5e4029,
})
METALLIC = ('Metal', 'Steel')

ORIGIN = Vector((0.0, 0.0, 0.0))   # set by `at()` so several models can be lined up in one preview scene


def at(x=0.0, y=0.0, z=0.0):
    """Shift everything built from here on, in game coordinates (used by the lineup preview)."""
    global ORIGIN
    ORIGIN = Vector((x, y, z))


def to_bl(p):
    """game (x, y, z) -> Blender (x, -z, y)"""
    return Vector((p[0] + ORIGIN.x, -(p[2] + ORIGIN.z), p[1] + ORIGIN.y))


def to_bl_dir(d):
    """The same mapping for a direction, which the `at()` offset must not touch."""
    return Vector((d[0], -d[2], d[1]))


def material(name, palette):
    m = bpy.data.materials.get(name)
    if m:
        return m
    key = name.split('_')[-1]
    col = lin(palette[key])
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    node = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if node:
        node.inputs['Base Color'].default_value = (*col, 1.0)
        node.inputs['Metallic'].default_value = 0.9 if key in METALLIC else 0.0
        node.inputs['Roughness'].default_value = 0.5 if key in METALLIC else 0.85
    m.diffuse_color = (*col, 1.0)
    return m


class Mats:
    """Materials of one age, created on demand: `m('Steel')` for the static body, `m('Steel', 'Right')` for
    the same colour on the right arm - the part prefix is what tells the shader that it moves."""

    def __init__(self, palette):
        self.palette = palette

    def __call__(self, kind, part=''):
        return material(f'{part}_{kind}' if part else kind, self.palette)


# ---------------------------------------------------------------- scene


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.context.scene.unit_settings.system = 'METRIC'


def collections(*names):
    out = {}
    for name in names:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
        out[name] = c
    return out


def joint(name, p):
    """A named empty marking an animation pivot (`Hip`, `Shoulder`). It exports as a plain glTF node, which
    is where the loader reads the pivot from - so the joint can be dragged in Blender instead of being kept
    as a number on the client side, and a weapon reaching above the shoulder cannot move it."""
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.06
    e.location = to_bl(p)
    bpy.context.scene.collection.objects.link(e)
    return e


def finish(obj, mat, coll, smooth=False):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll.objects.link(obj)
    obj.data.materials.append(mat)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if smooth:
        try:
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(50))
        except Exception:
            bpy.ops.object.shade_flat()
    else:
        bpy.ops.object.shade_flat()
    return obj


# ---------------------------------------------------------------- primitives


def box(name, size, center, mat, coll, rot=(0, 0, 0)):
    """Axis-aligned block; `size` is (w, h, d) and `center` (x, y, z) in game space. `rot` is a Blender euler."""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=to_bl(center), rotation=rot)
    obj = bpy.context.object
    obj.name = name
    obj.scale = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, mat, coll)


def strut(name, p0, p1, r0, r1, verts, mat, coll, roll=0.0, smooth=False):
    """A prism or cylinder running between two game-space points: verts=4 is a square beam (rolled 45 degrees
    so its faces sit flat), 8-12 a shaft, a drum or a cone."""
    a, b = to_bl(p0), to_bl(p1)
    d = b - a
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r0, radius2=r1, depth=d.length, location=(a + b) / 2)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = 'QUATERNION'
    q = d.to_track_quat('Z', 'Y')
    if roll:
        q = q @ Quaternion(Vector((0, 0, 1)), roll)
    obj.rotation_quaternion = q
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    return finish(obj, mat, coll, smooth)


def beam(name, p0, p1, half, mat, coll, half2=None):
    """Square timber between two points, flat faces up."""
    r1 = (half2 if half2 is not None else half) * math.sqrt(2)
    return strut(name, p0, p1, half * math.sqrt(2), r1, 4, mat, coll, roll=math.pi / 4)


def limb(name, p0, p1, size0, size1, mat, coll):
    """Tapered box section from p0 to p1 - torsos, legs, arms, necks, blades. `size` is the cross-section
    at each end, measured across game X and then across whichever axis stays upright: for an upright part
    that second number is its depth along Z, for one running forward it is its height along Y."""
    a, b = to_bl(p0), to_bl(p1)
    d = b - a
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()

    def rect(z, w, dp):
        return [bm.verts.new((sx * w / 2, sy * dp / 2, z)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]

    v0, v1 = rect(0.0, size0[0], size0[1]), rect(d.length, size1[0], size1[1])
    bm.faces.new(v0)
    bm.faces.new(v1)
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((v0[i], v0[j], v1[j], v1[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = a
    obj.rotation_mode = 'QUATERNION'
    obj.rotation_quaternion = d.to_track_quat('Z', 'Y')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    return finish(obj, mat, coll)


def ball(name, center, r, mat, coll, segs=8, rings=5, squash=(1, 1, 1), smooth=True):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=rings, radius=r, location=to_bl(center))
    obj = bpy.context.object
    obj.name = name
    obj.scale = (squash[0], squash[2], squash[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, mat, coll, smooth)


def rock(name, center, r, mat, coll, subdiv=1):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=r, location=to_bl(center))
    obj = bpy.context.object
    obj.name = name
    return finish(obj, mat, coll)


def ring(name, center, major, minor, mat, coll, major_seg=12, minor_seg=4, normal=(1, 0, 0)):
    """A torus whose axis points along `normal` in game space - axles, rope wraps, shield rims, hat bands."""
    bpy.ops.mesh.primitive_torus_add(location=to_bl(center), major_radius=major, minor_radius=minor,
                                     major_segments=major_seg, minor_segments=minor_seg)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = 'QUATERNION'
    obj.rotation_quaternion = to_bl_dir(normal).to_track_quat('Z', 'Y')
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    return finish(obj, mat, coll, smooth=True)


def disc(name, center, r, thickness, mat, coll, verts=12, normal=(1, 0, 0)):
    """A flat disc (a shield, a hat brim, a wheel plate) whose face looks along `normal` in game space."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=thickness, location=to_bl(center))
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = 'QUATERNION'
    obj.rotation_quaternion = to_bl_dir(normal).to_track_quat('Z', 'Y')
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    return finish(obj, mat, coll)


def cloth(name, origin, along, height, mat, coll, amp=0.06, segs=6, thickness=0.014):
    """A rippling sheet - a banner trailing off a pole, a cloak hanging off shoulders. It runs `along`
    (a game-space vector) from `origin`, drops `height`, and waves across that direction."""
    a = Vector(along)
    across = Vector((-a.z, 0.0, a.x))
    across = across.normalized() if across.length > 1e-6 else Vector((1.0, 0.0, 0.0))
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    grid = []
    for i in range(segs + 1):
        t = i / segs
        wave = math.sin(t * math.pi * 2.0) * amp * t
        col = []
        for j in range(2):
            p = (origin[0] + a.x * t + across.x * wave,
                 origin[1] - height * j,
                 origin[2] + a.z * t + across.z * wave)
            col.append(bm.verts.new(to_bl(p)))
        grid.append(col)
    for i in range(segs):
        bm.faces.new((grid[i][0], grid[i + 1][0], grid[i + 1][1], grid[i][1]))
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    mod = obj.modifiers.new('Solidify', 'SOLIDIFY')
    mod.thickness = thickness
    mod.offset = 0.0
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return finish(obj, mat, coll)


# ---------------------------------------------------------------- export & preview


def drop_parts(prefix):
    """Throw away one of the swappable states (`Tool`, `Load`) before a preview render: the exported model
    carries both and the renderer picks one, but a still image can only show a unit in one of them."""
    for c in bpy.data.collections:
        if c.name.split('.')[0] == prefix:
            for o in list(c.objects):
                bpy.data.objects.remove(o, do_unlink=True)


def join_by_material():
    """One object per material before export: the client merges everything into a single buffer anyway,
    and a handful of primitives keeps the .glb small. The .blend keeps the parts separate for editing."""
    groups = {}
    for o in bpy.data.objects:
        if o.type == 'MESH' and o.data.materials:
            groups.setdefault(o.data.materials[0].name, []).append(o)
    for name, objs in groups.items():
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1:
            bpy.ops.object.join()
        bpy.context.view_layer.objects.active.name = name


def export(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_apply=True,
                              export_normals=True, export_texcoords=False, export_tangents=False,
                              export_animations=False, export_cameras=False, export_lights=False,
                              export_yup=True, export_extras=False)


def triangles():
    n = 0
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.data.calc_loop_triangles()
            n += len(o.data.loop_triangles)
    return n


def add_preview_gear():
    world = bpy.data.worlds.new('Preview')
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.35, 0.42, 0.5, 1)
    bpy.context.scene.world = world
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
    sun.data.energy = 4
    sun.rotation_euler = (math.radians(55), 0, math.radians(35))
    bpy.context.scene.collection.objects.link(sun)
    cam = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


def render(cam, path, eye, target=(0, 0.5, 0), res=(900, 620), ortho=0.0):
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    sh = scene.display.shading
    for attr, value in (('light', 'STUDIO'), ('color_type', 'MATERIAL'), ('color', 'MATERIAL'),
                        ('show_cavity', True), ('show_object_outline', True)):
        if hasattr(sh, attr):
            setattr(sh, attr, value)
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.film_transparent = False
    cam.data.type = 'ORTHO' if ortho else 'PERSP'
    if ortho:
        cam.data.ortho_scale = ortho
    # preview cameras are placed in world space, never shifted by `at()`
    eye_bl = Vector((eye[0], -eye[2], eye[1]))
    cam.location = eye_bl
    cam.rotation_mode = 'QUATERNION'
    cam.rotation_quaternion = (eye_bl - Vector((target[0], -target[2], target[1]))).to_track_quat('Z', 'Y')
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def args():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default=None):
    a = args()
    return a[a.index(name) + 1] if name in a else default
