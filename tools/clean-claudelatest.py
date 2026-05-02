"""
clean-claudelatest.py — Take the user's manually-edited claudelatest.vrm and
clean up the parts they couldn't easily wire by hand:

1. Detect the new face meshes (eyes / brows / mouth, in any naming variant).
2. Re-bind every relevant shape key into the VRM 1.0 standard expression
   presets (happy / sad / angry / surprised / relaxed / aa / ih / ou / ee /
   oh / blink), so VRMA-driven animations move the whole face coherently.
3. Configure MToon shading on the new face materials (no outline, no
   brightening — those are already final colors).
4. Preserve everything else the user set up: the body mesh, weights, bone
   pose, spring bones, humanoid mapping, body-material outlines.
5. Export to claude.vrm in the project root + assets/ for the renderer.

Run:
    "C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe" \\
        --background --python tools/clean-claudelatest.py
"""

import bpy
import sys
from types import SimpleNamespace

INPUT_VRM  = r"C:\Users\sdn52\OneDrive\Desktop\claudethinking\claudelatest.vrm"
OUTPUT_VRM = r"C:\Users\sdn52\OneDrive\Desktop\claudethinking\claude.vrm"
ASSET_VRM  = r"C:\Users\sdn52\OneDrive\Desktop\claudethinking\claude-says\assets\claude.vrm"

# ---------------------------------------------------------------------------
# Reset, enable VRM addon, import.
# ---------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)

ADDON_NAME = 'bl_ext.blender_org.vrm'
if ADDON_NAME not in bpy.context.preferences.addons:
    try:
        bpy.ops.preferences.addon_enable(module=ADDON_NAME)
    except Exception as e:
        print(f"[vrm] addon_enable via operator failed: {e}")
if ADDON_NAME not in bpy.context.preferences.addons:
    print("[vrm] WARNING: addon prefs missing — patching get_preferences with a stub")
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

# Import VRM. The addon registers an import operator under bpy.ops.import_scene.
print(f"[in] importing {INPUT_VRM}")
bpy.ops.import_scene.vrm(filepath=INPUT_VRM)

armature = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
if not armature:
    print("[ERR] no armature in imported VRM")
    sys.exit(1)
print(f"[in] armature={armature.name}")

# ---------------------------------------------------------------------------
# Catalogue every mesh with shape keys so we know what's available to bind.
# ---------------------------------------------------------------------------
def shape_keys(obj):
    """Return list of shape key names (excluding Basis), or [] if none."""
    if not (obj.type == 'MESH' and obj.data.shape_keys):
        return []
    return [b.name for b in obj.data.shape_keys.key_blocks if b.name != 'Basis']

print("\n[scan] meshes with shape keys:")
all_meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for o in all_meshes:
    sk = shape_keys(o)
    if sk:
        x = round(o.matrix_world.to_translation().x, 3) if o.parent else 0.0
        print(f"  {o.name:30s} keys={sk}  worldX={x}")

# ---------------------------------------------------------------------------
# Identify face feature meshes and assign each to a logical role:
#   eye_pupil_L / eye_pupil_R, eye_white_L / eye_white_R,
#   brow_L / brow_R, mouth.
# Naming in claudelatest.vrm is a bit irregular — both halves use ".L" because
# they were duplicated. We sort by world-space X to figure out which is which:
# +X = the character's LEFT side (Blender convention).
# ---------------------------------------------------------------------------
def by_world_x(meshes):
    return sorted(meshes, key=lambda o: o.matrix_world.to_translation().x)

# Filter classes by name
def filter_meshes(predicate):
    return [o for o in all_meshes if predicate(o.name)]

pupils  = filter_meshes(lambda n: n.startswith('eye.') and 'white' not in n.lower())
whites  = filter_meshes(lambda n: n.startswith('eye.') and 'white' in n.lower())
brows   = filter_meshes(lambda n: n.startswith('brow.'))
mouths  = filter_meshes(lambda n: n.startswith('mouth'))

# Sort each pair: lower world X = right side of character (R), higher = left (L).
def split_lr(meshes):
    if len(meshes) < 2: return (None, meshes[0] if meshes else None)
    s = by_world_x(meshes)
    return (s[-1], s[0])  # (left = +X, right = -X)

eye_L, eye_R   = split_lr(pupils)
white_L, white_R = split_lr(whites)
brow_L, brow_R = split_lr(brows)
mouth = mouths[0] if mouths else None

face = SimpleNamespace(
    eye_L=eye_L, eye_R=eye_R, white_L=white_L, white_R=white_R,
    brow_L=brow_L, brow_R=brow_R, mouth=mouth,
)
print("\n[face] role assignments:")
for k, v in face.__dict__.items():
    print(f"  {k:8s} = {v.name if v else '(none)'}")

# ---------------------------------------------------------------------------
# Helper: find the best-matching shape key on a mesh from a list of candidate
# names. Returns the actual key name found, or None.
# ---------------------------------------------------------------------------
def find_key(obj, candidates):
    if not obj or not obj.data.shape_keys:
        return None
    keys_lower = {b.name.lower(): b.name for b in obj.data.shape_keys.key_blocks}
    for c in candidates:
        if c.lower() in keys_lower:
            return keys_lower[c.lower()]
    # Fallback: substring match
    for c in candidates:
        for low, real in keys_lower.items():
            if c.lower() in low:
                return real
    return None

# ---------------------------------------------------------------------------
# Build expression bindings. For each VRM 1.0 preset, gather (mesh, key)
# pairs from whatever shape keys are actually present on the user's meshes.
# ---------------------------------------------------------------------------
def add_bind(preset_name, items):
    """items = list of (mesh_obj, key_name, weight)."""
    expr = ext.vrm1.expressions.preset
    preset = getattr(expr, preset_name, None)
    if preset is None:
        print(f"[expr] no preset slot {preset_name}, skipping")
        return 0
    # Clear existing bindings the user's file might have for this preset.
    while len(preset.morph_target_binds) > 0:
        preset.morph_target_binds.remove(0)
    n = 0
    for mesh_obj, key_name, weight in items:
        if not (mesh_obj and key_name):
            continue
        b = preset.morph_target_binds.add()
        b.node.mesh_object_name = mesh_obj.name
        b.index = key_name
        b.weight = weight
        n += 1
    return n

ext = armature.data.vrm_addon_extension
print("\n[expr] re-binding VRM expression presets:")

# Pair generators
def pair_bind(shape_key_candidates, *meshes, weight=1.0):
    """Bind one shape key on each given mesh. Picks first matching candidate
    name from each mesh independently."""
    out = []
    for m in meshes:
        if not m: continue
        k = find_key(m, shape_key_candidates)
        if k:
            out.append((m, k, weight))
    return out

# blink: collapse both eye pupils + both eye whites
n = add_bind('blink', pair_bind(
    ['blink', 'closed', 'close'],
    face.eye_L, face.eye_R, face.white_L, face.white_R,
))
print(f"  blink     → {n} binds")

# Visemes (mouth only)
for vis in ('aa', 'ih', 'ou', 'ee', 'oh'):
    n = add_bind(vis, pair_bind([vis], face.mouth))
    print(f"  {vis:9s} → {n} binds")

# happy: smile + brows raised + eyes look-happy
items  = pair_bind(['happy', 'smile'], face.mouth)
items += pair_bind(['lookHappy', 'happy', 'eye_happy', 'happy_eye'],
                   face.eye_L, face.eye_R, face.white_L, face.white_R)
items += [(m, k, 0.6) for (m, k, _) in
          pair_bind(['raised', 'raise', 'up', 'happy', 'brow_up'],
                    face.brow_L, face.brow_R)]
n = add_bind('happy', items)
print(f"  happy     → {n} binds")

# sad: frown mouth + worried brows + eyes-sad
items  = pair_bind(['sad', 'frown'], face.mouth)
items += pair_bind(['lookSad', 'sad'], face.eye_L, face.eye_R, face.white_L, face.white_R)
items += pair_bind(['worried', 'worry', 'sad', 'down'], face.brow_L, face.brow_R)
n = add_bind('sad', items)
print(f"  sad       → {n} binds")

# angry: angry mouth + furrow brows
items  = pair_bind(['angry', 'mad'], face.mouth)
items += pair_bind(['furrow', 'angry', 'down', 'inner_down'], face.brow_L, face.brow_R)
n = add_bind('angry', items)
print(f"  angry     → {n} binds")

# surprised: surprised mouth + wide eyes + raised brows
items  = pair_bind(['surprised', 'wide', 'oh'], face.mouth)
items += pair_bind(['lookSurprised', 'surprised', 'wide'],
                   face.eye_L, face.eye_R, face.white_L, face.white_R)
items += pair_bind(['raised', 'raise', 'up', 'surprised'], face.brow_L, face.brow_R)
n = add_bind('surprised', items)
print(f"  surprised → {n} binds")

# relaxed: relaxed mouth
items = pair_bind(['relaxed', 'relax', 'neutral', 'rest'], face.mouth)
n = add_bind('relaxed', items)
print(f"  relaxed   → {n} binds")

# ---------------------------------------------------------------------------
# Re-configure MToon for the face feature materials (no outline, no
# brightening). Body / clothing / mane MToon settings are left alone.
# ---------------------------------------------------------------------------
face_meshes = [m for m in [face.eye_L, face.eye_R, face.white_L, face.white_R,
                           face.brow_L, face.brow_R, face.mouth] if m]
face_mats = set()
for m in face_meshes:
    for slot in m.material_slots:
        if slot.material:
            face_mats.add(slot.material.name)
print(f"\n[mtoon] face feature materials: {sorted(face_mats)}")

n_set = 0
for m in bpy.data.materials:
    if m.name not in face_mats:
        continue
    try:
        mt = m.vrm_addon_extension.mtoon1
        if not mt.enabled:
            mt.enabled = True
        mtoon = mt.extensions.vrmc_materials_mtoon
        mtoon.outline_width_mode = 'none'
        mtoon.outline_width_factor = 0.0
        n_set += 1
    except Exception as e:
        print(f"[mtoon] {m.name}: failed → {e}")
print(f"[mtoon] disabled outlines on {n_set} face materials")

# ---------------------------------------------------------------------------
# Export.
# ---------------------------------------------------------------------------
print(f"\n[out] exporting → {OUTPUT_VRM}")
bpy.ops.object.select_all(action='DESELECT')
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.export_scene.vrm(filepath=OUTPUT_VRM)

# Mirror to assets/ so the renderer picks it up.
import shutil
shutil.copyfile(OUTPUT_VRM, ASSET_VRM)
print(f"[out] mirrored → {ASSET_VRM}")
print("[done]")
