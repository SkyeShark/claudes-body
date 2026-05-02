"""Quick inspection: import FBX, list bones / meshes / vertex counts."""
import bpy
import sys

INPUT = r"C:\Users\sdn52\OneDrive\Desktop\claudethinking\finalCLAUDEweightpaint.fbx"

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=INPUT)

print("=== OBJECTS ===")
for o in bpy.data.objects:
    extra = ""
    if o.type == 'MESH':
        extra = f" verts={len(o.data.vertices)} groups={len(o.vertex_groups)}"
    if o.type == 'ARMATURE':
        extra = f" bones={len(o.data.bones)}"
    print(f"  {o.type:10s} {o.name}{extra}")

print("=== ARMATURE BONES ===")
arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
if arm:
    for b in arm.data.bones:
        parent = b.parent.name if b.parent else "(root)"
        print(f"  {b.name:30s}  parent={parent}")

print("=== MESH VERTEX GROUPS (per mesh) ===")
for o in bpy.data.objects:
    if o.type != 'MESH': continue
    print(f"  {o.name}:")
    for vg in o.vertex_groups:
        print(f"    {vg.name}")
