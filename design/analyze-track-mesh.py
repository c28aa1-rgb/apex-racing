"""Print geometric statistics for each material/primitive in an uncompressed GLB."""
import json, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from importlib import import_module

helpers = import_module('extract-track-lines')


def main(path):
    data, binary = helpers.read_glb(path)
    materials = data.get('materials', [])
    rows = []

    def visit(index, parent):
        node = data['nodes'][index]
        matrix = parent @ helpers.local_matrix(node)
        if 'mesh' in node:
            for primitive in data['meshes'][node['mesh']]['primitives']:
                positions = helpers.accessor(data, binary, primitive['attributes']['POSITION'])
                transformed = (matrix @ np.c_[positions, np.ones(len(positions))].T).T[:, :3]
                indices = helpers.accessor(data, binary, primitive['indices']).reshape(-1).astype(np.int64) if 'indices' in primitive else np.arange(len(transformed))
                faces = transformed[indices[:len(indices)//3*3].reshape(-1, 3)]
                normals = np.cross(faces[:, 1] - faces[:, 0], faces[:, 2] - faces[:, 0])
                sizes = np.linalg.norm(normals, axis=1)
                upward = np.abs(normals[:, 1]) > sizes * .55
                area = sizes * .5
                mat = primitive.get('material', -1)
                rows.append({
                    'material': materials[mat].get('name', '') if mat >= 0 else '(none)',
                    'node': node.get('name', ''),
                    'mesh': data['meshes'][node['mesh']].get('name', ''),
                    'vertices': len(transformed),
                    'triangles': len(faces),
                    'upward': int(upward.sum()),
                    'up_area': round(float(area[upward].sum())),
                    'area': round(float(area.sum())),
                    'span_x': round(float(np.ptp(transformed[:, 0]))),
                    'span_y': round(float(np.ptp(transformed[:, 1])), 1),
                    'span_z': round(float(np.ptp(transformed[:, 2]))),
                    'min_y': round(float(transformed[:, 1].min()), 1),
                    'max_y': round(float(transformed[:, 1].max()), 1),
                })
        for child in node.get('children', []):
            visit(child, matrix)

    for root in data['scenes'][data.get('scene', 0)]['nodes']:
        visit(root, np.eye(4))
    rows.sort(key=lambda row: row['up_area'], reverse=True)
    print(json.dumps(rows[:35], indent=2))


if __name__ == '__main__':
    main(sys.argv[1])
