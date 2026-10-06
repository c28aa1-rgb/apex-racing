/**
 * Per-venue road-surface bake settings (see design/bake-road.ts). Material indices refer to the supplied
 * source GLB (public/models/tracks/<id>.glb); `names` asserts them so a replaced model fails loudly.
 * Roles were taken from the per-venue surface audits in work/smooth-audit/<id>-summary.json.
 *
 *  surface   drivable solid materials snapped onto the smooth field (asphalt, pit lane, paved run-off,
 *            painted lines that abut the asphalt rather than lying on it)
 *  kerbs     field + capped relief that ramps up from the surface edge (no vertical risers)
 *  overlays  decals and lines lying on top of the asphalt: field + a small lift, then render-only
 */
export type BakeConfig = {
  surface: number[]; kerbs: number[]; overlays: number[];
  names?: Record<number, string>;
  /** Moving-least-squares Gaussian sigma (m): larger smooths more; creases become fillets about 2 sigma wide. */
  sigmaM: number;
  /** Robust fit: Huber threshold and hard rejection of samples (cm) relative to the local fit. */
  huberCm: number; rejectCm: number;
  /** Refinement: split edges longer than maxEdgeM, or whose midpoint misses the field by chordCm; never below minEdgeM. */
  maxEdgeM: number; minEdgeM: number; chordCm: number;
  /** Largest vertex move except inside `defects`. */
  clampCm: number;
  kerbCapCm: number; kerbRampDeg: number; overlayLiftCm: number;
  /** Non-drivable geometry within this horizontal distance follows the road displacement with a smooth falloff. */
  featherM: number; noFeather?: number[];
  /** Drivable triangles lying up to this far under another drivable layer are deleted (stacked/hidden copies). */
  hiddenBelowCm: number;
  /** Flat prop pieces lying up to this high above the road are laid onto it (0 = only report them). */
  flattenPropsCm?: number;
  defects?: { x: number; z: number; radiusM: number; note: string }[];
  exclude?: { x: number; z: number; radiusM: number }[];
};

const base = { huberCm: 3, rejectCm: 20, sigmaM: 2, maxEdgeM: 8, minEdgeM: .5, chordCm: 1, clampCm: 12, kerbCapCm: 5, kerbRampDeg: 20, overlayLiftCm: .4, featherM: 4, hiddenBelowCm: 12 };

export const TRACK_BAKE: Record<string, BakeConfig> = {
  daytona: {
    ...base,
    // Banks are exact 31-degree planes; the problem is the hard apron/bank crease and the strips that float on it.
    // A smaller sigma keeps the fillet near the crease (about 3 m wide) without lowering the banks elsewhere.
    sigmaM: 1.5, huberCm: 8, rejectCm: 60, clampCm: 35, chordCm: 1, minEdgeM: .5,
    // Line strips 7/93 fill slots in the asphalt (no road under them), so they are drivable surface, not overlays.
    surface: [70, 76, 81, 78, 79, 10, 7, 93], kerbs: [], overlays: [],
    names: { 70: 'BB_BACK.003_97', 76: 'BB_BACK.003_52', 81: 'BB_BACK.003_57', 78: 'BB_BACK.003_54', 79: 'BB_BACK.003_55', 10: 'BB_BACK.003_6', 7: 'BB_BACK.003_3', 93: 'BB_BACK.003_23' },
  },
  spa: {
    ...base,
    surface: [66, 60, 68, 61, 46, 59, 63, 3, 41], kerbs: [26, 69, 25], overlays: [9, 79, 29, 30, 31, 32, 75],
    names: { 66: 'asph-grv.001', 60: 'asph_new.001', 68: 'road-ext-tile.001', 61: 'asph-pitlane-old.001', 46: 'asph_pitlane_old.001', 59: 'asph-pitlane-old-red.001', 63: 'carpet.001', 3: 'carpet-full.001', 41: 'carpet-blue.001', 26: 'kerb_new.001', 69: 'CURB_B.001', 25: 'grilles.001', 9: 'line.001', 79: 'doted_line.001', 29: 'groove_custom.001', 30: 'groove1.001', 31: 'groove3.001', 32: 'groove2.001', 75: 'asph_patch_joint.001' },
    defects: [
      { x: -206.52, z: -604.18, radiusM: 6, note: 'pit step 43 cm' },
    ],
  },
  barcelona: {
    ...base,
    // Low-frequency venue: a wider fit takes out sub-10 m undulations (felt as chassis shake) while the
    // local quadratic keeps every crest, sag, crown and banking radius the audit measured.
    sigmaM: 4,
    surface: [53, 91, 41, 35, 57, 54, 55, 38, 36, 37, 12, 47, 40, 72, 74, 76, 62], kerbs: [46, 45, 43, 42, 44], overlays: [52, 59, 60, 64, 65, 48, 61, 56, 58],
    names: { 53: 'MOTOROLA_96', 91: 'MOTOROLA_53', 41: 'MOTOROLA_14', 35: 'MOTOROLA_8', 57: 'MOTOROLA_18', 54: 'MOTOROLA_81', 55: 'MOTOROLA_82', 38: 'MOTOROLA_11', 36: 'MOTOROLA_9', 37: 'MOTOROLA_10', 12: 'MOTOROLA_27', 47: 'MOTOROLA_75', 40: 'MOTOROLA_13', 72: 'MOTOROLA_74', 74: 'MOTOROLA_29', 76: 'MOTOROLA_31', 62: 'MOTOROLA_64', 46: 'MOTOROLA_24', 45: 'MOTOROLA_17', 43: 'MOTOROLA_23', 42: 'MOTOROLA_15', 44: 'MOTOROLA_16', 52: 'MOTOROLA_80', 59: 'MOTOROLA_84', 60: 'MOTOROLA_85', 64: 'MOTOROLA_66', 65: 'MOTOROLA_67', 48: 'MOTOROLA_76', 61: 'MOTOROLA_63', 56: 'MOTOROLA_38', 58: 'MOTOROLA_83' },
  },
  hungaroring: {
    ...base,
    // Low-frequency venue: a wider fit takes out sub-10 m undulations (felt as chassis shake) while the
    // local quadratic keeps every crest, sag, crown and banking radius the audit measured.
    sigmaM: 4,
    // Solid painted lines abut the asphalt (any offset would be a step), so they belong to the surface.
    surface: [78, 8, 48, 58, 33, 35, 39, 18, 80], kerbs: [2, 3, 4], overlays: [12, 13, 14, 90, 91, 92],
    names: { 78: 'drs_floor_a_01.001_76', 8: 'drs_floor_a_01.001_6', 48: 'drs_floor_a_01.001_46', 58: 'drs_floor_a_01.001_56', 33: 'drs_floor_a_01.001_31', 35: 'drs_floor_a_01.001_33', 39: 'drs_floor_a_01.001_37', 18: 'drs_floor_a_01.001_16', 80: 'drs_floor_a_01.001_78', 2: 'drs_floor_a_01.001_0', 3: 'drs_floor_a_01.001_1', 4: 'drs_floor_a_01.001_2', 12: 'drs_floor_a_01.001_10', 13: 'drs_floor_a_01.001_11', 14: 'drs_floor_a_01.001_12', 90: 'drs_floor_a_01.001_88', 91: 'drs_floor_a_01.001_89', 92: 'drs_floor_a_01.001_90' },
  },
  indianapolis: {
    ...base,
    // Low-frequency venue: a wider fit takes out sub-10 m undulations (felt as chassis shake) while the
    // local quadratic keeps every crest, sag, crown and banking radius the audit measured.
    sigmaM: 4,
    // Edge atlases 8/9/10/13/14/17 mix flush aprons with grass halves: kerb role keeps the grass halves'
    // height while flattening apron risers. Kerbs here are flush, so the cap is small.
    kerbCapCm: 1.5, clampCm: 15,
    surface: [4, 2, 1, 5, 6, 7, 3], kerbs: [8, 9, 10, 13, 14, 17], overlays: [44, 16],
    names: { 4: 'standard_20.004_9', 2: 'standard_20.004_7', 1: 'standard_20.004_16', 5: 'standard_20.004_10', 6: 'standard_20.004_11', 7: 'standard_20.004_12', 3: 'standard_20.004_8', 8: 'standard_20.004_13', 9: 'standard_20.004_15', 10: 'standard_20.004_29', 13: 'standard_20.004_32', 14: 'standard_20.004_33', 17: 'standard_20.004_14', 44: 'standard_20.004_22', 16: 'standard_20.004_35' },
  },
  'marina-bay': {
    ...base,
    surface: [15, 16, 17, 85, 98, 99], kerbs: [88], overlays: [92, 93, 94, 95],
    names: { 15: '11001Mtl_14', 16: '11001Mtl_15', 17: '11001Mtl_16', 85: '11001Mtl_84', 98: '11001Mtl_96', 99: '11001Mtl_97', 88: '11001Mtl_87', 92: '11001Mtl', 93: '11001Mtl_91', 94: '11001Mtl_92', 95: '11001Mtl_93' },
  },
  bugatti: {
    ...base,
    // 75 is the main asphalt sheet, 78 the paved paddock/transit areas; ROADTSTRIPE lines are thin up-facing strips.
    surface: [75, 78, 7, 50, 76, 77, 9], kerbs: [4], overlays: [],
    names: { 75: '01_-_Default.002', 78: 'TRANSIT.002', 7: 'ROADREAL4_WET.002', 50: 'ROADREAL3_WET.002', 76: 'ROADREAL2_WET.002', 77: 'ROAD_02.002', 9: 'ROADTSTRIPE.002', 4: 'ROADKERB1_WET.002' },
  },
};
