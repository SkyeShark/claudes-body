#!/bin/bash
# rebuild-vrm.sh — One-shot pipeline (no Blender):
#   1. claude-tpose-giant.vrm → scale to 1.7m human scale → tmp_scaled.vrm
#   2. tmp_scaled.vrm → rewire face shape keys into VRM expression presets
#                     (incl. blinkLeft/blinkRight for independent eyes)
#                     → claude.vrm
#   3. claudelatest.vrm (posed) → extract bone rotations → claude.pose.json
#   4. Mirror claude.vrm + claude.pose.json into claude-says/assets/

set -e
ROOT="C:/Users/sdn52/OneDrive/Desktop/claudethinking"
TOOLS="$ROOT/claude-says/tools"
ASSETS="$ROOT/claude-says/assets"
TMP="$ROOT/_scaled.vrm"

TARGET_HEIGHT="${TARGET_HEIGHT:-2.21}"
echo "=== Step 1: scale T-pose VRM to ${TARGET_HEIGHT}m (via Hips scale) ==="
node "$TOOLS/scale-vrm.js" "$ROOT/Claude_Fixed.vrm" "$TMP" "$TARGET_HEIGHT"

echo ""
echo "=== Step 1b: bake the Hips scale into mesh data + IBMs + bones ==="
echo "    Hips ends at scale 1.0 AND mesh data is intrinsically at world"
echo "    size, so any consumer (Blender/Unity/three-vrm) renders 2.21m"
echo "    without depending on inheritance tricks above Hips."
node "$TOOLS/bake-scale.js" "$TMP" "$TMP"

echo ""
echo "=== Step 1c: zero Armature translation, compensate IBMs ==="
echo "    Mesh origin lands between the feet at (0,0,0) instead of off"
echo "    to the side wherever the armature was placed in Blender."
node "$TOOLS/center-vrm.js" "$TMP" "$TMP"

echo ""
echo "=== Step 2: rewire face expression presets ==="
node "$TOOLS/rebind-vrm.js" "$TMP" "$ROOT/claude.vrm"

echo ""
echo "=== Step 3: extract pose from claudelatest.vrm ==="
node "$TOOLS/extract-pose.js" "$ROOT/claudelatest.vrm" "$ROOT/claude.pose.json"

echo ""
echo "=== Step 4: mirror to assets/ ==="
cp "$ROOT/claude.vrm" "$ASSETS/claude.vrm"
cp "$ROOT/claude.pose.json" "$ASSETS/claude.pose.json"
rm -f "$TMP"
ls -lh "$ROOT/claude.vrm" "$ROOT/claude.pose.json"
