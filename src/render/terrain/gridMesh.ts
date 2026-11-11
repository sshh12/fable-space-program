/**
 * The shared tile grid: (n + 1)^2 vertices carrying their integer grid coordinates plus a skirt ring that
 * duplicates the edge (the vertex shader pushes skirt vertices down along the local vertical). Every quad
 * is split along the same diagonal, so a fully morphed tile has exactly the triangles of its parent.
 */
export interface GridMesh {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  /** Indices of the surface alone (without the skirt), drawn where skirts are not wanted. */
  surfaceIndexCount: number;
}

export interface GridMeshData {
  /** uint8 x 4 per vertex: i, j, skirt flag, 0. */
  vertices: Uint8Array<ArrayBuffer>;
  indices: Uint16Array<ArrayBuffer>;
  surfaceIndexCount: number;
}

export function buildGridMesh(quads: number): GridMeshData {
  const n = quads + 1;
  const surface = n * n;
  const vertices = new Uint8Array((surface + 4 * n) * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 4;
      vertices[o] = i;
      vertices[o + 1] = j;
    }
  }
  // Skirt ring: edge e (0 = v low, 1 = u high, 2 = v high, 3 = u low), vertex t along the edge.
  const edgeVertex = (e: number, t: number): [number, number] => (e === 0 ? [t, 0] : e === 1 ? [quads, t] : e === 2 ? [t, quads] : [0, t]);
  for (let e = 0; e < 4; e++) {
    for (let t = 0; t < n; t++) {
      const [i, j] = edgeVertex(e, t);
      const o = (surface + e * n + t) * 4;
      vertices[o] = i;
      vertices[o + 1] = j;
      vertices[o + 2] = 1;
    }
  }
  const indices = new Uint16Array(quads * quads * 6 + 4 * quads * 6);
  let k = 0;
  for (let j = 0; j < quads; j++) {
    for (let i = 0; i < quads; i++) {
      const v00 = j * n + i;
      const v10 = v00 + 1;
      const v01 = v00 + n;
      const v11 = v01 + 1;
      indices[k++] = v00;
      indices[k++] = v10;
      indices[k++] = v11;
      indices[k++] = v00;
      indices[k++] = v11;
      indices[k++] = v01;
    }
  }
  const surfaceIndexCount = k;
  for (let e = 0; e < 4; e++) {
    for (let t = 0; t < quads; t++) {
      const [i0, j0] = edgeVertex(e, t);
      const [i1, j1] = edgeVertex(e, t + 1);
      const a = j0 * n + i0;
      const b = j1 * n + i1;
      const sa = surface + e * n + t;
      const sb = sa + 1;
      indices[k++] = a;
      indices[k++] = sa;
      indices[k++] = sb;
      indices[k++] = a;
      indices[k++] = sb;
      indices[k++] = b;
    }
  }
  return { vertices, indices, surfaceIndexCount };
}

export function createGridMesh(device: GPUDevice, quads: number, label: string): GridMesh {
  const data = buildGridMesh(quads);
  const vertexBuffer = device.createBuffer({ label: `${label}.vertices`, size: data.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vertexBuffer, 0, data.vertices);
  const indexBuffer = device.createBuffer({ label: `${label}.indices`, size: data.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(indexBuffer, 0, data.indices);
  return { vertexBuffer, indexBuffer, indexCount: data.indices.length, surfaceIndexCount: data.surfaceIndexCount };
}

export const GRID_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 4,
  attributes: [{ shaderLocation: 0, offset: 0, format: 'uint8x4' }],
};
