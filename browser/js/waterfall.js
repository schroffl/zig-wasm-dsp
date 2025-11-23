class WaterfallPane extends CanvasPane {
    constructor(sample_rate, bin_count) {
        super();

        this.sample_rate = sample_rate;
        this.bin_count = bin_count;

        this.db_bounds = {
            min: -50,
            max: 0,
        };

        this.config = {
            rotation: { x: Math.PI / 2, y: -1.5 },
            scale: { x: 5, y: 3, z: 5 },
            mode: '3d',
        };

        this.glSetup();

        CustomUI.registerDragListener(this.canvas, {
            ref: {},
            onstart: (ref, e) => {
                ref.x = this.config.rotation.x;
                ref.y = this.config.rotation.y;
            },
            ondrag: (ref, coords, start, e) => {
                const diffX = coords.x - start.x;
                const diffY = coords.y - start.y;
                const multiplier = 0.01;

                this.config.rotation.x = ref.x + diffX * multiplier;
                this.config.rotation.y = clamp(
                    ref.y - diffY * multiplier,
                    -Math.PI / 2,
                    Math.PI / 2,
                );
            },
        });
    }

    glSetup() {
        const gl = (this.gl = this.canvas.getContext('webgl', {
            premultipliedAlpha: false,
        }));

        const bin_count = this.bin_count;

        this.waterfall_program = webglProgram(
            gl,
            `
            precision highp float;

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
        `,
            `
            precision highp float;

            varying float volume, frequency;
            uniform sampler2D heat_scale;

            void main() {
                gl_FragColor = texture2D(heat_scale, vec2(1.0 - volume, 0.0));
            }
        `,
            ['a_position', 'a_normal'],
            ['proj_matrix', 'db_bounds', 'heat_scale'],
        );

        this.heatmap_scale_tex = loadTexture(
            gl,
            `data:image/png;base64,${window['heatmap-scale']}`,
            gl.TEXTURE0,
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.FRONT);

        this.mesh_buffer = gl.createBuffer();
        this.mesh_width = this.bin_count;
        this.mesh_depth = Math.floor(65535 / this.mesh_width);
        this.vertex_size = 3;
        this.mesh = new Float32Array(this.mesh_width * this.vertex_size * this.mesh_depth);

        console.debug('Mesh Size:', `${this.mesh_width}x${this.mesh_depth}`);

        const normal_buffer = gl.createBuffer();
        const normal_mesh = new Float32Array(this.mesh_width * 3 * this.mesh_depth);

        for (let i = 0; i < this.mesh.length / this.vertex_size; i++) {
            const z = Math.floor(i / this.mesh_width) / (this.mesh_depth - 1);

            // A small offset, because log(0) is not defined
            const p = Number.EPSILON;

            // The logarithmic scaling gives us very bad issues with z-fighting
            // in the upper frequencies. If I want to implement shading I will
            // have to find a way to fix it.
            // One approach would be to have a lower mesh resolution for higher
            // frequencies. For those parts we could take the average volume of
            // the surrounding bins.
            const log_x = mapValueLog(
                this.mesh_width - 1 - (i % this.mesh_width),
                0,
                this.mesh_width - 1,
                p,
                1 + p,
            );
            const x = (1.0 - log_x - p) * 2 - 1;

            this.mesh[i * this.vertex_size] = x;
            this.mesh[i * this.vertex_size + 1] = 0;
            this.mesh[i * this.vertex_size + 2] = z;
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh_buffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.mesh, gl.DYNAMIC_DRAW);

        // TODO The maximum amount of indices is limited by the Uint16Array, which
        //      only gives us 2^16 of them. If we want to display more vertices we
        //      need to render them in multiple batches.
        this.index_buffer = gl.createBuffer();
        const quad_count = (this.mesh_depth - 1) * (this.mesh_width - 1);
        this.index_count = quad_count * 2 * 3;
        const indices = new Uint16Array(this.index_count);

        for (let i = 0; i < quad_count; i++) {
            const row = Math.floor(i / (this.mesh_width - 1));
            const vertex_i = i + row;

            // First Face
            indices[i * 6] = vertex_i;
            indices[i * 6 + 1] = vertex_i + 1;
            indices[i * 6 + 2] = vertex_i + 1 + this.mesh_width;

            // Second Face
            indices[i * 6 + 3] = vertex_i;
            indices[i * 6 + 4] = vertex_i + 1 + this.mesh_width;
            indices[i * 6 + 5] = vertex_i + this.mesh_width;
        }

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.index_buffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    }

    onResize() {
        super.onResize();

        const gl = this.gl;
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }

    update(fft_data) {
        const mesh_width = this.mesh_width;
        const mesh_depth = this.mesh_depth;
        const vertex_size = this.vertex_size;
        const gl = this.gl;

        for (let i = 1; i < mesh_depth; i++) {
            for (let j = 0; j < mesh_width; j++) {
                const source_i = i * mesh_width * vertex_size + j * vertex_size + 1;
                const target_i = (i - 1) * mesh_width * vertex_size + j * vertex_size + 1;

                this.mesh[target_i] = this.mesh[source_i];
            }
        }

        for (let i = 0; i < mesh_width; i++) {
            const val = fft_data[i];
            const write_offset = mesh_width * (mesh_depth - 1) * vertex_size;
            this.mesh[write_offset + i * vertex_size + 1] = val;
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh_buffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.mesh, gl.DYNAMIC_DRAW);

        const db_bounds = this.db_bounds;

        gl.useProgram(this.waterfall_program.program);
        gl.uniform2f(this.waterfall_program.uniforms.db_bounds, db_bounds.min, db_bounds.max);
    }

    render() {
        const gl = this.gl;
        const config = this.config;
        const waterfall_program = this.waterfall_program;

        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(waterfall_program.program);

        let matrix;

        if (config.mode === '3d') {
            const scale = config.scale;

            matrix = Matrix.multiplyMany([
                Matrix.scale(scale.x, scale.y, scale.z),
                Matrix.rotateY(config.rotation.x),
                Matrix.rotateX(config.rotation.y),
                Matrix.translate(0, 0, -20),
                Matrix.perspective(70, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.0001, 30),
            ]);
        } else {
            matrix = Matrix.multiplyMany([Matrix.identity()]);
        }

        gl.uniformMatrix4fv(waterfall_program.uniforms.proj_matrix, false, matrix);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh_buffer);
        gl.enableVertexAttribArray(waterfall_program.attribs.a_position);
        gl.vertexAttribPointer(
            waterfall_program.attribs.a_position,
            3,
            gl.FLOAT,
            false,
            byteCount(F32, this.vertex_size),
            0,
        );

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.heatmap_scale_tex);
        gl.uniform1i(waterfall_program.uniforms.heat_scale, 0);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.index_buffer);
        gl.drawElements(gl.TRIANGLES, this.index_count, gl.UNSIGNED_SHORT, 0);
    }
}
