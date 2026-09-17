"""
Rookfall's catapult, modelled in Blender and exported as glTF for the client.

    blender --background --python scripts/blender/catapult.py -- --out models/custom --render /tmp/cat

What the client expects (see packages/client/src/game/models.ts):
  * Game space is +X right, +Y up, +Z forward, one unit per map cell; the engine drives toward +Z and
    throws toward +Z. Blender is Z-up, so a game point (x, y, z) lives at Blender (x, -z, y) - every
    helper here takes game coordinates and converts.
  * The instanced vertex shader animates by part id, which the loader derives from the material name:
    `Arm_*` -> part 6 (the throwing arm, pivoting around the axle at y=0.30, z=0.20), `Wheel_*` -> part 5,
    anything else is the static body. The material named `Team` is replaced by the player colour.
  * Only the material's base colour matters: it is baked into vertex colours on load. Keep it low-poly,
    the mesh is drawn once per catapult on the field through an InstancedMesh.
"""

import bpy
import bmesh
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

# the palette of the procedural units in models.ts, so the catapult sits with the rest of the army
FIRST = {'Wood': 0x8a5a2b, 'Dark': 0x5b3a1e, 'Metal': 0x5a6068, 'Rope': 0xc9b28a, 'Stone': 0x7a7672, 'Team': 0xffffff}
SECOND = {'Wood': 0x7d5126, 'Dark': 0x4b3018, 'Metal': 0xc2cad4, 'Rope': 0xd6c199, 'Stone': 0x7a7672, 'Team': 0xffffff}

PIVOT = (0.0, 0.30, 0.20)   # the arm axle; hard-coded in the renderer's vertex shader
ARM_TIP = (0.0, 0.46, -0.80)

# ---------------------------------------------------------------- scene helpers

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'

def material(name, palette, metallic=0.0, roughness=0.85):
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
        node.inputs['Metallic'].default_value = metallic
        node.inputs['Roughness'].default_value = roughness
    m.diffuse_color = (*col, 1.0)
    return m

def to_bl(p):
    """game (x, y, z) -> Blender (x, -z, y)"""
    return Vector((p[0], -p[2], p[1]))

def finish(obj, mat, collection, smooth=False):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    collection.objects.link(obj)
    obj.data.materials.append(mat)
    if smooth:
        try:
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(50))
        except Exception:
            bpy.ops.object.shade_flat()
    else:
        bpy.ops.object.shade_flat()
    return obj

def box(name, size, center, mat, coll, rot=(0, 0, 0)):
    """Axis-aligned block; `size` and `center` are game-space (w, h, d) / (x, y, z). `rot` is a Blender euler."""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=to_bl(center), rotation=rot)
    obj = bpy.context.object
    obj.name = name
    obj.scale = (size[0], size[2], size[1])   # game (w, h, d) -> Blender (x, y, z)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, mat, coll)

def strut(name, p0, p1, r0, r1, verts, mat, coll, roll=0.0, smooth=False):
    """A prism/cylinder running between two game-space points. verts=4 gives a square beam (roll it 45 deg
    so the faces sit flat), 8-12 gives a shaft or a drum."""
    a, b = to_bl(p0), to_bl(p1)
    d = b - a
    length = d.length
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r0, radius2=r1, depth=length, location=(a + b) / 2)
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
    r0 = half * math.sqrt(2)
    r1 = (half2 if half2 is not None else half) * math.sqrt(2)
    return strut(name, p0, p1, r0, r1, 4, mat, coll, roll=math.pi / 4)

def ring(name, center, major, minor, mat, coll, major_seg=12, minor_seg=5, axis='x'):
    """A torus around the game X axis (axis='x') or the vertical (axis='y')."""
    rot = (0, math.pi / 2, 0) if axis == 'x' else (0, 0, 0)
    bpy.ops.mesh.primitive_torus_add(location=to_bl(center), rotation=rot,
                                     major_radius=major, minor_radius=minor,
                                     major_segments=major_seg, minor_segments=minor_seg)
    obj = bpy.context.object
    obj.name = name
    return finish(obj, mat, coll, smooth=True)

def rock(name, center, r, mat, coll):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=r, location=to_bl(center))
    obj = bpy.context.object
    obj.name = name
    return finish(obj, mat, coll)

def banner_cloth(name, origin, length, height, mat, coll, yaw=0.0, amp=0.07, segs=6):
    """A waving flag hanging off a pole: it trails `length` away along `yaw` (0 = straight back) and ripples
    across that direction, so it catches the light from more than one side of the match camera."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    along = (math.sin(yaw), -math.cos(yaw))
    across = (math.cos(yaw), math.sin(yaw))
    grid = []
    for i in range(segs + 1):
        t = i / segs
        wave = math.sin(t * math.pi * 2.0) * amp * t
        col = []
        for j in range(2):
            p = (origin[0] + along[0] * length * t + across[0] * wave,
                 origin[1] - height * j,
                 origin[2] + along[1] * length * t + across[1] * wave)
            col.append(bm.verts.new(to_bl(p)))
        grid.append(col)
    for i in range(segs):
        bm.faces.new((grid[i][0], grid[i + 1][0], grid[i + 1][1], grid[i][1]))
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    mod = obj.modifiers.new('Solidify', 'SOLIDIFY')
    mod.thickness = 0.014
    mod.offset = 0.0
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return finish(obj, mat, coll)

# ---------------------------------------------------------------- the machine

def build(iron):
    palette = SECOND if iron else FIRST
    mats = {k: material(k, palette, metallic=0.9 if k == 'Metal' else 0.0, roughness=0.5 if k == 'Metal' else 0.85)
            for k in ('Wood', 'Dark', 'Metal', 'Rope', 'Team')}
    for part in ('Arm', 'Wheel'):
        for k in ('Wood', 'Dark', 'Metal', 'Rope', 'Stone'):
            if k in palette:
                mats[f'{part}_{k}'] = material(f'{part}_{k}', palette,
                                               metallic=0.9 if k == 'Metal' else 0.0,
                                               roughness=0.5 if k == 'Metal' else 0.85)

    colls = {}
    for name in ('Frame', 'Winch', 'Arm', 'Wheels', 'Banner'):
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
        colls[name] = c

    F, W, A, WH, B = colls['Frame'], colls['Winch'], colls['Arm'], colls['Wheels'], colls['Banner']

    # ---- chassis: two side rails, cross beams at both ends, a plank deck over the front half
    for s in (-1, 1):
        beam(f'Rail{s}', (s * 0.28, 0.25, -0.54), (s * 0.28, 0.25, 0.54), 0.058, mats['Wood'], F)
    box('BeamFront', (0.74, 0.11, 0.13), (0, 0.26, 0.46), mats['Dark'], F)
    box('BeamRear', (0.74, 0.11, 0.13), (0, 0.26, -0.46), mats['Dark'], F)
    for i, z in enumerate((0.30, 0.41, 0.52)):
        box(f'Plank{i}', (0.50, 0.03, 0.09), (0, 0.325, z), mats['Dark'], F)
    for i, z in enumerate((-0.10, 0.06)):
        box(f'Tie{i}', (0.50, 0.055, 0.085), (0, 0.235, z), mats['Dark'], F)
    # iron corner straps - the second age wraps the whole chassis in them
    for s in (-1, 1):
        for zs in (-1, 1):
            box(f'Strap{s}{zs}', (0.13, 0.145, 0.045), (s * 0.28, 0.25, zs * 0.44), mats['Metal'], F)
            if iron:
                box(f'Strap2{s}{zs}', (0.13, 0.145, 0.04), (s * 0.28, 0.25, zs * 0.2), mats['Metal'], F)

    # ---- torsion assembly: the rope skein the arm is sprung from, on two blocks over the rails
    for s in (-1, 1):
        box(f'SkeinBlock{s}', (0.11, 0.22, 0.20), (s * 0.28, 0.27, PIVOT[2]), mats['Wood'], F)
        strut(f'SkeinWasher{s}', (s * 0.245, PIVOT[1], PIVOT[2]), (s * 0.20, PIVOT[1], PIVOT[2]),
              0.095, 0.095, 10, mats['Metal'], F, smooth=True)
        strut(f'Skein{s}', (s * 0.205, PIVOT[1], PIVOT[2]), (s * 0.075, PIVOT[1], PIVOT[2]),
              0.082, 0.082, 10, mats['Rope'], F, smooth=True)
        for i in range(2):
            ring(f'SkeinWrap{s}{i}', (s * (0.10 + i * 0.07), PIVOT[1], PIVOT[2]), 0.083, 0.016, mats['Rope'], F, 8, 3)
        # tensioning bar sticking out of the washer
        box(f'Tension{s}', (0.03, 0.03, 0.22), (s * 0.245, PIVOT[1] + 0.02, PIVOT[2] + 0.02), mats['Metal'], F)

    # ---- A-frame: the uprights and the padded beam the arm slams into at the top of its swing
    for s in (-1, 1):
        beam(f'Post{s}', (s * 0.28, 0.28, 0.36), (s * 0.26, 1.00, 0.30), 0.045, mats['Wood'], F, half2=0.036)
        beam(f'Brace{s}', (s * 0.28, 0.30, -0.12), (s * 0.265, 0.80, 0.265), 0.028, mats['Dark'], F)
    strut('Stopper', (-0.30, 0.98, 0.30), (0.30, 0.98, 0.30), 0.062, 0.062, 10, mats['Wood'], F, smooth=True)
    for s in (-1, 1):
        ring(f'StopperPad{s}', (s * 0.11, 0.98, 0.30), 0.072, 0.026, mats['Rope'], F, 10, 5)

    # ---- winch: the drum the arm is cocked down to, in iron bearings on the rear of the rails
    strut('Drum', (-0.25, 0.28, -0.44), (0.25, 0.28, -0.44), 0.058, 0.058, 10, mats['Dark'], W, smooth=True)
    for i in range(5):
        ring(f'DrumRope{i}', (-0.13 + i * 0.065, 0.28, -0.44), 0.064, 0.016, mats['Rope'], W, 8, 3)
    for s in (-1, 1):
        box(f'WinchBearing{s}', (0.10, 0.16, 0.12), (s * 0.28, 0.28, -0.44), mats['Metal'], W)
    # ratchet, pawl and crank on the right-hand end, outboard of the rail where they can be seen
    strut('Ratchet', (0.29, 0.28, -0.44), (0.315, 0.28, -0.44), 0.095, 0.095, 12, mats['Metal'], W)
    beam('Pawl', (0.315, 0.47, -0.52), (0.315, 0.34, -0.45), 0.014, mats['Metal'], W)
    beam('Crank', (0.34, 0.28, -0.44), (0.34, 0.42, -0.44), 0.021, mats['Metal'], W)
    strut('Handle', (0.33, 0.42, -0.44), (0.44, 0.42, -0.44), 0.024, 0.024, 6, mats['Dark'], W, smooth=True)
    # the cocking rope, off the drum and up to the hook under the arm
    strut('Rope', (0.0, 0.34, -0.44), (0.0, 0.40, -0.68), 0.013, 0.013, 5, mats['Rope'], W)

    # ---- throwing arm (part 6): tapered beam, iron collar at the axle, bucket and boulder at the tip
    beam('Arm', (0.0, 0.295, 0.31), ARM_TIP, 0.062, mats['Arm_Wood'], A, half2=0.040)
    strut('ArmCollar', (-0.075, PIVOT[1], PIVOT[2]), (0.075, PIVOT[1], PIVOT[2]), 0.085, 0.085, 8, mats['Arm_Metal'], A)
    for i, t in enumerate((0.35, 0.62)):
        p = tuple(PIVOT[k] + (ARM_TIP[k] - PIVOT[k]) * t for k in range(3))
        box(f'ArmStrap{i}', (0.115, 0.03, 0.06), (p[0], p[1], p[2]), mats['Arm_Metal'], A)
    # the bucket sits across the arm, opening up and slightly back
    strut('Bucket', (0.0, 0.455, -0.795), (0.0, 0.615, -0.835), 0.048, 0.115, 10, mats['Arm_Dark'], A)
    ring('BucketBand', (0.0, 0.585, -0.827), 0.105, 0.015, mats['Arm_Metal'], A, 10, 3, axis='y')
    rock('Boulder', (0.0, 0.575, -0.822), 0.082, mats['Arm_Stone'], A)
    box('ArmHook', (0.05, 0.055, 0.05), (0.0, 0.385, -0.685), mats['Arm_Metal'], A)

    # ---- wheels (part 5): spoked, hubbed, iron-tyred in the second age
    for sx in (-1, 1):
        for sz in (-1, 1):
            c = (sx * 0.42, 0.17, sz * 0.36)
            tag = f'{"L" if sx < 0 else "R"}{"B" if sz < 0 else "F"}'
            # the second age runs on steel-shod wheels, the first on bare timber
            ring(f'Rim{tag}', c, 0.134, 0.036, mats['Wheel_Metal' if iron else 'Wheel_Wood'], WH, 12, 4)
            strut(f'Hub{tag}', (c[0] - 0.055, c[1], c[2]), (c[0] + 0.055, c[1], c[2]), 0.05, 0.05, 8,
                  mats['Wheel_Metal'], WH, smooth=True)
            for k in range(6):
                a = k * math.pi / 3
                p1 = (c[0], c[1] + math.sin(a) * 0.135, c[2] + math.cos(a) * 0.135)
                beam(f'Spoke{tag}{k}', c, p1, 0.019, mats['Wheel_Wood'], WH)

    # ---- team colours: a banner at the back corner and a painted board on the front beam
    beam('Pole', (0.30, 0.28, -0.30), (0.30, 0.98, -0.30), 0.019, mats['Dark'], B)
    strut('PoleTip', (0.30, 0.98, -0.30), (0.30, 1.04, -0.30), 0.032, 0.0, 6, mats['Metal'], B)
    banner_cloth('Banner', (0.305, 0.93, -0.295), 0.30, 0.26, mats['Team'], B, yaw=-0.55)
    # a mantlet leaning off the front beam: the flat the top-down camera sees most of the team colour on
    box('Board', (0.47, 0.25, 0.025), (0, 0.40, 0.47), mats['Team'], B, rot=(math.radians(-42), 0, 0))
    for s in (-1, 1):
        box(f'BoardTrim{s}', (0.04, 0.28, 0.035), (s * 0.27, 0.40, 0.47), mats['Dark'], B, rot=(math.radians(-42), 0, 0))

# ---------------------------------------------------------------- export & preview

def pose_arm(angle):
    """Swing the arm the way the renderer's shader does (rotate part 6 around the axle) - used by the preview
    renders to check that the arm clears the frame and comes to rest against the padded beam."""
    piv = to_bl(PIVOT)
    m = Matrix.Translation(piv) @ Matrix.Rotation(angle, 4, 'X') @ Matrix.Translation(-piv)
    for o in bpy.data.collections['Arm'].objects:
        o.matrix_world = m @ o.matrix_world


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
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_apply=True,
                              export_normals=True, export_texcoords=False, export_tangents=False,
                              export_animations=False, export_cameras=False, export_lights=False,
                              export_yup=True, export_extras=False)

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

def render(cam, path, eye, target=(0, 0.5, -0.1)):
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    sh = scene.display.shading
    for attr, value in (('light', 'STUDIO'), ('color_type', 'MATERIAL'), ('color', 'MATERIAL'),
                        ('show_cavity', True), ('show_object_outline', True)):
        if hasattr(sh, attr):
            setattr(sh, attr, value)
    scene.render.resolution_x = 900
    scene.render.resolution_y = 620
    scene.render.film_transparent = False
    cam.location = to_bl(eye)
    cam.rotation_mode = 'QUATERNION'
    cam.rotation_quaternion = (to_bl(eye) - to_bl(target)).to_track_quat('Z', 'Y')
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)

def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = argv[argv.index('--out') + 1] if '--out' in argv else 'models/custom'
    preview = argv[argv.index('--render') + 1] if '--render' in argv else None
    pose = float(argv[argv.index('--pose') + 1]) if '--pose' in argv else 0.0
    for age, iron in (('FirstAge', False), ('SecondAge', True)):
        reset_scene()
        bpy.context.preferences.filepaths.save_version = 0
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
        tris = 0
        for o in bpy.data.objects:
            if o.type == 'MESH':
                o.data.calc_loop_triangles()
                tris += len(o.data.loop_triangles)
        print(f'[catapult] {age}: {len(bpy.data.objects)} objects, {tris} triangles')

main()
