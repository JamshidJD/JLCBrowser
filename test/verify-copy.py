"""Independent ZIP/XML and geometry comparison using Python's standard library."""
import hashlib
import json
import math
import pathlib
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile


def verify(source_name, copy_name):
    source = pathlib.Path(source_name).read_bytes()
    count = struct.unpack_from('<I', source, 80)[0]
    assert len(source) == 84 + count * 50
    vertices = []
    triangles = 0
    digest = hashlib.sha256()
    namespace = '{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}'
    with zipfile.ZipFile(copy_name) as archive:
        assert archive.testzip() is None, 'ZIP integrity check failed'
        assert set(archive.namelist()) == {'[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model'}
        types = ET.fromstring(archive.read('[Content_Types].xml'))
        assert any(x.get('PartName') == '/3D/3dmodel.model' for x in types)
        relationships = ET.fromstring(archive.read('_rels/.rels'))
        assert any(x.get('Target') == '/3D/3dmodel.model' for x in relationships)
        with archive.open('3D/3dmodel.model') as model:
            for event, element in ET.iterparse(model, events=('start', 'end')):
                if event == 'start' and element.tag == namespace + 'model':
                    assert element.get('unit') == 'millimeter'
                elif event == 'end' and element.tag == namespace + 'vertex':
                    xyz = tuple(float(element.get(axis)) for axis in ('x', 'y', 'z'))
                    assert all(math.isfinite(value) for value in xyz)
                    vertices.append(xyz)
                    element.clear()
                elif event == 'end' and element.tag == namespace + 'triangle':
                    assert triangles < count, 'Extra triangle'
                    indices = [int(element.get(axis)) for axis in ('v1', 'v2', 'v3')]
                    assert all(0 <= index < len(vertices) for index in indices)
                    original = source[84 + triangles * 50 + 12:84 + triangles * 50 + 48]
                    xyz = tuple(value for index in indices for value in vertices[index])
                    assert xyz == struct.unpack('<9f', original), f'Coordinate changed in triangle {triangles}'
                    rebuilt = struct.pack('<9f', *xyz)
                    assert rebuilt == original, f'Coordinate bits or winding changed in triangle {triangles}'
                    digest.update(rebuilt)
                    triangles += 1
                    element.clear()
    assert triangles == count, 'Triangle missing'
    dimensions = [max(v[axis] for v in vertices) - min(v[axis] for v in vertices) for axis in range(3)]
    return dict(file=str(copy_name), sourceBytes=len(source), copyBytes=pathlib.Path(copy_name).stat().st_size,
                triangles=triangles, vertices=len(vertices), dimensionsMm=dimensions,
                geometrySha256=digest.hexdigest(), exactGeometryMatch=True, zipIntegrity=True)


if __name__ == '__main__':
    print(json.dumps(verify(sys.argv[1], sys.argv[2])))
