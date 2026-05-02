"""
bake-pose-to-rest.py — Take a posed .vrm, bake the pose into the mesh
data, apply pose as rest pose, and re-export.

This is the deterministic version of the manual two-phase workflow:
  Phase 1: For every skinned mesh, apply its Armature modifier (bakes the
           current visible pose into vertex positions) and re-add the
           modifier so future bone rotations still drive deformation.
  Phase 2: On the armature, Pose → Apply → Apply Pose as Rest Pose.
After this, bones at identity render the standing pose, and any future
runtime rotations are deltas FROM the standing pose.

Run:
    "C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe" \\
        --background --python tools/bake-pose-to-rest.py
"""

import bpy
import sys
from types import SimpleNamespace

INPUT_VRM  = r"C:\Users\sdn52\OneDrive\Desktop\claudethinking\claudelatest.vrm"
OUTPUT_VRM = r"C:\Users\sdn52\OneDrive\Desktop\claudethinking\claude_baked.vrm"

# ---------------------------------------------------------------------------
# Reset, enable VRM addon, import.
# ---------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)

ADDON_NAME = 'bl_ext.blender_org.vrm'
if ADDON_NAME not in bpy.context.preferences.addons:
    try:
        bpy.ops.preferences.addon_enable(module=ADDON_NAME)
    except Exception as e:
        print(f"[vrm] addon_enable failed: {e}")
if ADDON_NAME not in bpy.context.preferences.addons:
    print("[vrm] WARNING: addon prefs missing — patching get_preferences with stub")
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

print(f"[in] importing {INPUT_VRM}")
bpy.ops.import_scene.vrm(filepath=INPUT_VRM)

armature = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
if not armature:
    print("[ERR] no armature in imported VRM"); sys.exit(1)
print(f"[in] armature={armature.name}")

# Blender's VRM addon imports bone node rotations as REST pose data, leaving
# pose-mode rotations at identity. We re-read the source .vrm JSON directly
# and apply each bone's authored rotation as a POSE-MODE rotation, so we
# have an actual pose to bake.
print("\n[in] reading bone node rotations from source .vrm JSON")
import json as _json, struct
with open(INPUT_VRM, 'rb') as f:
    raw = f.read()
assert raw[:4] == b'glTF', "not a GLB"
off = 12
c0len = struct.unpack_from('<I', raw, off)[0]
gltf = _json.loads(raw[off+8:off+8+c0len].decode('utf-8'))

# Build name → rotation map from the source JSON.
posed_rotations = {}
for n in gltf['nodes']:
    if not n.get('name'): continue
    r = n.get('rotation')
    if not r: continue
    # Skip identity (within tolerance).
    if abs(r[3] - 1.0) < 1e-4 and abs(r[0]) < 1e-4 and abs(r[1]) < 1e-4 and abs(r[2]) < 1e-4:
        continue
    posed_rotations[n['name']] = r
print(f"[in] source has {len(posed_rotations)} non-identity bone rotations")

# Apply each rotation as a pose-mode quaternion on the matching bone.
bpy.context.view_layer.objects.active = armature
bpy.ops.object.mode_set(mode='POSE')
applied = 0
for pb in armature.pose.bones:
    r = posed_rotations.get(pb.name)
    if r is None: continue
    pb.rotation_mode = 'QUATERNION'
    # glTF quaternion order is (x, y, z, w); Blender's is (w, x, y, z).
    pb.rotation_quaternion = (r[3], r[0], r[1], r[2])
    applied += 1
bpy.ops.object.mode_set(mode='OBJECT')
print(f"[in] applied {applied} pose-mode rotations to bones")

# ---------------------------------------------------------------------------
# Phase 0: Apply All Transforms (location / rotation / scale) on the
# armature and every skinned/parented child. The .vrm has Hips at
# scale 0.0242 — leaving that in place will cause every subsequent bake
# (apply armature modifier, apply pose as rest) to multiply the mesh by
# the inherited scale and produce a giant body. Applying transforms here
# distributes scale into the mesh data and resets all object transforms
# to identity, so subsequent bakes are clean.
# ---------------------------------------------------------------------------
print("\n[bake] Phase 0: applying transforms to remove non-identity scales")
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.select_all(action='DESELECT')
# Select armature and all of its descendants (including bone-parented meshes)
to_select = [armature]
def collect(obj):
    for c in obj.children:
        to_select.append(c)
        collect(c)
collect(armature)
for o in to_select:
    o.select_set(True)
bpy.context.view_layer.objects.active = armature
try:
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    print(f"[bake] applied scale on {len(to_select)} objects")
except Exception as e:
    print(f"[bake] WARN: transform_apply failed: {e}")
bpy.ops.object.select_all(action='DESELECT')

# ---------------------------------------------------------------------------
# Phase 1: For every skinned mesh, apply its Armature modifier (bakes the
# current visible pose into vertex data), then re-add the modifier so
# future bone rotations still deform.
#
# Catch: meshes with shape keys cannot have a modifier applied directly. We
# use the addon-friendly path for those: convert each shape key to a mesh
# clone, apply the modifier on each clone, copy the result back as a new
# shape key. (Or simpler: skip — the face features in this rig are bone-
# parented, not skinned, so they don't have armature modifiers anyway.)
# ---------------------------------------------------------------------------
print("\n[bake] Phase 1: applying armature modifier on each skinned mesh")

def has_armature_modifier(obj):
    return any(m.type == 'ARMATURE' and m.object == armature for m in obj.modifiers)

def apply_armature_with_shape_keys(mesh_obj):
    """Bake current pose into a mesh that has shape keys.

    Strategy: for each shape key (including Basis), evaluate the mesh with
    that key at full weight + the armature modifier active, capture the
    resulting vertex positions, and write them back as the shape key data.
    Then remove and re-add the armature modifier.
    """
    me = mesh_obj.data
    if me.shape_keys is None:
        return False
    keys = list(me.shape_keys.key_blocks)
    arm_mod = next((m for m in mesh_obj.modifiers if m.type == 'ARMATURE'), None)
    if not arm_mod:
        return False

    # Save original key weights.
    original_weights = [k.value for k in keys]

    # We'll generate baked positions per shape key by:
    #   1. Setting all weights to 0 except the target key at 1
    #   2. Evaluating the mesh with the armature modifier
    #   3. Copying world-space deformed positions into the key data
    depsgraph = bpy.context.evaluated_depsgraph_get()
    new_positions_per_key = []
    for i, key in enumerate(keys):
        for j, k in enumerate(keys):
            k.value = 1.0 if j == i else 0.0
        depsgraph.update()
        eval_obj = mesh_obj.evaluated_get(depsgraph)
        eval_mesh = eval_obj.to_mesh()
        positions = [v.co.copy() for v in eval_mesh.vertices]
        eval_obj.to_mesh_clear()
        new_positions_per_key.append(positions)

    # Restore original weights.
    for k, w in zip(keys, original_weights):
        k.value = w

    # Write the baked positions back into each shape key.
    for i, key in enumerate(keys):
        positions = new_positions_per_key[i]
        for j, p in enumerate(positions):
            key.data[j].co = p

    # Remove the armature modifier and re-add it (so it now drives deltas
    # from the new rest, not from the old T-pose).
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.modifier_remove(modifier=arm_mod.name)
    new_mod = mesh_obj.modifiers.new(name='Armature', type='ARMATURE')
    new_mod.object = armature
    return True

n_baked = 0
for obj in list(bpy.data.objects):
    if obj.type != 'MESH':
        continue
    if not has_armature_modifier(obj):
        continue
    has_keys = obj.data.shape_keys is not None
    print(f"  baking {obj.name}  (shape keys: {'yes' if has_keys else 'no'})")
    bpy.context.view_layer.objects.active = obj
    if has_keys:
        if apply_armature_with_shape_keys(obj):
            n_baked += 1
    else:
        arm_mod = next(m for m in obj.modifiers if m.type == 'ARMATURE')
        try:
            bpy.ops.object.modifier_apply(modifier=arm_mod.name)
            new_mod = obj.modifiers.new(name='Armature', type='ARMATURE')
            new_mod.object = armature
            n_baked += 1
        except Exception as e:
            print(f"  [WARN] could not apply on {obj.name}: {e}")

print(f"[bake] phase 1: baked pose into {n_baked} meshes")

# ---------------------------------------------------------------------------
# Phase 1.5: Snapshot world transforms of every bone-parented mesh BEFORE
# apply-pose-as-rest. These are face features (eyes/brows/mouth/etc.) that
# track a bone but aren't skinned to it. After we change the bone's rest,
# their local-relative-to-bone positions will be wrong unless we restore
# them to their original world positions.
# ---------------------------------------------------------------------------
bone_parented_world = {}
for obj in bpy.data.objects:
    if obj.parent == armature and obj.parent_type == 'BONE':
        bone_parented_world[obj.name] = obj.matrix_world.copy()
print(f"[bake] snapshotted world transforms of {len(bone_parented_world)} bone-parented objects")

# ---------------------------------------------------------------------------
# Phase 2: Apply pose as rest pose on the armature.
# ---------------------------------------------------------------------------
print("\n[bake] Phase 2: applying pose as rest on armature")
bpy.context.view_layer.objects.active = armature
bpy.ops.object.select_all(action='DESELECT')
armature.select_set(True)
bpy.ops.object.mode_set(mode='POSE')
bpy.ops.pose.select_all(action='SELECT')
bpy.ops.pose.armature_apply()
bpy.ops.object.mode_set(mode='OBJECT')
print("[bake] phase 2: rest pose updated")

# Verify: bones should now be at identity rotation in pose mode.
still_posed = 0
for pb in armature.pose.bones:
    q = pb.rotation_quaternion
    if abs(q.w - 1.0) > 1e-4 or abs(q.x) > 1e-4 or abs(q.y) > 1e-4 or abs(q.z) > 1e-4:
        still_posed += 1
print(f"[bake] verify: {still_posed} bones still have non-identity pose rotation (should be 0)")

# ---------------------------------------------------------------------------
# Phase 2.5: Restore world transforms of the bone-parented face features.
# Their local positions are now relative to the new (posed) bone rest, so
# we re-set matrix_world from our snapshot and Blender computes the
# correct matrix_basis / parent_inverse.
# ---------------------------------------------------------------------------
bpy.context.view_layer.update()
n_restored = 0
for name, world_mat in bone_parented_world.items():
    obj = bpy.data.objects.get(name)
    if not obj: continue
    obj.matrix_world = world_mat
    n_restored += 1
print(f"[bake] restored {n_restored} bone-parented world transforms")

# ---------------------------------------------------------------------------
# Export.
# ---------------------------------------------------------------------------
print(f"\n[out] exporting → {OUTPUT_VRM}")
bpy.ops.object.select_all(action='DESELECT')
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.export_scene.vrm(filepath=OUTPUT_VRM)
print("[done]")
