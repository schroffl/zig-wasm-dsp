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

        vec3 mapY(vec3 val, vec2 bounds) {
            float y = (val.y - bounds.x) / (bounds.y - bounds.x);
            return vec3(val.x, y * 2.0 - 1.0, val.z * 2.0 - 1.0);
        }

        void main() {
            vec3 pos = mapY(a_position, db_bounds);
            volume = pos.y;
            gl_PointSize = 2.0;
            gl_Position = proj_matrix * vec4(pos, 1.0);
        }
    `, `
        precision mediump float;

        varying float volume;

        void main() {
            float g = -1.0 - volume;
            float r = 1.0 - g;

            gl_FragColor = vec4(r, g, 0.0, 1.0);
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

    let db_max = 3;
    let db_min = -70;

    const mesh_buffer = gl.createBuffer();
    const mesh_width = bin_count;
    const mesh_depth = 50;
    const mesh = new Float32Array(mesh_width * 3 * mesh_depth);

    for (let i = 0; i < mesh.length / 3; i++) {
        const z = Math.floor(i / mesh_width) / (mesh_depth - 1);

        // A small offset, because log(0) is not defined
        const p = Number.EPSILON;

        const log_x = mapValueLog(mesh_width - 1 - (i % mesh_width), 0, mesh_width - 1, p, 1 + p);
        const x = (1.0 - log_x - p) * 2 - 1;

        mesh[i * 3] = x;
        mesh[i * 3 + 2] = z;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, mesh_buffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.DYNAMIC_DRAW);

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
            const max = 3;
            const min = -50;

            let val_max = -Infinity;

            for (let i = 1; i < mesh_depth; i++) {
                for (let j = 0; j < mesh_width; j++) {
                    const source_i = i * mesh_width * 3 + j * 3 + 1;
                    const target_i = (i - 1) * mesh_width * 3 + j * 3 + 1;

                    mesh[target_i] = mesh[source_i];
                }
            }

            for (let i = 0; i < mesh_width; i++) {
                const raw_x = mapValue(i, 0, mesh_width - 1, 0, 10);
                const log_x = 10 - 1 / Math.log10(raw_x + 1);
                const x = mapValue(log_x, 0, 10, -1, 1);

                const val = fft_data[i];
                const y = mapValue(val, db_min, db_max, -1, 1);

                if (val > val_max) {
                    val_max = val;
                }

                const write_offset = mesh_width * (mesh_depth - 1) * 3;
                mesh[write_offset + i * 3 + 1] = val;
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
        rotation: { x: 0, y: -0.3 },
        scale: { x: 5, y: 0.3, z: 5 },
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
            gl.vertexAttribPointer(waterfall_program.attribs.a_position, 3, gl.FLOAT, false, 0, 0);

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
