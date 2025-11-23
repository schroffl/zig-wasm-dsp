const Matrix = {
    identity: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    rotateZ: (angle) =>
        new Float32Array([
            Math.cos(angle),
            -Math.sin(angle),
            0,
            0,
            Math.sin(angle),
            Math.cos(angle),
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
        ]),
    rotateY: (angle) =>
        new Float32Array([
            Math.cos(angle),
            0,
            -Math.sin(angle),
            0,
            0,
            1,
            0,
            0,
            Math.sin(angle),
            0,
            Math.cos(angle),
            0,
            0,
            0,
            0,
            1,
        ]),
    rotateX: (angle) =>
        new Float32Array([
            1,
            0,
            0,
            0,
            0,
            Math.cos(angle),
            -Math.sin(angle),
            0,
            0,
            Math.sin(angle),
            Math.cos(angle),
            0,
            0,
            0,
            0,
            1,
        ]),
    scale: (x, y, z) => new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]),
    translate: (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]),
    multiply: (a, b) => {
        const out = new Float32Array(16);

        for (let i = 0; i < 16; i++) {
            const row = Math.floor(i / 4);
            const column = i % 4;

            out[i] =
                a[column] * b[row * 4] +
                a[column + 4] * b[row * 4 + 1] +
                a[column + 8] * b[row * 4 + 2] +
                a[column + 12] * b[row * 4 + 3];
        }

        return out;
    },
    perspective: (fov, aspectRatio, near, far) => {
        const fovRad = (fov * Math.PI) / 180;
        const f = 1 / Math.tan(fovRad / 2);
        const rangeInv = 1 / (near - far);

        return new Float32Array([
            f / aspectRatio,
            0,
            0,
            0,
            0,
            f,
            0,
            0,
            0,
            0,
            (near + far) * rangeInv,
            -1,
            0,
            0,
            near * far * rangeInv * 2,
            0,
        ]);
    },
    orthographic: (left, right, bottom, top, near, far) => {
        return new Float32Array([
            2 / (right - left),
            0,
            0,
            -(right + left) / (right - left),
            0,
            2 / (top - bottom),
            0,
            -(top + bottom) / (top - bottom),
            0,
            0,
            -2 / (far - near),
            -(far + near) / (far - near),
            0,
            0,
            0,
            1,
        ]);
    },
    multiplyMany: function (matrices) {
        if (matrices.length < 1) return Matrix.identity();

        return matrices.slice(1).reduce((result, matrix) => {
            return Matrix.multiply(matrix, result);
        }, matrices[0]);
    },
};

const F32 = Float32Array;

function generateIcosahedron() {
    let vertices = new Float32Array(12 * 3);

    vertices[0] = vertices[33] = 0;
    vertices[1] = vertices[34] = 0;
    vertices[2] = 1;
    vertices[35] = -1;

    for (let i = 0; i < 10; i++) {
        const progress = (i % 5) / 5;
        const idx = 3 + i * 3;
        const phase = (Math.floor(i / 5) * Math.PI * 2) / 10;

        const phi = phase + progress * Math.PI * 2;
        const theta = Math.PI / 3 + (Math.floor(i / 5) * Math.PI) / 3;

        vertices[idx] = Math.sin(theta) * Math.cos(phi);
        vertices[idx + 1] = Math.sin(theta) * Math.sin(phi);
        vertices[idx + 2] = Math.cos(theta);
    }

    return {
        vertices,
        indices: new Uint16Array([
            0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 1,

            5, 4, 9, 5, 9, 10, 4, 3, 8, 4, 8, 9, 3, 2, 7, 3, 7, 8, 6, 2, 1, 2, 6, 7,

            1, 5, 10, 6, 1, 10,

            11, 10, 9, 11, 9, 8, 11, 8, 7, 11, 7, 6, 11, 6, 10,
        ]),
    };

    return vertices;
}

function generateCircle(accuracy) {
    const vertices = new Float32Array(accuracy * 3);

    for (let i = 0; i < accuracy; i++) {
        const progress = i / accuracy;
        const angle = progress * Math.PI * 2;

        vertices[i * 3 + 0] = Math.cos(angle);
        vertices[i * 3 + 1] = Math.sin(angle);

        // The Z-Component is always 0 for the flat circle
        vertices[i * 3 + 2] = 0;
    }

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

    lookup_attribs.forEach((name) => (attribs[name] = gl.getAttribLocation(program, name)));
    lookup_uniforms.forEach((name) => (uniforms[name] = gl.getUniformLocation(program, name)));

    return {
        vshader,
        fshader,
        program,
        attribs,
        uniforms,
    };
}

function loadTexture(gl, url, tex_unit, generate_mipmap) {
    tex_unit = tex_unit === undefined ? gl.TEXTURE0 : tex_unit;
    gl.activeTexture(tex_unit);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);

    const pixel = new Uint8Array([255, 0, 0, 255]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

    const img = new Image(url);
    img.onload = () => {
        const current_tex_unit = gl.getParameter(gl.ACTIVE_TEXTURE);
        gl.activeTexture(tex_unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

        if (generate_mipmap) {
            gl.generateMipmap(gl.TEXTURE_2D);
        }

        gl.activeTexture(current_tex_unit);
    };

    img.src = url;
    return texture;
}

function debounce(f, t) {
    let timeout = undefined;

    return function () {
        const args = [f, t].concat(Array.from(arguments));
        clearTimeout(timeout);
        timeout = setTimeout.apply(window, args);
    };
}

function byteCount(T, count) {
    return count * T.BYTES_PER_ELEMENT;
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

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function humanizePercentage(value) {
    const p = value * 100;
    const str = (p == -0 ? 0 : p).toFixed(2);
    return str + '%';
}

function humanizeFrequency(value) {
    if (value >= 1000) {
        return (value / 1000).toFixed(2) + ' kHz';
    } else {
        return value.toFixed(2) + ' Hz';
    }
}

function humanizeDuration(duration) {
    if (typeof duration !== 'number' || isNaN(duration)) return '-';

    const seconds = Math.ceil(duration % 60)
        .toString()
        .padStart(2, '0');
    const minutes = Math.floor(duration / 60)
        .toString()
        .padStart(2, '0');

    return `${minutes}:${seconds}`;
}

function animationLoop(fn) {
    let id = undefined;
    const wrapper = (t) => {
        fn(t);
        id = requestAnimationFrame(wrapper);
    };

    return {
        start: () => id === undefined && requestAnimationFrame(wrapper),
        stop: () => (cancelAnimationFrame(id), (id = undefined)),
    };
}

function millisecondsToSamples(sample_rate, milliseconds) {
    return Math.ceil((milliseconds * sample_rate) / 1000);
}

function samplesToMilliseconds(sample_rate, samples) {
    return (samples * 1000) / sample_rate;
}
