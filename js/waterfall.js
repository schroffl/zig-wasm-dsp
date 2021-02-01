function waterfallGraph(canvas, sample_rate, bin_count) {
    const gl = canvas.getContext('webgl', {
        premultipliedAlpha: false,
    });

    const waterfall_program = webglProgram(gl, `
        precision mediump float;

        attribute vec3 a_position;

        uniform mat4 proj_matrix;
        uniform vec2 db_bounds;

        varying float volume;
        varying float frequency;

        vec3 mapY(vec3 val, vec2 bounds) {
            float y = (val.y - bounds.x) / (bounds.y - bounds.x) + 2.0 - 1.0;
            float clamped_y = max(y, 0.0);

            return vec3(val.x, clamped_y, val.z * 2.0 - 1.0);
        }

        void main() {
            vec3 pos = mapY(a_position, db_bounds);

            volume = pos.y;
            frequency = pos.x;

            gl_PointSize = 2.0;
            gl_Position = proj_matrix * vec4(pos, 1.0);
        }
    `, `
        precision mediump float;

        varying float volume;
        varying float frequency;

        void main() {
            gl_FragColor = vec4(0.7 + frequency * 0.3, volume, 0.0, 1.0);
        }
    `, [
        'a_position',
    ], [
        'proj_matrix',
        'db_bounds',
    ]);

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    const vertex_buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertex_buffer);
    gl.bufferData(gl.ARRAY_BUFFER, byteCount(Float32Array, bin_count * 3), gl.DYNAMIC_DRAW);

    const wrkmem = new Float32Array(bin_count * 2).fill(0);

    let history_len = 0;
    const max_history = new Float32Array(20).fill(0);

    let db_max = 0;
    let db_min = -50;

    const mesh_buffer = gl.createBuffer();
    const mesh_width = bin_count;
    const mesh_depth = Math.floor(65535 / bin_count);
    const vertex_size = 6;
    const mesh = new Float32Array(mesh_width * vertex_size * mesh_depth);

    console.log(mesh_width, mesh.length / vertex_size);

    for (let i = 0; i < mesh.length / vertex_size; i++) {
        const z = Math.floor(i / mesh_width) / (mesh_depth - 1);

        // A small offset, because log(0) is not defined
        const p = Number.EPSILON;

        const log_x = mapValueLog(mesh_width - 1 - (i % mesh_width), 0, mesh_width - 1, p, 1 + p);
        const x = (1.0 - log_x - p) * 2 - 1;

        mesh[i * vertex_size] = x;
        mesh[i * vertex_size + 1] = 0;
        mesh[i * vertex_size + 2] = z;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, mesh_buffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.DYNAMIC_DRAW);

    // TODO The maximum amount of indices is limited by the Uint16Array, which
    //      only gives us 2^16 of them. If we want to display more vertices we
    //      need to render them in multiple batches.
    const index_buffer = gl.createBuffer();
    const quad_count = (mesh_depth - 1) * (mesh_width - 1);
    const index_count = quad_count * 2 * 3;
    const indices = new Uint16Array(index_count);

    for (let i = 0; i < quad_count; i++) {
        const row = Math.floor(i / (mesh_width - 1));
        const vertex_i = i + row;

        // First Face
        indices[i * 6] = vertex_i;
        indices[i * 6 + 1] = vertex_i + 1;
        indices[i * 6 + 2] = vertex_i + 1 + mesh_width;

        // Second Face
        indices[i * 6 + 3] = vertex_i;
        indices[i * 6 + 4] = vertex_i + 1 + mesh_width;
        indices[i * 6 + 5] = vertex_i + mesh_width;
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index_buffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    const state = {
        onResize: function() {
            const bounds = canvas.getBoundingClientRect();
            const dpi = window.devicePixelRatio;

            canvas.width = bounds.width * dpi;
            canvas.height = bounds.height * dpi;

            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        },
        update: function(fft_data) {
            let val_max = -Infinity;

            for (let i = 1; i < mesh_depth; i++) {
                for (let j = 0; j < mesh_width; j++) {
                    const source_i = i * mesh_width * vertex_size + j * vertex_size + 1;
                    const target_i = (i - 1) * mesh_width * vertex_size + j * vertex_size + 1;

                    mesh[target_i] = mesh[source_i];
                }
            }

            for (let i = 0; i < mesh_width; i++) {
                const val = fft_data[i];

                if (val > val_max) {
                    val_max = val;
                }

                const write_offset = mesh_width * (mesh_depth - 1) * vertex_size;
                mesh[write_offset + i * vertex_size + 1] = val;
            }

            for (let i = 1; i < history_len; i++) {
                max_history[i - 1] = max_history[i];
            }

            history_len = Math.min(history_len + 1, max_history.length);
            max_history[history_len - 1] = val_max;

            const history_square_sum = max_history.reduce((a, b) => a + b * b, 0);
            const rms = Math.sqrt(history_square_sum / history_len);
            db_max = -rms + 6;

            gl.bindBuffer(gl.ARRAY_BUFFER, mesh_buffer);
            gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.DYNAMIC_DRAW);

            gl.useProgram(waterfall_program.program);
            gl.uniform2f(waterfall_program.uniforms.db_bounds, db_min, db_max);
        },
        rotation: { x: Math.PI / 2, y: -1.5 },
        scale: { x: 5, y: 3, z: 5 },
        render: function() {
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.useProgram(waterfall_program.program);

            const scale = state.scale;
            const matrix = Matrix.multiplyMany([
                Matrix.scale(scale.x, scale.y, scale.z),
                Matrix.rotateY(state.rotation.x),
                Matrix.rotateX(state.rotation.y),
                Matrix.translate(0, 0, -20),
                Matrix.perspective(70, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.0001, 30),
            ]);

            gl.uniformMatrix4fv(waterfall_program.uniforms.proj_matrix, false, matrix);

            gl.bindBuffer(gl.ARRAY_BUFFER, mesh_buffer);
            gl.enableVertexAttribArray(waterfall_program.attribs.a_position);
            gl.vertexAttribPointer(waterfall_program.attribs.a_position, 3, gl.FLOAT, false, byteCount(Float32Array, vertex_size), 0);

            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index_buffer);
            gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
        },
    };

    const onWindowResize = debounce(state.onResize, 250);
    window.addEventListener('resize', onWindowResize);
    state.onResize();

    return state;
}

function mapValue(val, fmin, fmax, tmin, tmax) {
    const normalized = (val - fmin) / (fmax - fmin);
    return tmin + normalized * (tmax - tmin);
}

function mapValueLog(val, fmin, fmax, tmin, tmax) {
    const normalized = (val - fmin) / (fmax - fmin);

    const log_tmin = Math.log(tmin);
    const log_tmax = Math.log(tmax);

    return Math.exp(normalized * (Math.log(tmax) - log_tmin) + log_tmin);

}
