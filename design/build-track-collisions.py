"""Build compact Rapier triangle meshes from the supplied uncompressed track GLBs.

The source scenes contain decorative geometry that should not be a collider. For
named-material venues we keep road, terrain, kerbs, walls and barriers. Older
Sketchfab exports have anonymous materials, so a venue-specific height ceiling
keeps their complete ground-level geometry while excluding towers and roofs.
"""
import re, struct, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from importlib import import_module

helpers = import_module('extract-track-lines')

SOURCE = Path('/private/tmp/apex-track-all/Tracks')
OUTPUT = Path(__file__).parents[1] / 'public/models/tracks/collision'
NAMED = re.compile(r'wall|barrier|guard|rail|fence|concrete|tyrew', re.I)
TRACKS = {
    'bugatti': ('bugatti_circuit_2017_layout.glb', None),
    'spa': ('circuit_de_spa-francorchamps_2022_layout.glb', None),
    'marina-bay': ('marina_bay_street_circuit.glb', 62.0),
    'daytona': ('daytona_international_speedway_2007_layout.glb', 24.0),
    'indianapolis': ('indianapolis_motor_speedway.glb', 23.0),
    'hungaroring': ('hungaroring_2020_layout.glb', 60.0),
    'barcelona': ('barcelona-catalunya_grand_prix_2023_layout.glb', 31.0),
}


def build(track_id, filename, ceiling):
    data, binary = helpers.read_glb(SOURCE / filename)
    materials = data.get('materials', [])
    vertex_chunks, index_chunks = [], []
    vertex_offset = 0

    def visit(index, parent):
        nonlocal vertex_offset
        node = data['nodes'][index]
        matrix = parent @ helpers.local_matrix(node)
        if 'mesh' in node:
            for primitive in data['meshes'][node['mesh']]['primitives']:
                material_index = primitive.get('material', -1)
                material_name = materials[material_index].get('name', '') if material_index >= 0 else ''
                if ceiling is None and not NAMED.search(material_name):
                    continue
                positions = helpers.accessor(data, binary, primitive['attributes']['POSITION'])
                transformed = (matrix @ np.c_[positions, np.ones(len(positions))].T).T[:, :3]
                indices = helpers.accessor(data, binary, primitive['indices']).reshape(-1).astype(np.int64) if 'indices' in primitive else np.arange(len(transformed))
                faces = transformed[indices[:len(indices)//3*3].reshape(-1, 3)]
                edges_a, edges_b = faces[:, 1] - faces[:, 0], faces[:, 2] - faces[:, 0]
                area2 = np.linalg.norm(np.cross(edges_a, edges_b), axis=1)
                keep = area2 > (.2 if ceiling is not None else .002)
                if ceiling is not None:
                    keep &= faces.mean(axis=1)[:, 1] <= ceiling
                    alignment = np.abs(np.cross(edges_a, edges_b)[:, 1]) / np.maximum(area2, 1e-9)
                    # Anonymous legacy materials cannot be classified reliably.
                    # Keep their ground-level vertical geometry as physical venue
                    # obstacles; the elevation-following terrain mesh is generated
                    # separately from the traced road centerline.
                    keep &= alignment <= .14
                kept_indices = indices[:len(indices)//3*3].reshape(-1, 3)[keep]
                if len(kept_indices):
                    used, remapped = np.unique(kept_indices.reshape(-1), return_inverse=True)
                    vertex_chunks.append(transformed[used].astype('<f4', copy=False))
                    index_chunks.append(remapped.astype('<u4').reshape(-1, 3) + vertex_offset)
                    vertex_offset += len(used)
        for child in node.get('children', []):
            visit(child, matrix)

    for root in data['scenes'][data.get('scene', 0)]['nodes']:
        visit(root, np.eye(4))
    vertices = np.concatenate(vertex_chunks) if vertex_chunks else np.empty((0, 3), dtype='<f4')
    indices = np.concatenate(index_chunks).reshape(-1) if index_chunks else np.empty(0, dtype='<u4')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    target = OUTPUT / f'{track_id}.bin'
    with target.open('wb') as stream:
        stream.write(b'APEXCOL1')
        stream.write(struct.pack('<II', len(vertices), len(indices)))
        stream.write(vertices.tobytes())
        stream.write(indices.tobytes())
    print(f'{track_id}: {len(indices) // 3:,} triangles, {len(vertices):,} vertices, {target.stat().st_size / 1_000_000:.1f} MB')


if __name__ == '__main__':
    wanted = set(sys.argv[1:]) or set(TRACKS)
    for track_id, (filename, ceiling) in TRACKS.items():
        if track_id in wanted:
            build(track_id, filename, ceiling)
