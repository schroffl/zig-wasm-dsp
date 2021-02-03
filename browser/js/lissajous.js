class LissajousPane extends CanvasPane {

    constructor() {
        super();

        this.config = {
            hide_ui: false,
            rotation: { x: 0, y: 0 },
            zoom: 1,
            mode: '3d',
        };

        this.glSetup();

        CustomUI.registerDragListener(this.canvas, {
            ref: {},
            onstart: (ref, e) => {
                ref.elem = e.target;
                ref.x = this.config.rotation.x;
                ref.y = this.config.rotation.y;
            },
            ondrag: (ref, coords, start, e) => {
                const diffX = coords.x - start.x;
                const diffY = coords.y - start.y;
                const multiplier = 0.01;

                this.config.rotation.x = ref.x + diffX * multiplier;
                this.config.rotation.y = clamp(ref.y - diffY * multiplier, -Math.PI / 2, Math.PI / 2);
            },
            onend: ref => {
                document.exitPointerLock();
            },
        });

        this.canvas.addEventListener('wheel', e => {
            this.config.zoom -= e.deltaY * 0.008;
            this.config.zoom = clamp(this.config.zoom, 0.2, 50);

            e.preventDefault();
        }, { passive: false });

        this.setRingSize(8192);
        this.setGraphScale(1);
        this.setPointSize(1);
    }

    glSetup() {
        const gl = this.gl = this.canvas.getContext('webgl', {
            premultipliedAlpha: false,
        });

        this.sample_program = webglProgram(gl, `
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
                float alpha = time_decay * 0.3 + 0.7;

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

        this.texture_program = webglProgram(gl, `
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

        this.inst_ext = this.gl.getExtension('ANGLE_instanced_arrays');

        if (!this.inst_ext)
            alert('ANGLE_instanced_arrays not supported');

        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);

        gl.cullFace(gl.BACK);
        gl.clearColor(0, 0, 0, 0);

        this.icosahedron = generateIcosahedron();
        this.ico_vertex_buffer = gl.createBuffer();
        this.ico_index_buffer = gl.createBuffer();

        gl.bindBuffer(gl.ARRAY_BUFFER, this.ico_vertex_buffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.icosahedron.vertices, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ico_index_buffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.icosahedron.indices, gl.STATIC_DRAW);

        this.circle = generateCircle(10);
        this.circle_vertex_buffer = gl.createBuffer();

        gl.bindBuffer(gl.ARRAY_BUFFER, this.circle_vertex_buffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.circle, gl.STATIC_DRAW);

        this.quad_vertices = new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]);
        this.quad_buffer = gl.createBuffer();

        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad_buffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.quad_vertices, gl.STATIC_DRAW);

        this.frame_ico_index_buffer = gl.createBuffer();
        this.texture = loadTexture(gl, `data:image/png;base64,${window['graph-texture']}`);

        this.ring = {
            buffer: gl.createBuffer(),
            max_capacity: 0,
            allocated: 0,
            write_head: 0,
            read_head: 0,
        };
    }

    onResize() {
        super.onResize();

        const gl = this.gl;
        const cv = this.canvas;

        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

        gl.useProgram(this.sample_program.program);
        gl.uniform2f(this.sample_program.uniforms.viewport_size, cv.width, cv.height);
    }

    setRingSize(num_frames) {
        const gl = this.gl;
        const ring = this.ring;
        const num_samples = num_frames * 2;

        if (num_samples > ring.allocated) {
            const byte_size = byteCount(F32, num_samples);

            gl.bindBuffer(gl.ARRAY_BUFFER, ring.buffer);
            gl.bufferData(gl.ARRAY_BUFFER, byte_size, gl.DYNAMIC_DRAW);

            ring.allocated = num_samples;

            const frame_index_array = new Float32Array(num_frames);

            for (let i = 0; i < num_frames; i++) {
                frame_index_array[i] = i;
            }

            gl.bindBuffer(gl.ARRAY_BUFFER, this.frame_ico_index_buffer);
            gl.bufferData(gl.ARRAY_BUFFER, frame_index_array, gl.STATIC_DRAW);
        }

        ring.max_capacity = num_samples;
        ring.write_head %= ring.max_capacity;
        ring.read_head = 0;
    }

    resetRing() {
        this.ring.write_head = this.ring.read_head = 0;
    }

    update(samples) {
        const gl = this.gl;
        const ring = this.ring;

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
    }

    render() {
        const gl = this.gl;

        this.updateProjection();
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        this.renderFrames();

        if (!this.config.hide_ui) {
            this.renderGraph();
        }
    }

    renderFrames() {
        const gl = this.gl;
        const ring = this.ring;
        const sample_program = this.sample_program;

        const num_frames = ring.max_capacity / 2;
        const read_head = ring.read_head % ring.max_capacity;
        const first_samples = ring.max_capacity - read_head;

        gl.enable(gl.CULL_FACE);
        gl.depthFunc(gl.ALWAYS);
        gl.depthMask(true);
        gl.useProgram(sample_program.program);
        gl.uniform1f(sample_program.uniforms.num_frames, num_frames);

        if (ring.write_head - ring.read_head < ring.max_capacity) {
            const x = ring.write_head;
            this.renderRing(0, (ring.max_capacity - x) / 2, x);
        } else {
            this.renderRing(read_head, 0, first_samples);
            this.renderRing(0, first_samples / 2, read_head);
        }
    }

    renderRing(sample_offset, index_offset, num_samples) {
        const gl = this.gl;
        const ring = this.ring;
        const inst_ext = this.inst_ext;
        const sample_program = this.sample_program;

        gl.bindBuffer(gl.ARRAY_BUFFER, ring.buffer);
        gl.enableVertexAttribArray(sample_program.attribs.signal_frame);
        gl.vertexAttribPointer(sample_program.attribs.signal_frame, 2, gl.FLOAT, false, byteCount(F32, 2), byteCount(F32, sample_offset));
        inst_ext.vertexAttribDivisorANGLE(sample_program.attribs.signal_frame, 1);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.frame_ico_index_buffer);
        gl.enableVertexAttribArray(sample_program.attribs.a_frame_index);
        gl.vertexAttribPointer(sample_program.attribs.a_frame_index, 1, gl.FLOAT, false, byteCount(F32, 1), byteCount(F32, index_offset));
        inst_ext.vertexAttribDivisorANGLE(sample_program.attribs.a_frame_index, 1);

        const instance_count = num_samples / 2;

        if (this.config.mode === '3d') {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.ico_vertex_buffer);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ico_index_buffer);
            gl.enableVertexAttribArray(sample_program.attribs.a_position);
            gl.vertexAttribPointer(sample_program.attribs.a_position, 3, gl.FLOAT, false, 0, 0);

            inst_ext.drawElementsInstancedANGLE(gl.TRIANGLES, this.icosahedron.indices.length, gl.UNSIGNED_SHORT, 0, instance_count);
        } else {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.circle_vertex_buffer);
            gl.enableVertexAttribArray(sample_program.attribs.a_position);
            gl.vertexAttribPointer(sample_program.attribs.a_position, 3, gl.FLOAT, false, 0, 0);

            inst_ext.drawArraysInstancedANGLE(gl.TRIANGLE_FAN, 0, this.circle.length / 3, instance_count);
        }
    }

    renderGraph() {
        const gl = this.gl;
        const texture_program = this.texture_program;

        gl.useProgram(texture_program.program);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.CULL_FACE);
        gl.depthFunc(gl.LESS);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.uniform1i(texture_program.uniforms.texture, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad_buffer);
        gl.enableVertexAttribArray(texture_program.attribs.a_position);
        gl.vertexAttribPointer(texture_program.attribs.a_position, 2, gl.FLOAT, false, 0, 0);
        this.inst_ext.vertexAttribDivisorANGLE(texture_program.attribs.a_position, 0);

        gl.drawArrays(gl.TRIANGLE_FAN, 0, this.quad_vertices.length / 2);
    }

    setPointSize(size) {
        this.gl.useProgram(this.sample_program.program);
        this.gl.uniform1f(this.sample_program.uniforms.point_scale, size);
    }

    setPointColor(r, g, b) {
        this.gl.useProgram(this.sample_program.program);
        this.gl.uniform3f(this.sample_program.uniforms.point_color, r, g, b);
    }

    setGraphScale(scale_factor) {
        this.gl.useProgram(this.sample_program.program);
        this.gl.uniform1f(this.sample_program.uniforms.graph_scale, scale_factor);
    }

    updateProjection() {
        const gl = this.gl;
        const sample_program = this.sample_program;
        const texture_program = this.texture_program;
        const config = this.config;

        let matrix;

        if (config.mode === '3d') {
            matrix = Matrix.multiplyMany([
                Matrix.scale(config.zoom, config.zoom, config.zoom),
                Matrix.rotateZ(-Math.PI / 4),
                Matrix.rotateY(config.rotation.x),
                Matrix.rotateX(config.rotation.y),
                Matrix.translate(0, 0, -4),
                Matrix.perspective(70, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.0001, 100),
            ]);
        } else {
            const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
            const scale_x = 0.95;
            const scale_y = scale_x * aspect;

            matrix = Matrix.multiplyMany([
                Matrix.scale(Math.SQRT1_2, Math.SQRT1_2, 0),
                Matrix.rotateZ(-Math.PI / 4),
                Matrix.scale(scale_x, scale_y, 0),
                Matrix.translate(0, 0, -0.01),
            ]);
        }

        gl.useProgram(sample_program.program);
        gl.uniformMatrix4fv(sample_program.uniforms.my_matrix, false, matrix);

        gl.useProgram(texture_program.program);
        gl.uniformMatrix4fv(texture_program.uniforms.my_matrix, false, matrix);
    }

}
