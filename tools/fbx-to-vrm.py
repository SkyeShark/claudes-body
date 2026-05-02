"""
fbx-to-vrm.py — Convert finalCLAUDEweightpaint.fbx into a fully-functional
VRM 1.0 file with:
  - Tail re-parented to Hips so the spring-bone chain has a humanoid root
  - VRM humanoid bones mapped from the existing skeleton
  - Cute 3D eye and mouth geometry with blendshape morphs for visemes,
    blink, and the standard emotions
  - Spring bones configured along the tail chain
  - Standard VRM expressions (aa/ih/ou/ee/oh, blink, happy/sad/angry/...)

Run:
    "C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe" \\
        --background --python tools/fbx-to-vrm.py
"""

import bpy
import bmesh
import math
import sys
from mathutils import Vector, Matrix


def parent_to_head_bone(obj, armature, bone_name='Head'):
    """Parent `obj` to a bone, preserving the object's existing world transform.

    `parent_type='BONE'` parents to the bone's TAIL by default and resets
    matrix_parent_inverse to identity, which would teleport the object. We
    compute the correct parent_inverse so the object stays put.
    """
    obj.parent = armature
    obj.parent_type = 'BONE'
    obj.parent_bone = bone_name
    bpy.context.view_layer.update()
    pbone = armature.pose.bones[bone_name]
    bone_world = armature.matrix_world @ pbone.matrix
    tail_offset = Matrix.Translation(Vector((0, pbone.length, 0)))
    obj.matrix_parent_inverse = (bone_world @ tail_offset).inverted()
    bpy.context.view_layer.update()

INPUT_FBX  = r"C:\Users\sdn52\OneDrive\Desktop\claudethinking\finalCLAUDEweightpaint.fbx"
OUTPUT_VRM = r"C:\Users\sdn52\OneDrive\Desktop\claudethinking\claude.vrm"

# ---------------------------------------------------------------------------
# 1. Reset, enable VRM addon, import.
#    `read_factory_settings(use_empty=True)` clears the prefs registry, so we
#    must re-enable the addon via the operator path — that's what registers
#    the AddonPreferences class. The lower-level `addon_utils.enable()`
#    skips this and leaves `context.preferences.addons["...vrm"]` absent,
#    which makes the addon's own `get_preferences()` blow up at export time.
# ---------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)

ADDON_NAME = 'bl_ext.blender_org.vrm'
if ADDON_NAME not in bpy.context.preferences.addons:
    try:
        bpy.ops.preferences.addon_enable(module=ADDON_NAME)
    except Exception as e:
        print(f"[vrm] addon_enable via operator failed: {e}")
# Last-resort fallback: install a stub preferences object if registration
# still didn't take. The validation step only reads a handful of bools, all of
# which can come from a SimpleNamespace.
if ADDON_NAME not in bpy.context.preferences.addons:
    print("[vrm] WARNING: addon prefs missing — patching get_preferences with a stub")
    from types import SimpleNamespace
    import importlib
    prefs_mod = importlib.import_module('bl_ext.blender_org.vrm.common.preferences')
    _stub = SimpleNamespace(
        export_invisibles=False, export_only_selections=False,
        enable_advanced_preferences=False, export_fb_ngon_encoding=False,
        export_all_influences=False, export_lights=False, export_gltf_animations=False,
        export_try_sparse_sk=False, export_try_omit_sparse_sk=False,
        export_apply=False, extract_textures_into_folder=False,
        make_new_texture_folder=False,
        set_shading_type_to_material_on_import=False,
        set_view_transform_to_standard_on_import=False,
        set_armature_display_to_wire=False,
        set_armature_display_to_show_in_front=False,
        set_armature_bone_shape_to_default=False,
        enable_mtoon_outline_preview=False,
    )
    prefs_mod.get_preferences = lambda ctx: _stub

bpy.ops.import_scene.fbx(filepath=INPUT_FBX)

armature = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
mesh     = next((o for o in bpy.data.objects if o.type == 'MESH'), None)
if not (armature and mesh):
    print("[ERR] need both armature and mesh"); sys.exit(1)
print(f"[in] armature={armature.name}  mesh={mesh.name}  verts={len(mesh.data.vertices)}")

# ---------------------------------------------------------------------------
# 2. Re-parent the tail chain to Hips.
#    The FBX has tailbase as a separate root; VRM requires a single skeleton
#    rooted at hips for spring bones to attach properly.
# ---------------------------------------------------------------------------
bpy.context.view_layer.objects.active = armature
bpy.ops.object.mode_set(mode='EDIT')
edit_bones = armature.data.edit_bones
if 'tailbase' in edit_bones and 'Hips' in edit_bones:
    if edit_bones['tailbase'].parent is None:
        edit_bones['tailbase'].parent = edit_bones['Hips']
        edit_bones['tailbase'].use_connect = False
        print("[rig] re-parented tailbase → Hips")
bpy.ops.object.mode_set(mode='OBJECT')

# ---------------------------------------------------------------------------
# 3. Find anchor positions on the head for placing facial geometry.
#    The model has a `headfront` bone whose head/tail describe the front of
#    the face. We read that to position eyes and mouth.
# ---------------------------------------------------------------------------
arm_world = armature.matrix_world
head_bone     = armature.data.bones.get('Head')
headfront     = armature.data.bones.get('headfront')
headfront_end = armature.data.bones.get('headfront_end')
if not (head_bone and headfront):
    print("[ERR] no Head/headfront bones to anchor face features"); sys.exit(1)

head_world  = arm_world @ head_bone.head_local
front_world = arm_world @ headfront.head_local
front_end   = arm_world @ (headfront_end.head_local if headfront_end else headfront.tail_local)

# The face plane: a normal pointing from head center to headfront tip.
face_normal = (front_end - head_world)
face_normal.normalize()
# Distance from head center along the face normal to place the eyes/mouth.
face_radius = (front_end - head_world).length
print(f"[face] head={tuple(round(x,3) for x in head_world)}  front_normal={tuple(round(x,3) for x in face_normal)}  radius={face_radius:.3f}")

# Build a basis for placing 2D shapes flat against the face.
WORLD_UP = Vector((0, 0, 1))
face_right = face_normal.cross(WORLD_UP)
if face_right.length < 1e-4:
    face_right = Vector((1, 0, 0))
face_right.normalize()
face_up = face_right.cross(face_normal).normalized()

# Default forward push for face features. The headfront bone tip is buried
# inside the head sphere on this rig, so we add a generous standoff (15% of
# the face radius ≈ 5cm) to put features cleanly on the visible surface.
FACE_STANDOFF = face_radius * 0.15

def face_point(across, vertical, depth_offset=0.0):
    """across = horizontal offset on face; vertical = up offset; depth_offset = on top of FACE_STANDOFF."""
    push = FACE_STANDOFF + depth_offset
    return front_end + face_right * across + face_up * vertical + face_normal * push

# ---------------------------------------------------------------------------
# 4. Build cute eye geometry — two flat dark ellipses, slightly raised
#    above the face surface, with shape keys for blink / happy / sad / wide.
# ---------------------------------------------------------------------------
def make_eye(name, center, size=None, kind='pupil'):
    """Create a flat ellipse mesh facing along face_normal.

    kind='white' = larger background (sclera), white-ish material
    kind='pupil' = smaller foreground dot, dark material
    Both layered together with a slight depth offset give cute anime eyes."""
    if size is None:
        if kind == 'white':
            size = (head_extent_lateral * 0.07, head_extent_vertical * 0.095)
        else:  # pupil
            size = (head_extent_lateral * 0.035, head_extent_vertical * 0.055)
    mesh_data = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh_data)
    bpy.context.scene.collection.objects.link(obj)

    bm = bmesh.new()
    # Build verts directly in object-local space — flat ellipse on the
    # face plane, centered at origin. The object will be placed at `center`
    # in world space via parent_to_head_bone below.
    n = 16
    verts = []
    for i in range(n):
        a = (i / n) * 2 * math.pi
        across   = math.cos(a) * size[0]
        vertical = math.sin(a) * size[1]
        # Local position = offset along face axes (face_right * across +
        # face_up * vertical). No depth_offset here — center already has the
        # eye's forward push baked in.
        local = face_right * across + face_up * vertical
        verts.append(bm.verts.new(local))
    bm.faces.new(verts)
    bm.normal_update()
    bm.to_mesh(mesh_data)
    bm.free()

    obj.location = center
    # Material: white sclera or dark pupil, depending on layer.
    mat = bpy.data.materials.new(name + "_mat")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        if kind == 'white':
            bsdf.inputs["Base Color"].default_value = (0.97, 0.95, 0.93, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.4
        else:  # pupil
            bsdf.inputs["Base Color"].default_value = (0.04, 0.04, 0.06, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.35
    mesh_data.materials.append(mat)

    # Parent to the head bone so the eye follows the head.
    parent_to_head_bone(obj, armature, 'Head')
    return obj

# --- discover the head mesh's actual bounding box. The head bone is often
# at the BOTTOM of the head sphere (where it attaches to neck), so anchoring
# face features at the bone position lands them under the chin. We isolate
# the head vertices via the 'Head' vertex group and use the bbox center.
head_center = head_world
head_extent_along_normal = face_radius
head_extent_lateral = face_radius
head_extent_vertical = face_radius
# Anchor face features using the headfront bone chain — these bones were
# placed inside the face during rigging, so their world positions reliably
# tell us where the face is. The mane petals share the Head vertex group
# but are spatially far from the headfront chain, which lets us derive face
# placement WITHOUT needing to filter the messy head vertex group.
#
# Layout assumed in the source rig:
#   Head           - bottom of head sphere, where neck attaches
#   headfront      - mid-face (mouth/eye level), pointing forward+up
#   headfront_end  - front of face / nose tip
#
# So:
#   face_anchor = headfront tip (mid-face)
#   head_extent_vertical/lateral derived from head bone length × an estimate.
head_bone_length_world = (arm_world @ head_bone.tail_local - head_world).length
# Head sphere is typically slightly taller than the head bone is long.
head_extent_vertical     = head_bone_length_world * 1.5
head_extent_lateral      = head_bone_length_world * 1.4
head_extent_along_normal = face_radius
print(f"[head] head bone length={head_bone_length_world:.3f}; derived vertical={head_extent_vertical:.3f} lateral={head_extent_lateral:.3f}")

# Anchor face features at the head bone's MIDPOINT between its head and
# tail in world space — this is roughly the center of the head sphere on
# typical rigs. Push forward along face_normal to reach the visible front
# of the head, plus the standoff.
head_tail_world = arm_world @ head_bone.tail_local
head_sphere_center = (head_world + head_tail_world) * 0.5
face_anchor = head_sphere_center + face_normal * (head_extent_along_normal * 0.5 + FACE_STANDOFF)
print(f"[face] head_sphere_center={tuple(round(x,3) for x in head_sphere_center)} anchor={tuple(round(x,3) for x in face_anchor)}")

# Override face_point to use the head-bbox-derived anchor.
def face_point(across, vertical, depth_offset=0.0):
    return face_anchor + face_right * across + face_up * vertical + face_normal * depth_offset

# Eye placement: bring them closer together (~17% of head lateral) for a
# cuter anime look, slight rise above sphere center.
eye_off_x = head_extent_lateral * 0.17
eye_off_y = head_extent_vertical * 0.05
EYE_WHITE_DEPTH = 0.012   # sclera (white) layer — closest to head surface
EYE_PUPIL_DEPTH = 0.014   # pupil layer — slightly in front of the white
BROW_DEPTH      = 0.016
MOUTH_DEPTH     = 0.010
# White sclera centers (full eye outline)
left_white_center  = face_point(-eye_off_x, eye_off_y, depth_offset=EYE_WHITE_DEPTH)
right_white_center = face_point( eye_off_x, eye_off_y, depth_offset=EYE_WHITE_DEPTH)
# Pupil centers — slightly inset from the white center, gives subtle "looking
# inward" cute look. Pupils are placed just below the white center vertically.
pupil_inset   = head_extent_lateral * 0.005
pupil_drop    = head_extent_vertical * 0.005
left_pupil_center  = face_point(-eye_off_x + pupil_inset, eye_off_y - pupil_drop, depth_offset=EYE_PUPIL_DEPTH)
right_pupil_center = face_point( eye_off_x - pupil_inset, eye_off_y - pupil_drop, depth_offset=EYE_PUPIL_DEPTH)
print(f"[eyes] white-L={tuple(round(x,3) for x in left_white_center)}  pupil-L={tuple(round(x,3) for x in left_pupil_center)}")

# Build each eye as a stack: white sclera + dark pupil on top.
left_white  = make_eye('eye.L.white',  left_white_center,  kind='white')
right_white = make_eye('eye.R.white',  right_white_center, kind='white')
left_eye    = make_eye('eye.L',        left_pupil_center,  kind='pupil')
right_eye   = make_eye('eye.R',        right_pupil_center, kind='pupil')

def add_eye_shapekeys(eye_obj):
    """Add Basis + named shape keys driving the eye's visual state.

    Shape key data starts as a copy of the basis. We modify the COPY by
    transforming each basis vertex into the desired target shape, then
    write that target into sk.data[i].co. At rest (weight 0) Blender shows
    basis; at weight 1 it shows the target shape; weights blend smoothly.
    """
    if eye_obj.data.shape_keys is None:
        eye_obj.shape_key_add(name='Basis')
    me = eye_obj.data
    eye_height = head_extent_vertical * 0.07

    def add_key(name, transform_fn):
        sk = eye_obj.shape_key_add(name=name)
        for i, v in enumerate(me.vertices):
            sk.data[i].co = transform_fn(v.co.copy())

    # blink: squash to a thin horizontal line (10% of original height).
    def blink(co):
        up = face_up.dot(co)
        return co - face_up * (up * 0.9)
    add_key('blink', blink)

    # lookHappy: gentle ^^ arc — center pushed up.
    def happy(co):
        right_off = face_right.dot(co)
        norm = right_off / max(0.001, eye_height * 1.5)
        bump = max(0.0, 1.0 - norm*norm) * eye_height * 0.6
        return co + face_up * bump
    add_key('lookHappy', happy)

    # lookSurprised: scale up 25%.
    def surprised(co):
        return co * 1.25
    add_key('lookSurprised', surprised)

    # lookSad: gentle vv arc — center pushed down.
    def sad(co):
        right_off = face_right.dot(co)
        norm = right_off / max(0.001, eye_height * 1.5)
        bump = max(0.0, 1.0 - norm*norm) * eye_height * 0.6
        return co - face_up * bump
    add_key('lookSad', sad)

add_eye_shapekeys(left_eye)
add_eye_shapekeys(right_eye)
add_eye_shapekeys(left_white)
add_eye_shapekeys(right_white)
print("[eyes] created (white sclera + pupil) with blink + happy/surprised/sad shape keys")

# ---------------------------------------------------------------------------
# 4b. Build eyebrow geometry — two small flat strokes above each eye, with
#     shape keys for raised / furrow (angry) / worried (concerned slope).
#     Each brow is built as a thin flat ellipse so it can flex around its
#     own midline; rest pose is a near-flat horizontal stroke.
# ---------------------------------------------------------------------------
def make_brow(name, center, side):
    """Create a thin flat brow stroke. side=-1 for left brow, +1 for right."""
    mesh_data = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh_data)
    bpy.context.scene.collection.objects.link(obj)

    bm = bmesh.new()
    # 8-vertex thin flat ellipse — wide horizontally, very thin vertically.
    # Built in object-local space (centered at origin).
    n = 8
    width  = head_extent_lateral * 0.07
    height = head_extent_vertical * 0.012
    verts = []
    for i in range(n):
        a = (i / n) * 2 * math.pi
        across   = math.cos(a) * width
        vertical = math.sin(a) * height
        local = face_right * across + face_up * vertical
        verts.append(bm.verts.new(local))
    bm.faces.new(verts)
    bm.normal_update()
    bm.to_mesh(mesh_data)
    bm.free()

    obj.location = center

    # Match eye material — flat dark.
    mat = bpy.data.materials.new(name + "_mat")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.05, 0.05, 0.06, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.5
    mesh_data.materials.append(mat)

    parent_to_head_bone(obj, armature, 'Head')
    obj["brow_side"] = side
    return obj

# Brow placement: brow center sits ~2cm above the eye top edge (inside the
# head sphere, never above it). Uses the actual eye half-height (0.07).
eye_half_height = head_extent_vertical * 0.07
brow_off_y = eye_off_y + eye_half_height + head_extent_vertical * 0.04
left_brow_center  = face_point(-eye_off_x, brow_off_y, depth_offset=BROW_DEPTH)
right_brow_center = face_point( eye_off_x, brow_off_y, depth_offset=BROW_DEPTH)

left_brow  = make_brow('brow.L', left_brow_center, side=-1)
right_brow = make_brow('brow.R', right_brow_center, side=+1)

def add_brow_shapekeys(brow_obj):
    """Brow shape keys. side from custom prop: -1 = left (inner edge is +face_right),
    +1 = right (inner edge is -face_right)."""
    if brow_obj.data.shape_keys is None:
        brow_obj.shape_key_add(name='Basis')
    me = brow_obj.data
    side = brow_obj.get("brow_side", -1)

    # raised: lift the whole brow up.
    sk = brow_obj.shape_key_add(name='raised')
    lift = face_radius * 0.06
    for i in range(len(me.vertices)):
        sk.data[i].co = me.vertices[i].co + face_up * lift

    # furrow (angry): inner end down, outer end neutral. Creates the
    # \__/ scowl when both brows fire together.
    sk = brow_obj.shape_key_add(name='furrow')
    for i in range(len(me.vertices)):
        base = me.vertices[i].co.copy()
        right_off = face_right.dot(base)  # signed horizontal in face plane
        # Inner side has sign opposite to `side`: for left brow (side=-1),
        # inner is positive face_right. For right brow (side=+1), inner is
        # negative face_right. So inner_factor goes 0..1 as we move inward.
        inner_factor = max(0.0, -side * right_off / max(0.001, face_radius * 0.13))
        drop = inner_factor * face_radius * 0.05
        sk.data[i].co = base - face_up * drop

    # worried (concerned/sad slope): inner end UP, outer end down — the
    # classic puppy-dog sad brow.
    sk = brow_obj.shape_key_add(name='worried')
    for i in range(len(me.vertices)):
        base = me.vertices[i].co.copy()
        right_off = face_right.dot(base)
        inner_factor = max(0.0, -side * right_off / max(0.001, face_radius * 0.13))
        outer_factor = max(0.0,  side * right_off / max(0.001, face_radius * 0.13))
        rise = inner_factor * face_radius * 0.05 - outer_factor * face_radius * 0.025
        sk.data[i].co = base + face_up * rise

add_brow_shapekeys(left_brow)
add_brow_shapekeys(right_brow)
print("[brows] created with raised/furrow/worried shape keys")

# ---------------------------------------------------------------------------
# 5. Build mouth geometry — a small curve mesh on the lower face.
#    Visemes (aa/ih/ou/ee/oh) + emotion shapes are blendshapes on this mesh.
# ---------------------------------------------------------------------------
def make_mouth():
    name = 'mouth'
    mesh_data = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh_data)
    bpy.context.scene.collection.objects.link(obj)

    bm = bmesh.new()
    # Rest mouth: a thin horizontal lens (closed mouth, slight smile when
    # the corners curve up via `happy` shape key). Built as 14 verts in a
    # closed ring around the lens outline so the smile shape key has enough
    # control points to bend the corners up.
    n = 14
    half_n = n // 2
    width  = head_extent_lateral * 0.11
    thick  = head_extent_vertical * 0.010
    verts = []
    # Top edge (left → right): straight horizontal at +thick/2.
    for i in range(half_n):
        t = -1.0 + (2.0 * i / (half_n - 1))
        verts.append(bm.verts.new(face_right * (t * width) + face_up * (thick * 0.5)))
    # Bottom edge (right → left): straight horizontal at -thick/2.
    for i in range(half_n):
        t = 1.0 - (2.0 * i / (half_n - 1))
        verts.append(bm.verts.new(face_right * (t * width) + face_up * (-thick * 0.5)))
    bm.faces.new(verts)
    bm.normal_update()
    bm.to_mesh(mesh_data)
    bm.free()

    # Mouth sits ~15% of head height below the face anchor — comfortably
    # under the eyes but still inside the lower half of the head sphere.
    mouth_center = face_point(0.0, -head_extent_vertical * 0.15, depth_offset=MOUTH_DEPTH)
    obj.location = mouth_center

    # Dark interior with subtle warmth (matches mouthIn color from SVG).
    mat = bpy.data.materials.new(name + "_mat")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.35, 0.13, 0.19, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.7
    mesh_data.materials.append(mat)

    parent_to_head_bone(obj, armature, 'Head')
    return obj

mouth = make_mouth()

def add_mouth_shapekeys(obj):
    """Standard VRM viseme + emotion blendshapes for the mouth."""
    if obj.data.shape_keys is None:
        obj.shape_key_add(name='Basis')
    me = obj.data

    # Build viseme targets as ABSOLUTE shapes (not scale factors). The
    # rest mouth is intentionally thin (~4mm tall), so multiplying its
    # vertical extent by 4× still doesn't look like an open mouth — it
    # just looks like a slightly thicker line, while any horizontal
    # change is much more visible because the rest mouth is already wide.
    # We solve this by setting target half-widths/half-heights directly.
    base_w = head_extent_lateral * 0.11    # rest mouth half-width
    head_v = head_extent_vertical          # for sizing target heights

    def viseme(name, half_w, half_h):
        """Build a target shape: lens of given half-width × half-height,
        keeping each vertex's relative position around the loop."""
        sk = obj.shape_key_add(name=name)
        for i in range(len(me.vertices)):
            base = me.vertices[i].co.copy()
            # Recover (sign of face_right component, sign of face_up component)
            # from the basis vert; that tells us its position in the lens.
            r = face_right.dot(base)
            u = face_up.dot(base)
            # Normalize to ±1 along the basis lens shape.
            r_frac = r / max(0.001, base_w)            # in [-1, +1]
            u_sign = 1.0 if u > 0 else -1.0            # top or bottom edge
            new_r = r_frac * half_w
            new_u = u_sign * half_h
            sk.data[i].co = face_right * new_r + face_up * new_u

    # VRM 1.0 standard visemes. Heights in absolute world meters.
    viseme('aa', half_w=base_w * 0.55, half_h=head_v * 0.060)  # tall round open "ah"
    viseme('ih', half_w=base_w * 0.85, half_h=head_v * 0.020)  # slightly open "ih"
    viseme('ou', half_w=base_w * 0.30, half_h=head_v * 0.040)  # narrow "ooo"
    viseme('ee', half_w=base_w * 1.05, half_h=head_v * 0.012)  # wide flat "ee"
    viseme('oh', half_w=base_w * 0.40, half_h=head_v * 0.055)  # round "oh"

    # Emotion shapes — combined with eye/brow shapes via VRM expression presets.
    mouth_width = head_extent_lateral * 0.11
    smile_lift  = head_extent_vertical * 0.04   # how high corners go on smile

    # 'happy' = SMILE: corners up, middle stays. Quadratic curve via x².
    sk = obj.shape_key_add(name='happy')
    for i in range(len(me.vertices)):
        base = me.vertices[i].co.copy()
        right_off = face_right.dot(base)
        # corner_factor = 1.0 at corners, 0.0 at center
        corner_factor = (right_off / max(0.001, mouth_width)) ** 2
        sk.data[i].co = base + face_up * (corner_factor * smile_lift)

    # 'sad' = FROWN: corners down.
    sk = obj.shape_key_add(name='sad')
    for i in range(len(me.vertices)):
        base = me.vertices[i].co.copy()
        right_off = face_right.dot(base)
        corner_factor = (right_off / max(0.001, mouth_width)) ** 2
        sk.data[i].co = base - face_up * (corner_factor * smile_lift)

    sk = obj.shape_key_add(name='surprised')
    for i in range(len(me.vertices)):
        base = me.vertices[i].co.copy()
        # Round open shape
        right_off = face_right.dot(base)
        up_off    = face_up.dot(base)
        sk.data[i].co = (
            base
            - face_right * right_off - face_up * up_off
            + face_right * right_off * 0.55 + face_up * up_off * 3.5
        )

    sk = obj.shape_key_add(name='angry')
    for i in range(len(me.vertices)):
        base = me.vertices[i].co.copy()
        right_off = face_right.dot(base)
        # Frown corners + slight compress
        bump = (abs(right_off) / max(0.001, face_radius*0.30)) * -0.012
        sk.data[i].co = base + face_up * bump

    sk = obj.shape_key_add(name='relaxed')
    for i in range(len(me.vertices)):
        base = me.vertices[i].co.copy()
        right_off = face_right.dot(base)
        bump = (right_off / max(0.001, face_radius*0.30))**2 * 0.008
        sk.data[i].co = base + face_up * bump

add_mouth_shapekeys(mouth)
print("[mouth] created with aa/ih/ou/ee/oh + happy/sad/surprised/angry/relaxed")

# ---------------------------------------------------------------------------
# 5b. Convert all materials to MToon (toon-shaded). Body / mane / clothing
#     get a black inverted-hull outline (0.01m world space). Face features
#     (eyes/brows/mouth) keep MToon shading but skip the outline so they
#     don't get a thicker dark border on top of their already-dark color.
#
#     MToon color setup: brighter base color in lit areas, original/darker
#     color used as the shade (in shadow). Gives readable cell-shading.
# ---------------------------------------------------------------------------
def lighten(rgb, factor=0.30):
    """Lighten an RGB triple by mixing toward white. factor 0.0 = no change."""
    return tuple(min(1.0, c + (1.0 - c) * factor) for c in rgb[:3])

def darken(rgb, factor=0.45):
    """Darken an RGB triple by scaling toward black."""
    return tuple(max(0.0, c * (1.0 - factor)) for c in rgb[:3])

def configure_mtoon(material, *, with_outline, outline_width=0.01, brighten=True):
    """Switch a material to MToon. with_outline=True adds a 0.01m black hull.
    brighten=False keeps the original color (use for already-dark features)."""
    src_rgb = (0.7, 0.7, 0.7)
    if material.use_nodes:
        bsdf = material.node_tree.nodes.get("Principled BSDF")
        if bsdf and "Base Color" in bsdf.inputs:
            src_rgb = bsdf.inputs["Base Color"].default_value[:3]

    if brighten:
        bright_rgb = lighten(src_rgb, 0.15)  # main / lit areas (subtle lift)
        shade_rgb  = darken(src_rgb, 0.20)   # gentle shadow tint
    else:
        bright_rgb = src_rgb                  # keep dark features dark
        shade_rgb  = darken(src_rgb, 0.30)

    # Switch to MToon. The setter on `enabled` runs the convert operator and
    # flips the internal flag so the VRM exporter writes VRMC_materials_mtoon.
    mt = material.vrm_addon_extension.mtoon1
    mt.enabled = True
    mt.pbr_metallic_roughness.base_color_factor = (*bright_rgb, 1.0)

    mtoon = mt.extensions.vrmc_materials_mtoon
    mtoon.shade_color_factor = shade_rgb
    # shading_toony_factor near 1.0 = sharp two-tone toon shading
    mtoon.shading_toony_factor = 0.95
    # shading_shift moves the lit/shade boundary; 0 = at the geometric terminator
    mtoon.shading_shift_factor = -0.1

    if with_outline:
        mtoon.outline_width_mode = 'worldCoordinates'
        mtoon.outline_width_factor = outline_width
        mtoon.outline_color_factor = (0.0, 0.0, 0.0)
        mtoon.outline_lighting_mix_factor = 0.0   # pure black, ignore lighting
    else:
        mtoon.outline_width_mode = 'none'

OUTLINE_W = 0.01
# All face features skip outlines (flat planes don't shell-extrude cleanly,
# and the contrast against the head is already strong enough) and skip the
# brightening pass (their colors are already final).
face_mats = {'eye.L_mat', 'eye.R_mat', 'brow.L_mat', 'brow.R_mat', 'mouth_mat',
             'eye.L.white_mat', 'eye.R.white_mat'}
no_outline_mats = face_mats
no_brighten_mats = face_mats
n_mtoon = 0
for m in bpy.data.materials:
    if m.name == 'Dots Stroke':  # Blender-internal material
        continue
    try:
        configure_mtoon(
            m,
            with_outline=(m.name not in no_outline_mats),
            outline_width=OUTLINE_W,
            brighten=(m.name not in no_brighten_mats),
        )
        n_mtoon += 1
    except Exception as e:
        print(f"[mtoon] {m.name}: failed → {e}")
print(f"[mtoon] converted {n_mtoon} materials with {OUTLINE_W}m black outlines on body/mane/clothing/eye-whites")

# ---------------------------------------------------------------------------
# 6. Configure VRM 1.0 humanoid mapping via the saturday06 addon API.
# ---------------------------------------------------------------------------
print("[vrm] configuring extension data on armature")
# The addon stores its data on armature.data.vrm_addon_extension. The addon
# itself was already enabled at the top of the script.
ext = armature.data.vrm_addon_extension
ext.spec_version = '1.0'
hb = ext.vrm1.humanoid.human_bones

# Map the mandatory humanoid bones. The Spine0X chain in this rig is
# inverted (Spine02 closest to hips → Spine highest), so we map by
# distance-to-hips rather than name.
mapping = {
    'hips':           'Hips',
    'spine':          'Spine02',
    'chest':          'Spine01',
    'upper_chest':    'Spine',
    'neck':           'neck',
    'head':           'Head',
    'left_shoulder':  'LeftShoulder',
    'left_upper_arm': 'LeftArm',
    'left_lower_arm': 'LeftForeArm',
    'left_hand':      'LeftHand',
    'right_shoulder': 'RightShoulder',
    'right_upper_arm':'RightArm',
    'right_lower_arm':'RightForeArm',
    'right_hand':     'RightHand',
    'left_upper_leg': 'LeftUpLeg',
    'left_lower_leg': 'LeftLeg',
    'left_foot':      'LeftFoot',
    'left_toes':      'LeftToeBase',
    'right_upper_leg':'RightUpLeg',
    'right_lower_leg':'RightLeg',
    'right_foot':     'RightFoot',
    'right_toes':     'RightToeBase',
}
for vrm_name, bone_name in mapping.items():
    if bone_name in armature.data.bones:
        try:
            getattr(hb, vrm_name).node.bone_name = bone_name
        except AttributeError:
            print(f"[vrm] addon has no slot for {vrm_name}, skipping")
print(f"[vrm] mapped {len(mapping)} humanoid bones")

# ---------------------------------------------------------------------------
# 7. Spring bones for the tail chain.
# ---------------------------------------------------------------------------
spring = ext.spring_bone1
# Add a collider group? Not strictly needed for a free tail.
# Add a spring chain: joints from tailbase through tailtip_end_end.
chain_bones = ['tailbase', 'tail.001', 'tail.002', 'tail.003', 'tail.004',
               'tail.005', 'tail.006', 'tail.007', 'tailtip', 'tailtip_end']
chain_bones = [b for b in chain_bones if b in armature.data.bones]

if hasattr(spring, 'springs') and chain_bones:
    s = spring.springs.add()
    s.vrm_name = 'tail'
    for bn in chain_bones:
        j = s.joints.add()
        j.node.bone_name = bn
        j.hit_radius   = 0.02
        j.stiffness    = 0.5
        j.gravity_power= 0.4
        j.gravity_dir  = (0.0, 0.0, -1.0)
        j.drag_force   = 0.4
    print(f"[spring] tail chain configured with {len(chain_bones)} joints")

# ---------------------------------------------------------------------------
# 8. VRM expressions — wire the shape keys into expression presets so
#    runtime lipsync / blink / emotion calls reach the right blendshapes.
# ---------------------------------------------------------------------------
expr_root = ext.vrm1.expressions

def bind_morph(expr, mesh_obj, key_name, weight=1.0):
    """Add a morph-target binding to an expression preset."""
    binds = expr.morph_target_binds
    b = binds.add()
    b.node.mesh_object_name = mesh_obj.name
    b.index = key_name
    b.weight = weight

# Visemes — both eyes and mouth combine for richer expression where useful.
# Brows reinforce emotion presets: happy/surprised raise both brows, angry
# furrows them, sad uses the worried slope.
# Drive both pupil and white-sclera layers in lockstep — when the eye blinks
# or arcs into a happy/sad shape, both layers move together so the eye stays
# coherent.
def eye_pair(shape):
    """Return all 4 (mesh, shape, weight) entries for both eyes' pupil + white."""
    return [(left_eye, shape, 1.0), (right_eye, shape, 1.0),
            (left_white, shape, 1.0), (right_white, shape, 1.0)]

preset_pairs = [
    ('aa',         [(mouth, 'aa', 1.0)]),
    ('ih',         [(mouth, 'ih', 1.0)]),
    ('ou',         [(mouth, 'ou', 1.0)]),
    ('ee',         [(mouth, 'ee', 1.0)]),
    ('oh',         [(mouth, 'oh', 1.0)]),
    ('blink',      eye_pair('blink')),
    ('happy',      [(mouth, 'happy', 1.0)] + eye_pair('lookHappy') +
                   [(left_brow, 'raised', 0.6), (right_brow, 'raised', 0.6)]),
    ('sad',        [(mouth, 'sad', 1.0)] + eye_pair('lookSad') +
                   [(left_brow, 'worried', 1.0), (right_brow, 'worried', 1.0)]),
    ('angry',      [(mouth, 'angry', 1.0),
                    (left_brow, 'furrow', 1.0), (right_brow, 'furrow', 1.0)]),
    ('surprised',  [(mouth, 'surprised', 1.0)] + eye_pair('lookSurprised') +
                   [(left_brow, 'raised', 1.0), (right_brow, 'raised', 1.0)]),
    ('relaxed',    [(mouth, 'relaxed', 1.0)]),
]
for preset_name, binds in preset_pairs:
    preset = getattr(expr_root.preset, preset_name, None)
    if preset is None:
        print(f"[expr] no preset {preset_name}, skipping")
        continue
    for mesh_obj, key_name, weight in binds:
        bind_morph(preset, mesh_obj, key_name, weight)
print("[expr] viseme + emotion presets bound")

# ---------------------------------------------------------------------------
# 9. Export VRM.
# ---------------------------------------------------------------------------
print(f"[out] exporting → {OUTPUT_VRM}")
# Select armature so the addon picks the right rig.
bpy.ops.object.select_all(action='DESELECT')
armature.select_set(True)
bpy.context.view_layer.objects.active = armature

# The export operator changes name across addon versions; try both.
try:
    bpy.ops.export_scene.vrm(filepath=OUTPUT_VRM)
except Exception as e:
    print(f"[out] export_scene.vrm failed: {e}")
    try:
        bpy.ops.vrm.export_vrm(filepath=OUTPUT_VRM)
    except Exception as e2:
        print(f"[out] vrm.export_vrm failed: {e2}")
        sys.exit(1)

print("[done]")
