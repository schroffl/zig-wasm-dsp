class LissajousPane extends CanvasPane {

    constructor() {
        super();

        this.config = {
            hide_ui: false,
            rotation: { x: 0, y: 0 },
            zoom: 1,
            mode: '3d',
            heatmap_overlay: false,
            graph_scale: 1,
            dots: {
                size: 1,
                color: { r: 0, g: 0, b: 0 },
            },
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
    }

    glSetup() {
        const gl = this.gl = this.canvas.getContext('webgl', {
            premultipliedAlpha: true,
            alpha: true,
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
            uniform float z_position;

            void main() {
                tex_position = a_position * 0.5 + 0.5;
                gl_Position = my_matrix * vec4(a_position, z_position, 1.0);
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
            'z_position',
        ]);

        this.inst_ext = this.gl.getExtension('ANGLE_instanced_arrays');

        if (!this.inst_ext)
            alert('ANGLE_instanced_arrays not supported');

        gl.enable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);

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
        this.texture = loadTexture(gl, `data:image/png;base64,${window['graph-texture']}`, gl.TEXTURE0, true);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        this.ring = {
            buffer: gl.createBuffer(),
            max_capacity: 0,
            allocated: 0,
            write_head: 0,
            read_head: 0,
        };

        this.heatmap = new HeatMapRenderer(gl, this.inst_ext, this.ring);
        this.heatmap_fb = gl.createFramebuffer();
        this.heatmap_tex = gl.createTexture();
        this.heatmap_size = 1024;

        this.updateHeatmapSize();

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.heatmap_fb);
        gl.bindTexture(gl.TEXTURE_2D, this.heatmap_tex);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.heatmap_tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    updateHeatmapSize() {
        const gl = this.gl;

        gl.bindTexture(gl.TEXTURE_2D, this.heatmap_tex);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.heatmap_size, this.heatmap_size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
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

        if (this.config.mode === 'heatmap') {
            this.heatmap.render(this.heatmap_fb, {
                viewport: {
                    width: this.heatmap_size,
                    height: this.heatmap_size,
                },
                graph_scale: this.config.graph_scale,
            });
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        switch (this.config.mode) {
            case 'heatmap': {
                gl.disable(gl.CULL_FACE);
                this.blitTexture(this.heatmap_tex, 0.9);

                if (this.config.heatmap_overlay) {
                    gl.enable(gl.CULL_FACE);
                    gl.cullFace(gl.BACK);
                    this.renderFrames();
                    gl.disable(gl.CULL_FACE);
                }

                if (!this.config.hide_ui) {
                    this.blitTexture(this.texture, 1.0);
                }

                break;
            }

            case '3d': {
                gl.enable(gl.CULL_FACE);
                gl.cullFace(gl.BACK);
                this.renderFrames();

                if (!this.config.hide_ui) {
                    gl.disable(gl.CULL_FACE);
                    this.blitTexture(this.texture, 1.0);
                }

                break;
            }

            case '2d': {
                gl.enable(gl.CULL_FACE);
                gl.cullFace(gl.BACK);
                this.renderFrames();

                if (!this.config.hide_ui) {
                    gl.disable(gl.CULL_FACE);
                    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                    this.blitTexture(this.texture, 1.0);
                }

                break;
            }

            default: {
                console.error(`I don't know how to render the mode ${this.config.mode}`);
            }
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
        gl.useProgram(sample_program.program);
        gl.uniform1f(sample_program.uniforms.num_frames, num_frames);
        gl.uniform2f(sample_program.uniforms.viewport_size, gl.drawingBufferWidth, gl.drawingBufferHeight);

        const config = this.config;
        gl.uniform1f(sample_program.uniforms.point_scale, config.dots.size);
        gl.uniform1f(sample_program.uniforms.graph_scale, config.graph_scale);

        const color = config.dots.color;
        gl.uniform3f(sample_program.uniforms.point_color, color.r, color.g, color.b);

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

    blitTexture(texture, z_position) {
        const gl = this.gl;
        const tex_program = this.texture_program;

        gl.useProgram(tex_program.program);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(tex_program.uniforms.texture, 0);

        z_position = typeof z_position === 'number' ? z_position : 0;
        gl.uniform1f(tex_program.uniforms.z_position, z_position);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad_buffer);
        gl.enableVertexAttribArray(tex_program.attribs.a_position);
        gl.vertexAttribPointer(tex_program.attribs.a_position, 2, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLE_FAN, 0, this.quad_vertices.length / 2);
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

class HeatMapRenderer {

    constructor(gl, inst_ext, ring) {
        this.gl = gl;
        this.inst_ext = inst_ext;
        this.ring = ring;

        this.config = {
            dots: {
                size: 0.01,
            },
            tonemapping: {
                gamma: 0.4,
                exposure: 1.1,
            },
            scale_y: 6 / 6,
            blur_offset: {
                x: 0.01,
                y: 0.01,
            },
        };

        this.program = webglProgram(gl, `
            precision mediump float;

            attribute vec2 vertex_pos, signal_frame;
            uniform vec2 viewport;
            uniform float dot_scale, graph_scale;
            varying vec2 tex_pos;

            void main() {
                vec2 resized = vertex_pos * dot_scale;
                vec2 position = signal_frame.yx * graph_scale + resized;
                tex_pos = vertex_pos;
                gl_Position = vec4(position, 0.0, 1.0);
            }
        `, `
            precision mediump float;
            varying vec2 tex_pos;

            #define SQRT2 1.414213

            void main() {
                float intensity = distance(tex_pos * 1.2, vec2(0));
                intensity = clamp(intensity, 0.0, 1.0);

                gl_FragColor = vec4(vec3(1.0), 1.0 - intensity);
            }
        `, [
            'vertex_pos',
            'signal_frame',
        ], [
            'viewport',
            'dot_scale',
            'graph_scale',
        ]);

        this.heat_program = webglProgram(gl, `
            precision mediump float;

            attribute vec2 vertex_pos;
            varying vec2 tex_pos;

            void main() {
                tex_pos = (vertex_pos + 1.0) / 2.0;
                gl_Position = vec4(vertex_pos, 0.0, 1.0);
            }
        `, `
            precision mediump float;

            varying vec2 tex_pos;
            uniform sampler2D texture, heatmap_scale;
            uniform float gamma, exposure, scale_y;
            uniform vec2 blur_offset;

            float reinhardToneMapping(float value) {
                value *= exposure / (1.0 + value / exposure);
                value = pow(value, 1.0 / gamma);
                return value;
            }

            void main() {
                vec2 offset = blur_offset;
                float intensity = 0.0;

                float corner = 0.0625;
                float adjacent = 0.125;
                float center = 0.25;

                intensity += texture2D(texture, tex_pos + vec2(-offset.x, -offset.y)).a * corner;
                intensity += texture2D(texture, tex_pos + vec2(0.0, -offset.y)).a * adjacent;
                intensity += texture2D(texture, tex_pos + vec2(offset.x, -offset.y)).a * corner;

                intensity += texture2D(texture, tex_pos + vec2(-offset.x, 0.0)).a * adjacent;
                intensity += texture2D(texture, tex_pos + vec2(0.0, 0.0)).a * center;
                intensity += texture2D(texture, tex_pos + vec2(offset.x, 0.0)).a * corner;

                intensity += texture2D(texture, tex_pos + vec2(-offset.x, offset.y)).a * corner;
                intensity += texture2D(texture, tex_pos + vec2(0.0, offset.y)).a * adjacent;
                intensity += texture2D(texture, tex_pos + vec2(offset.x, offset.y)).a * corner;

                intensity = reinhardToneMapping(intensity);

                float scale_pos = 1.0 - intensity;
                gl_FragColor = texture2D(heatmap_scale, vec2(scale_pos, scale_y));
            }
        `, [
            'vertex_pos',
        ], [
            'texture',
            'heatmap_scale',
            'gamma',
            'exposure',
            'scale_y',
            'blur_offset',
        ]);

        this.heatmap_scale_tex = loadTexture(gl, `data:image/png;base64,${window['heatmap-scale']}`, gl.TEXTURE1);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        this.sample_fb = gl.createFramebuffer();
        this.sample_tex = gl.createTexture();
        this.sample_fb_size = 256;

        const ext = gl.getExtension('OES_texture_float');
        if (!ext) alert('OES_texture_float not supported');

        const linear_ext = gl.getExtension('OES_texture_float_linear');
        if (!linear_ext) alert('OES_texture_float_linear not supported');
        const v = linear_ext ? gl.LINEAR : gl.NEAREST;

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sample_tex);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, v);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, v);

        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.sample_fb_size, this.sample_fb_size, 0, gl.RGBA, gl.FLOAT, null);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sample_fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sample_tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        const quad_vertices = new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]);
        this.quad_buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad_buffer);
        gl.bufferData(gl.ARRAY_BUFFER, quad_vertices, gl.STATIC_DRAW);
    }

    render(framebuffer, outer_config) {
        const gl = this.gl;
        const ring = this.ring;
        const p = this.program;
        const inst_ext = this.inst_ext;
        const config = this.config;

        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.FRONT);
        gl.enable(gl.BLEND);

        // Additive blending
        gl.blendFunc(gl.ONE, gl.ONE);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sample_fb);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(p.program);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad_buffer);
        gl.enableVertexAttribArray(p.attribs.vertex_pos);
        gl.vertexAttribPointer(p.attribs.vertex_pos, 2, gl.FLOAT, false, byteCount(F32, 2), 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, ring.buffer);
        gl.enableVertexAttribArray(p.attribs.signal_frame);
        gl.vertexAttribPointer(p.attribs.signal_frame, 2, gl.FLOAT, false, byteCount(F32, 2), 0);
        inst_ext.vertexAttribDivisorANGLE(p.attribs.signal_frame, 1);

        gl.uniform1f(p.uniforms.dot_scale, config.dots.size);
        gl.uniform1f(p.uniforms.graph_scale, outer_config.graph_scale);
        gl.uniform2f(p.uniforms.viewport, this.sample_fb_size, this.sample_fb_size);

        const instance_count = ring.max_capacity / 2;
        gl.viewport(0, 0, this.sample_fb_size, this.sample_fb_size);
        inst_ext.drawArraysInstancedANGLE(gl.TRIANGLE_FAN, 0, 4, instance_count);

        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.viewport(0, 0, outer_config.viewport.width, outer_config.viewport.height);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.heat_program.program);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sample_tex);
        gl.uniform1i(this.heat_program.uniforms.texture, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.heatmap_scale_tex);
        gl.uniform1i(this.heat_program.uniforms.heatmap_scale, 1);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad_buffer);
        gl.enableVertexAttribArray(this.heat_program.attribs.vertex_pos);
        gl.vertexAttribPointer(this.heat_program.attribs.vertex_pos, 2, gl.FLOAT, false, byteCount(F32, 2), 0);

        gl.uniform1f(this.heat_program.uniforms.gamma, config.tonemapping.gamma);
        gl.uniform1f(this.heat_program.uniforms.exposure, config.tonemapping.exposure);
        gl.uniform1f(this.heat_program.uniforms.scale_y, config.scale_y);
        gl.uniform2f(this.heat_program.uniforms.blur_offset, config.blur_offset.x, config.blur_offset.y);

        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    }

}
