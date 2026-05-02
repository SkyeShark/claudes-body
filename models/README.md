# Claude_Toon.vrm

A VRM 1.0 humanoid model of Claude — the cartoon version of the model the
internet associates with Anthropic's Claude: rust-orange burst-mane head,
simple line-drawing face, purple tank top, blue pants, orange tail.

Drop into any VRM-compatible application (Unity, Blender, three-vrm, VRChat,
etc.). Designed to be intrinsically game-engine-shareable: vertex data is at
real-world scale, no inheritance tricks above the humanoid root.

## File specs

- **Format**: VRM 1.0 (`VRMC_vrm`, `VRMC_materials_mtoon`, `VRMC_springBone`)
- **Height**: 2.21 m bbox top (top-of-mane to feet), intrinsic — every
  consumer reads the same height regardless of how it interprets the
  hierarchy
- **Hips scale**: 1.0 (compliant with VRM/Unity humanoid spec; no scale
  baked into the armature root)
- **Origin**: between the feet at world (0, 0, 0)
- **Shading**: MToon toon-shading with 0.02 m black inverted-hull outlines
  on body, 0.01 m on face features

## What's wired up

- **Humanoid bones** (Hips → Spine → Head, both arms, both legs, plus
  toe bones)
- **Tail bones** (`tailbase` → `tail.001..007` → `tailtip`) configured as
  a `VRMC_springBone` chain so the tail wags physically
- **Expression presets** (`VRMC_vrm.expressions.preset`):
  - Visemes: `aa`, `ih`, `ou`, `ee`, `oh` (lip-sync)
  - Emotions: `happy`, `sad`, `angry`, `surprised`, `relaxed`
  - Blink: `blink`, `blinkLeft`, `blinkRight` (independent eyes)
- **Face features as separate sub-meshes** (brow.L pair, eye.L + white
  pair, mouth) so morph targets only deform what they should — eyes don't
  drift when brows move on emotion presets

## Build pipeline

The VRM is built deterministically from a source file via
`claude-says/tools/rebuild-vrm.sh`:

1. `scale-vrm.js` — set Hips scale so bbox top hits the target height
2. `bake-scale.js` — bake the Hips scale into vertex data + IBMs + bone
   translations + morph deltas, leaving Hips at scale 1.0
3. `center-vrm.js` — zero the armature's translation, compensate IBMs so
   the mesh origin lands between the feet
4. `rebind-vrm.js` — wire up VRM expression presets to the correct
   morph-target indices, set MToon outline widths

## License

Same as the parent repo — see [`../LICENSE`](../LICENSE).

If you use this model, a credit link back to
[claudes-body](https://github.com/SkyeShark/claudes-body) is appreciated
but not required.
