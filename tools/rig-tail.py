"""
rig-tail.py — Surgical tail-bone weight fixer.

Reads claude.fbx, finds the tail mesh and the tail bone chain
(tailbase / tail / tailtip), recomputes ONLY those bone weights on the
tail mesh's vertices using inverse-distance to each bone's head-to-tail
segment, and writes the FBX back. Every other bone on every other vertex
is left untouched.

Run:
    "C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe" \\
        --background --python tools/rig-tail.py
"""

import bpy
import re
import sys
from mathutils import Vector

INPUT_FBX  = r"C:\Users\sdn52\OneDrive\Desktop\claudethinking\claude.fbx"
OUTPUT_FBX = r"C:\Users\sdn52\OneDrive\Desktop\claudethinking\claude_rigged.fbx"

# Recognise tail bones by name. Includes singular and chain-style names.
TAIL_BONE_RE = re.compile(r'^(tail|tailbase|tailtip|tail[._-]?\d+)$', re.IGNORECASE)
TAIL_MESH_RE = re.compile(r'tail', re.IGNORECASE)

# ---------- helpers ----------

def closest_point_distance(p, head, tail):
    """Shortest distance from point p to the line segment between head and tail."""
    seg = tail - head
    seg_len_sq = seg.length_squared
    if seg_len_sq < 1e-9:
        return (p - head).length
    t = max(0.0, min(1.0, (p - head).dot(seg) / seg_len_sq))
    closest = head + seg * t
    return (p - closest).length


def main():
    # --- start clean ---
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # --- import FBX ---
    print(f"[rig-tail] importing {INPUT_FBX}")
    bpy.ops.import_scene.fbx(filepath=INPUT_FBX)

    # --- find armature ---
    armature = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
    if not armature:
        print("[rig-tail] ERROR: no armature in file")
        sys.exit(1)
    print(f"[rig-tail] armature: {armature.name}")
    print(f"[rig-tail] all bones: {[b.name for b in armature.data.bones]}")

    # --- find tail bones (only true tail-chain bones, skip e.g. 'tailbone' on a different rig) ---
    tail_bones = [b for b in armature.data.bones if TAIL_BONE_RE.match(b.name)]
    if not tail_bones:
        # fallback: any bone whose name contains "tail"
        tail_bones = [b for b in armature.data.bones if 'tail' in b.name.lower()]
    print(f"[rig-tail] tail bones found: {[b.name for b in tail_bones]}")
    if not tail_bones:
        print("[rig-tail] ERROR: no tail bones found")
        sys.exit(1)
    tail_bone_names = {b.name for b in tail_bones}

    # --- find the body mesh (the rig's combined char1) ---
    body_mesh = None
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        # Prefer a mesh named 'tail' if it exists; fall back to the largest mesh.
        if TAIL_MESH_RE.search(obj.name) or TAIL_MESH_RE.search(obj.data.name):
            body_mesh = obj
            break
    if not body_mesh:
        meshes = [o for o in bpy.data.objects if o.type == 'MESH']
        if not meshes:
            print("[rig-tail] ERROR: no meshes found")
            sys.exit(1)
        body_mesh = max(meshes, key=lambda o: len(o.data.vertices))
        print(f"[rig-tail] no tail-named mesh; using largest mesh: {body_mesh.name}")
    tail_mesh = body_mesh
    print(f"[rig-tail] working on mesh: {tail_mesh.name}, {len(tail_mesh.data.vertices)} verts")

    # --- compute bone segments in WORLD space ---
    armature_world = armature.matrix_world
    bone_segments = []
    for bone in tail_bones:
        head_world = armature_world @ bone.head_local
        tail_world = armature_world @ bone.tail_local
        bone_segments.append((bone.name, head_world, tail_world))
        print(f"[rig-tail]   {bone.name}: head={tuple(round(x,3) for x in head_world)} tail={tuple(round(x,3) for x in tail_world)}")

    # --- ensure each tail bone has a vertex group on the tail mesh ---
    for bone_name in tail_bone_names:
        if bone_name not in tail_mesh.vertex_groups:
            tail_mesh.vertex_groups.new(name=bone_name)

    # --- per-vertex tail-only weight recompute ---
    # Process ONLY vertices that currently have any weight to any tail bone.
    # These are the actual tail vertices; everything else is body and gets
    # left strictly alone.
    mesh_world = tail_mesh.matrix_world
    mesh_data = tail_mesh.data

    # Map vertex_group_index → name once, for fast lookups.
    vg_idx_to_name = {vg.index: vg.name for vg in tail_mesh.vertex_groups}

    n_processed = 0
    n_skipped   = 0
    for v in mesh_data.vertices:
        # Existing tail-bone influence on this vertex (sum of current
        # weights on the tail bone groups). If zero, this vertex isn't
        # a tail vertex — skip it entirely.
        existing_tail_weight = 0.0
        for g in v.groups:
            if vg_idx_to_name[g.group] in tail_bone_names:
                existing_tail_weight += g.weight

        if existing_tail_weight <= 1e-5:
            n_skipped += 1
            continue

        p_world = mesh_world @ v.co

        # Inverse-distance² to each tail bone segment.
        raw = []
        for name, h, t in bone_segments:
            d = closest_point_distance(p_world, h, t)
            raw.append((name, 1.0 / (d * d + 1e-4)))
        raw_sum = sum(w for _, w in raw)

        # Redistribute the existing_tail_weight across tail bones by
        # inverse-distance. The total tail-bone influence on this vertex
        # therefore stays the same; only the *split* between tail bones
        # changes. Non-tail weights remain untouched.
        for name, w in raw:
            share = (w / raw_sum) * existing_tail_weight if raw_sum > 0 else 0.0
            vg = tail_mesh.vertex_groups[name]
            vg.add([v.index], share, 'REPLACE')

        n_processed += 1

    print(f"[rig-tail] reweighted {n_processed} tail vertices across {len(tail_bone_names)} tail bones; skipped {n_skipped} non-tail vertices")

    # --- export ---
    print(f"[rig-tail] exporting {OUTPUT_FBX}")
    bpy.ops.export_scene.fbx(
        filepath=OUTPUT_FBX,
        use_selection=False,
        apply_unit_scale=True,
        bake_space_transform=False,
        object_types={'ARMATURE', 'MESH', 'EMPTY'},
        use_armature_deform_only=False,
        bake_anim=False,
        path_mode='COPY',
        embed_textures=True,
        add_leaf_bones=False,
        primary_bone_axis='Y',
        secondary_bone_axis='X',
    )
    print("[rig-tail] done.")


if __name__ == '__main__':
    main()
