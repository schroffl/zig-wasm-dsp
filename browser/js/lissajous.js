const Matrix = {
    identity: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    rotateZ: angle => new Float32Array([Math.cos(angle), -Math.sin(angle), 0, 0, Math.sin(angle), Math.cos(angle), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    rotateY: angle => new Float32Array([Math.cos(angle), 0, -Math.sin(angle), 0, 0, 1, 0, 0, Math.sin(angle), 0, Math.cos(angle), 0, 0, 0, 0, 1]),
    rotateX: angle => new Float32Array([1, 0, 0, 0, 0, Math.cos(angle), -Math.sin(angle), 0, 0, Math.sin(angle), Math.cos(angle), 0, 0, 0, 0, 1]),
    scale: (x, y, z) => new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]),
    translate: (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0 , 0, 0, 0, 1, 0, x, y, z, 1 ]),
    multiply: (a, b) => {
        const out = new Float32Array(16);

        for (let i = 0; i < 16; i++) {
            const row = Math.floor(i / 4);
            const column = i % 4;

            out[i] = a[column] * b[row * 4]
                + a[column + 4] * b[ row * 4 + 1]
                + a[column + 8] * b[row * 4 + 2]
                + a[column + 12] * b[row * 4 + 3];
        }

        return out;
    },
    perspective: (fov, aspectRatio, near, far) => {
        const fovRad = fov * Math.PI / 180;
        const f = 1 / Math.tan(fovRad / 2);
        const rangeInv = 1 / (near - far);

        return new Float32Array([
            f / aspectRatio, 0, 0, 0,
            0, f, 0, 0,
            0, 0, (near + far) * rangeInv, -1,
            0, 0, near * far * rangeInv * 2, 0,
        ]);
    },
    orthographic: (left, right, bottom, top, near, far) => {
        return new Float32Array([
            2 / (right - left),                  0,                 0, -(right + left) / (right - left),
                             0, 2 / (top - bottom),                 0, -(top + bottom) / (top - bottom),
                             0,                  0, -2 / (far - near),     -(far + near) / (far - near),
                             0,                  0,                 0,                                1,
        ]);
    },
    multiplyMany: function(matrices) {
        if (matrices.length < 1)
            return Matrix.identity();

        return matrices.slice(1).reduce((result, matrix) => {
            return Matrix.multiply(matrix, result);
        }, matrices[0]);
    },
};

const F32 = Float32Array;

function lissajousGraph(canvas, sample_rate) {
    const gl = canvas.getContext('webgl', {
        premultipliedAlpha: false,
    });

    const sample_program = webglProgram(gl, `
        precision mediump float;

        #define DEG45 0.7853981

        attribute vec3 a_position;
        attribute vec2 signal_frame;
        attribute float a_frame_index;

        uniform float num_frames;
        uniform vec2 viewport_size;
        uniform float point_scale;
        uniform float graph_scale;
        uniform mat4 my_matrix;

        varying float draw_clipped;
        varying float time_decay;

        void main() {
            vec2 frame = signal_frame.yx * graph_scale;
            vec2 abs_frame = abs(frame);
            float max_sample = max(abs_frame.x, abs_frame.y);

            draw_clipped = min(1.0, floor(max_sample));
            time_decay = a_frame_index / (num_frames - 1.0);

            vec2 clipped = clamp(frame, vec2(-1.0), vec2(1.0));

            float z = time_decay * 2.0 - 1.0;
            vec3 final = vec3(clipped, z) + a_position * point_scale / 500.0;

            gl_PointSize = 2.0;
            gl_Position = my_matrix * vec4(final, 1.0);
        }
    `, `
        precision mediump float;

        varying float draw_clipped;
        varying float time_decay;

        uniform vec3 point_color;

        void main() {
            float alpha = time_decay * 0.5 + 0.5;

            float dc = draw_clipped;
            float no_dc = 1.0 - dc;

            float r = dc + no_dc * point_color.r;
            float g = no_dc * point_color.g;
            float b = no_dc * point_color.b;
            float a = alpha;

            gl_FragColor = vec4(r, g, b, a);
        }
    `, [
        'a_position',
        'signal_frame',
        'a_frame_index',
    ], [
        'viewport_size',
        'num_frames',
        'point_color',
        'point_scale',
        'graph_scale',
        'my_matrix',
    ]);

    const texture_program = webglProgram(gl, `
        precision mediump float;

        #define DEG45 0.7853981

        attribute vec2 a_position;
        varying vec2 tex_position;

        uniform mat4 my_matrix;

        void main() {
            tex_position = a_position * 0.5 + 0.5;
            gl_Position = my_matrix * vec4(a_position, 1.0, 1.0);
        }
    `, `
        precision mediump float;

        varying vec2 tex_position;
        uniform sampler2D texture;

        void main() {
            gl_FragColor = texture2D(texture, tex_position);
        }
    `, [
        'a_position',
    ], [
        'texture',
        'my_matrix',
    ]);

    const inst_ext = gl.getExtension('ANGLE_instanced_arrays');
    if (!inst_ext) alert('ANGLE_instanced_arrays not supported');

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);

    gl.cullFace(gl.BACK);
    gl.clearColor(0, 0, 0, 0);

    const vertex_accuracy = 10;
    const icosahedron = generateIcosahedron();
    const quad_vertices = new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]);

    gl.useProgram(sample_program.program);
    const vertex_buffer = gl.createBuffer();
    const index_buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertex_buffer);
    gl.bufferData(gl.ARRAY_BUFFER, icosahedron.vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index_buffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, icosahedron.indices, gl.STATIC_DRAW);

    const quad_buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad_buffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad_vertices, gl.STATIC_DRAW);

    const frame_index_buffer = gl.createBuffer();

    const texture = loadTexture(gl, `data:image/png;base64,${window.uiImage}`);

    const ring = {
        buffer: gl.createBuffer(),
        max_capacity: 0,
        allocated: 0,
        write_head: 0,
        read_head: 0,
    };

    const state = {
        destroy: function() {
            canvas.parentElement.removeChild(canvas);
            window.removeEventListener('resize', onWindowResize);
        },
        onResize: function() {
            const bounds = canvas.getBoundingClientRect();
            const dpi = window.devicePixelRatio;

            canvas.width = bounds.width * dpi;
            canvas.height = bounds.height * dpi;

            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

            gl.useProgram(sample_program.program);
            gl.uniform2f(sample_program.uniforms.viewport_size, canvas.width, canvas.height);

            state.updateProjection();
        },
        setRingSize: function(num_frames) {
            const num_samples = num_frames * 2;

            if (num_samples > ring.allocated) {
                const byte_size = byteCount(F32, num_samples);

                gl.bindBuffer(gl.ARRAY_BUFFER, ring.buffer),
                gl.bufferData(gl.ARRAY_BUFFER, byte_size, gl.DYNAMIC_DRAW);

                ring.allocated = num_samples;

                const frame_index_array = new Float32Array(num_frames);

                for (let i = 0; i < num_frames; i++) {
                    frame_index_array[i] = i;
                }

                gl.bindBuffer(gl.ARRAY_BUFFER, frame_index_buffer);
                gl.bufferData(gl.ARRAY_BUFFER, frame_index_array, gl.STATIC_DRAW);
            }

            ring.max_capacity = num_samples;
            ring.write_head %= ring.max_capacity;
            ring.read_head = 0;
        },
        resetRing: function() {
            ring.write_head = ring.read_head = 0;
        },
        updateRing: function(samples) {
            let data = samples;

            // By ignoring data that won't be written anyways we have
            // to do 2 bufferSubData calls at most.
            if (data.length > ring.max_capacity) {
                data = data.slice(data.length - ring.max_capacity);
                console.debug('Dropped', samples.length - data.length, 'samples');
            }

            gl.bindBuffer(gl.ARRAY_BUFFER, ring.buffer);

            if (ring.max_capacity <= 0) {
                throw new Error('Invalid Ring Buffer Size');
            }

            while (data.length > 0) {
                const required = data.length;
                const write_head = ring.write_head % ring.max_capacity;
                const space_left = ring.max_capacity - write_head;

                const actual_length = Math.min(required, space_left);
                const able_to_write = data.slice(0, actual_length);
                data = data.slice(actual_length);

                const byte_offset = byteCount(F32, write_head);
                gl.bufferSubData(gl.ARRAY_BUFFER, byte_offset, able_to_write);

                ring.write_head += actual_length;

                if (ring.write_head - ring.read_head > ring.max_capacity)
                    ring.read_head = ring.write_head - ring.max_capacity;
            }
        },
        render: function() {
            state.updateProjection();
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

            const num_frames = ring.max_capacity / 2;
            const read_head = ring.read_head % ring.max_capacity;
            const first_samples = ring.max_capacity - read_head;

            gl.enable(gl.CULL_FACE);
            gl.useProgram(sample_program.program);
            gl.uniform1f(sample_program.uniforms.num_frames, num_frames);

            if (ring.write_head - ring.read_head < ring.max_capacity) {
                const x = ring.write_head;
                state.renderRing(0, (ring.max_capacity - x) / 2, x);
            } else {
                state.renderRing(read_head, 0, first_samples);
                state.renderRing(0, first_samples / 2, read_head);
            }

            if (!state.hide_ui) {
                gl.useProgram(texture_program.program);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.disable(gl.CULL_FACE);
                state.renderMeta();
            }
        },
        renderRing: function(sample_offset, index_offset, num_samples) {
            gl.bindBuffer(gl.ARRAY_BUFFER, ring.buffer);
            gl.enableVertexAttribArray(sample_program.attribs.signal_frame);
            gl.vertexAttribPointer(sample_program.attribs.signal_frame, 2, gl.FLOAT, false, byteCount(F32, 2), byteCount(F32, sample_offset));
            inst_ext.vertexAttribDivisorANGLE(sample_program.attribs.signal_frame, 1);

            gl.bindBuffer(gl.ARRAY_BUFFER, frame_index_buffer);
            gl.enableVertexAttribArray(sample_program.attribs.a_frame_index);
            gl.vertexAttribPointer(sample_program.attribs.a_frame_index, 1, gl.FLOAT, false, byteCount(F32, 1), byteCount(F32, index_offset));
            inst_ext.vertexAttribDivisorANGLE(sample_program.attribs.a_frame_index, 1);

            gl.bindBuffer(gl.ARRAY_BUFFER, vertex_buffer);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index_buffer);
            gl.enableVertexAttribArray(sample_program.attribs.a_position);
            gl.vertexAttribPointer(sample_program.attribs.a_position, 3, gl.FLOAT, false, 0, 0);

            inst_ext.drawElementsInstancedANGLE(gl.TRIANGLES, icosahedron.indices.length, gl.UNSIGNED_SHORT, 0, num_samples / 2);
        },
        renderMeta: function() {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.uniform1i(texture_program.uniforms.texture, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, quad_buffer);
            gl.enableVertexAttribArray(texture_program.attribs.a_position);
            gl.vertexAttribPointer(texture_program.attribs.a_position, 2, gl.FLOAT, false, 0, 0);
            inst_ext.vertexAttribDivisorANGLE(texture_program.attribs.a_position, 0);

            gl.drawArrays(gl.TRIANGLE_FAN, 0, quad_vertices.length / 2);
        },
        setPointSize: function(size) {
            gl.useProgram(sample_program.program);
            gl.uniform1f(sample_program.uniforms.point_scale, size);
        },
        setPointColor: function(r, g, b) {
            gl.useProgram(sample_program.program);
            gl.uniform3f(sample_program.uniforms.point_color, r, g, b);
        },
        setGraphScale: function(scale_factor) {
            gl.useProgram(sample_program.program);
            gl.uniform1f(sample_program.uniforms.graph_scale, scale_factor);
        },

        hide_ui: false,
        rotation: { x: 0, y: 0 },
        zoom: 1,
        projection_type: 'perspective',

        updateProjection: function() {
            let projection;

            if (state.projection_type === 'orthographic') {
                const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
                const top = -0.5;
                const bottom = 0.5;

                const left = top * aspect;
                const right = bottom * aspect;

                projection = Matrix.orthographic(left, right, top, bottom, 0, 10);
            } else {
                projection = Matrix.perspective(70, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.0001, 100);
            }

            const matrix = Matrix.multiplyMany([
                Matrix.scale(state.zoom, state.zoom, state.zoom),
                Matrix.rotateZ(-Math.PI / 4),
                Matrix.rotateY(state.rotation.x),
                Matrix.rotateX(state.rotation.y),
                Matrix.translate(0, 0, -4),
                projection,
            ]);

            gl.useProgram(sample_program.program);
            gl.uniformMatrix4fv(sample_program.uniforms.my_matrix, false, matrix);

            gl.useProgram(texture_program.program);
            gl.uniformMatrix4fv(texture_program.uniforms.my_matrix, false, matrix);

        },
    };

    const onWindowResize = debounce(state.onResize, 250);
    window.addEventListener('resize', onWindowResize);

    state.setPointSize(1);
    state.setGraphScale(1);
    state.setRingSize(8192);
    state.onResize();

    return state;
}

function generateIcosahedron() {
    let vertices = new Float32Array(12 * 3);

    vertices[0] = vertices[33] = 0;
    vertices[1] = vertices[34] = 0;
    vertices[2] = 1;
    vertices[35] = -1;

    for (let i = 0; i < 10; i++) {
        const progress = (i % 5) / 5;
        const idx = 3 + i * 3;
        const phase = Math.floor(i / 5) * Math.PI * 2 / 10;

        const phi = phase + progress * Math.PI * 2;
        const theta = Math.PI / 3 + Math.floor(i / 5) * Math.PI / 3;

        vertices[idx] = Math.sin(theta) * Math.cos(phi);
        vertices[idx + 1] = Math.sin(theta) * Math.sin(phi);
        vertices[idx + 2] = Math.cos(theta);
    }

    return {
        vertices,
        indices: new Uint16Array([
            0,  1,  2,
            0,  2,  3,
            0,  3,  4,
            0,  4,  5,
            0,  5,  1,

            5, 4, 9,
            5, 9, 10,
            4, 3, 8,
            4, 8, 9,
            3, 2, 7,
            3, 7, 8,
            6, 2, 1,
            2, 6, 7,

            1, 5, 10,
            6, 1, 10,

            11, 10, 9,
            11, 9,  8,
            11, 8,  7,
            11, 7,  6,
            11, 6, 10,
        ]),
    };

    return vertices;
}

function webglProgram(gl, vertex_source, fragment_source, lookup_attribs, lookup_uniforms) {
    const vshader = gl.createShader(gl.VERTEX_SHADER);
    const fshader = gl.createShader(gl.FRAGMENT_SHADER);
    const program = gl.createProgram();

    gl.shaderSource(vshader, vertex_source);
    gl.compileShader(vshader);

    gl.shaderSource(fshader, fragment_source);
    gl.compileShader(fshader);

    if (!gl.getShaderParameter(vshader, gl.COMPILE_STATUS))
        console.error(gl.getShaderInfoLog(vshader));

    if (!gl.getShaderParameter(fshader, gl.COMPILE_STATUS))
        console.error(gl.getShaderInfoLog(fshader));

    gl.attachShader(program, fshader);
    gl.attachShader(program, vshader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        console.error(gl.getProgramInfoLog(program));

    let attribs = {};
    let uniforms = {};

    lookup_attribs.forEach(name => attribs[name] = gl.getAttribLocation(program, name));
    lookup_uniforms.forEach(name => uniforms[name] = gl.getUniformLocation(program, name));

    return {
        vshader,
        fshader,
        program,
        attribs,
        uniforms,
    };
}

function loadTexture(gl, url) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);

    const pixel = new Uint8Array([255, 0, 0, 255]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

    const img = new Image(url);
    img.onload = () => {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

        gl.generateMipmap(gl.TEXTURE_2D);
    };

    img.src = url;
    return texture;
}

function debounce(f, t) {
    let timeout = undefined;

    return function() {
        const args = [f, t].concat(Array.from(arguments));
        clearTimeout(timeout);
        timeout = setTimeout.apply(window, args);
    };
}

function byteCount(T, count) {
    return count * T.BYTES_PER_ELEMENT;
}
