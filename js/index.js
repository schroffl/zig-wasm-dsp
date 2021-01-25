const wasm_source = `data:application/octet-stream;base64,${window['zig-wasm-dsp']}`;
const wasm_promise = fetch(wasm_source).then(res => res.arrayBuffer());

const audio_elem = new Audio();
const AudioCtx = window['AudioContext'] || webkitAudioContext;
const audio_ctx = new AudioCtx();
const audio_source = audio_ctx.createMediaElementSource(audio_elem);

let setProcessorParam = (name, value) => console.debug(`${name} = ${value} was ignored`);
let custom_node = null;

function createProcessorNode(onBufferAvailable) {
    if (audio_ctx.audioWorklet) {
        return createWorkletNode(onBufferAvailable);
    } else {
        return createLegacyNode(onBufferAvailable);
    }
}

function createWorkletNode(onBufferAvailable) {
    const worklet_source = `data:application/javascript;base64,${window['worklet-wrapper']}`;

    return audio_ctx.audioWorklet.addModule(worklet_source).then(() => {
        const node = new AudioWorkletNode(audio_ctx, 'zig-wasm', {
            numberOfOutputs: 1,
            outputChannelCount: [2],
        });

        wasm_promise.then(binary => {
            node.port.postMessage({
                type: 'wasm-binary',
                data: binary,
            });
        });

        node.port.onmessage = e => {
            const left = e.data[0];
            const right = e.data[1];
            const split = new Float32Array(left.length * 2);

            for (let i = 0; i < left.length; i++) {
                split[2 * i] = left[i];
                split[2 * i + 1] = right[i];
            }

            onBufferAvailable(split);
        };

        return {
            node: node,
            setParam: (name, value) => {
                node.port.postMessage({
                    type: 'set-param',
                    name: name,
                    value: value,
                });
            },
        };
    });
}

function createLegacyNode(onBufferAvailable) {
    function getString(inst, ptr, len) {
        const slice = deref(Uint8Array, inst, ptr, len);
        let arr = [];

        for (let i = 0; i < slice.length; i++) {
            const char = String.fromCharCode(slice[i]);
            arr.push(char);
        }

        return arr.join('');
    }

    function deref(T, inst, ptr, len) {
        return new T(inst.exports.memory.buffer, ptr, len);
    }

    let wasm = undefined;

    return wasm_promise.then(wasm_binary => {
        return WebAssembly.instantiate(wasm_binary, {
            debug: {
                js_log: function(buf, len) {
                    const str = getString(wasm, buf, len);
                    console.log(str);
                },
                js_err: function(buf, len) {
                    const str = getString(wasm, buf, len);
                    console.error(str);
                },
            },
        })
    }).then(inst => {
        const params = {};
        const processor = audio_ctx.createScriptProcessor(1024, 2, 2);
        let lfo_sample = 0;
        let sample_rate = audio_ctx.sampleRate;
        let split = new Float32Array(processor.bufferSize * 2);

        wasm = inst.instance;

        processor.onaudioprocess = (e) => {
            const left = e.inputBuffer.getChannelData(0);
            const right = e.inputBuffer.getChannelData(1);

            const num_samples = left.length + right.length;
            const num_frames = e.target.bufferSize;

            const input_ptr = wasm.exports.js_getInputBuffer(num_samples);
            const input_buffer = deref(Float32Array, wasm, input_ptr, num_samples);

            input_buffer.set(left, 0);
            input_buffer.set(right, left.length);

            const output_ptr = wasm.exports.js_process(num_frames, 1);
            const output_buffer = deref(Float32Array, wasm, output_ptr, num_samples);

            e.outputBuffer.getChannelData(0).set(output_buffer.slice(0, num_frames));
            e.outputBuffer.getChannelData(1).set(output_buffer.slice(num_frames));

            const out_left = e.outputBuffer.getChannelData(0);
            const out_right = e.outputBuffer.getChannelData(1);

            for (let i = 0; i < out_left.length; i++) {
                split[i * 2] = out_left[i];
                split[i * 2 + 1] = out_right[i];
            }

            onBufferAvailable(split);
        };

        let self = {
            node: processor,
            setParam: (name, value) => {
                let params_ptr = wasm.exports.js_getParamBuffer(1);
                let params_buf = deref(Float32Array, wasm, params_ptr, 1);

                if (name === 'mid-side-balance') {
                    params_buf[0] = value;
                }
            },
        };

        self.setParam('mid-side-balance', 0);

        return self;
    });
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
    if (typeof duration !== 'number' || isNaN(duration))
        return '-';

    const seconds = Math.ceil(duration % 60).toString().padStart(2, '0');
    const minutes = Math.floor(duration / 60).toString().padStart(2, '0');

    return `${minutes}:${seconds}`;
}

function animationLoop(fn) {
    let id = undefined;
    const wrapper = t => {
        fn(t);
        id = requestAnimationFrame(wrapper);
    };

    return {
        start: () => id === undefined && requestAnimationFrame(wrapper),
        stop: () => (cancelAnimationFrame(id), id = undefined),
    };
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function onThemeChange(new_theme) {
    switch (new_theme) {
        case 'dark': {
            gl_lissajous.setPointColor(0.572, 0.909, 0.266);
            document.body.classList.add('dark-mode');
            document.body.classList.remove('light-mode');
            break;
        }

        case 'light': {
            gl_lissajous.setPointColor(0.5, 0.2, 0.901);
            document.body.classList.remove('dark-mode');
            document.body.classList.add('light-mode');
            break;
        }
    }
}

function millisecondsToSamples(sample_rate, milliseconds) {
    return Math.ceil(milliseconds * sample_rate / 1000);
}

function samplesToMilliseconds(sample_rate, samples) {
    return samples * 1000 / sample_rate;
}

let active_recording = null;

function beginRecording() {
    if (!custom_node)
        return;

    if (active_recording) {
        active_recording.rec.stop();
        active_recording = null;
        setRecordButtonActive(false);
        return;
    }

    const audio_recording_node = audio_ctx.createMediaStreamDestination();
    const audio_track = audio_recording_node.stream.getAudioTracks()[0];
    custom_node.connect(audio_recording_node);

    const video_stream = lissajous_canvas.captureStream();
    video_stream.addTrack(audio_track);

    const chunks = [];
    const rec = new MediaRecorder(video_stream, {
        mimeType: 'video/webm',
    });

    active_recording = {
        timestamp: Date.now(),
        rec: rec,
    };

    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = e => exportVideo(chunks, rec.mimeType);
    rec.start();
    setRecordButtonActive(true);
}

function exportVideo(chunks, mime) {
    const blob = new Blob(chunks, { mimeType: mime });
    const a = document.createElement('a');

    a.style.position = 'fixed';
    a.style.top = '-500px';
    a.style.bottom = '-500px';
    a.href = URL.createObjectURL(blob);
    a.name = a.download = 'recording.webm';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 1000);
}

function setRecordButtonActive(active) {
    if (active) {
        record_button.classList.add('is-recording');
    } else {
        record_button.classList.remove('is-recording');
    }
}

const time_slider_state = CustomUI.slider(time_slider, {
    was_paused: false,
    initial: 0,
    onchange: value => audio_elem.currentTime = audio_elem.duration * value,
    ondragstart: function() {
        this.was_paused = audio_elem.paused;
        audio_elem.pause();
    },
    ondragend: function() {
        if (!this.was_paused) {
            audio_elem.play();
        }
    },
});

audio_elem.addEventListener('timeupdate', e => {
    const progress = e.target.currentTime / e.target.duration;
    time_slider_state.setNoChange(progress);
    CustomUI.nextFrame(updateTimeProgress);
});

const updateTimeProgress = () => {
    const current = humanizeDuration(audio_elem.currentTime);
    const total = humanizeDuration(audio_elem.duration);

    const str = audio_elem.readyState < 2 ? '- / -' : `${current} / ${total}`
    time_progress.innerText = str;
};

audio_elem.addEventListener('play', e => play_button.classList.add('playing'));
audio_elem.addEventListener('pause', e => play_button.classList.remove('playing'));

play_button.addEventListener('click', () => {
    if (audio_elem.paused) {
        audio_elem.play();
    } else {
        audio_elem.pause();
    }
});

function selectFile(accept, onchange) {
    const file_input = document.createElement('input');
    file_input.type = 'file';
    file_input.accept = accept;
    file_input.style.position = 'fixed';
    file_input.style.left = '-500px';
    file_input.style.top = '-500px';

    const removeInput = () => file_input.parentElement && file_input.parentElement.removeChild(file_input);
    file_input.onchange = () => {
        removeInput();
        onchange(file_input.files);
    };

    const old_on_focus = document.body.onfocus;
    document.body.onfocus = e => {
        removeInput();
        document.body.onfocus = old_on_focus;

        if (typeof old_on_focus === 'function')
            old_on_focus(e);
    };

    document.body.appendChild(file_input);
    file_input.click();
}

function toggleUI() {
    const ui_layer = document.querySelector('.ui-layer');
    ui_layer.classList.toggle('hidden');
    gl_lissajous.hide_ui = ui_layer.classList.contains('hidden');
}

function toggleFullscreen() {
    const main = document.querySelector('main');

    if (document.fullscreen) {
        CustomUI.exitFullscreen();
    } else {
        CustomUI.requestFullscreen(main);
    }
}

function onUserUpload() {
    selectFile('audio/*', files => {
        const file = files[0];

        audio_elem.pause();
        window.URL.revokeObjectURL(audio_elem.src);

        audio_elem.src = window.URL.createObjectURL(file);
        audio_elem.pause();

        audio_elem.addEventListener('canplay', () => {
            audio_elem.play();
        }, { once: true });

        audio_ctx.resume();
    });
}

CustomUI.registerHotkeys(window, {
    'h': () => toggleUI(),
    'k': ' ',
    ' ': () => audio_elem.paused ? audio_elem.play() : audio_elem.pause(),
    'ArrowLeft': () => audio_elem.currentTime -= 5,
    'ArrowRight': () => audio_elem.currentTime += 5,
    'j': () => audio_elem.currentTime -= 10,
    'l': () => audio_elem.currentTime += 10,
    'f': () => toggleFullscreen(),
    'u': () => onUserUpload(),
    'ArrowUp': () => audio_elem.volume = clamp(audio_elem.volume + 0.1, 0, 1),
    'ArrowDown': () => audio_elem.volume = clamp(audio_elem.volume - 0.1, 0, 1),
    'r': () => beginRecording(),
    '?': () => console.log('TODO: Show info dialog'),
    'Escape': () => document.activeElement && document.activeElement.blur(),
    'p': () => {
        const current = gl_lissajous.projection_type;
        gl_lissajous.projection_type = current === 'perspective' ? 'orthographic' : 'perspective';
    },
    'q': () => gl_lissajous.resetRing(),
});

CustomUI.knob(mid_side_knob, {
    min: -1,
    max: 1,
    initial: 0,
    label: 'Mid / Side',
    humanize: humanizePercentage,
    onChange: value => setProcessorParam('mid-side-balance', value),
});

fullscreen_button.addEventListener('click', () => toggleFullscreen());
upload_button.addEventListener('click', () => onUserUpload());
record_button.addEventListener('click', () => beginRecording());
light_toggle_button.addEventListener('click', () => {
    const has_dark_mode = document.body.classList.contains('dark-mode');
    onThemeChange(has_dark_mode ? 'light' : 'dark');
});

const gl_lissajous = lissajousGraph(lissajous_canvas, audio_ctx.sampleRate);
const window_keystate = CustomUI.trackKeystate(window);

let last_render = 0;
let rotation_velocity = { x: 0, y: 0 };

let zoom_velocity = 0;

const loop = animationLoop(t => {
    const dt = t - last_render;
    last_render = t;

    const velocity = dt / 300;
    rotation_velocity.x *= 0.9;
    rotation_velocity.y *= 0.9;

    zoom_velocity *= 0.9;

    if (Math.abs(zoom_velocity) < 0.000001) {
        zoom_velocity = 0;
    }

    if (window_keystate.isDown('w')) {
        rotation_velocity.y = -velocity;
    } else if (window_keystate.isDown('s')) {
        rotation_velocity.y = velocity;
    } else if (window_keystate.isDown('a')) {
        rotation_velocity.x = velocity;
    } else if (window_keystate.isDown('d')) {
        rotation_velocity.x = -velocity;
    }

    gl_lissajous.rotation.y = clamp(gl_lissajous.rotation.y + rotation_velocity.y, -Math.PI / 2, Math.PI / 2);
    gl_lissajous.rotation.x += rotation_velocity.x;
    gl_lissajous.zoom = clamp(gl_lissajous.zoom + zoom_velocity * dt / 30, 0.2, 50);

    gl_lissajous.render();

    if (active_recording) {
        const duration = Date.now() - active_recording.timestamp;
        recording_duration.innerText = humanizeDuration(duration / 1000);
    }
});

CustomUI.registerDragListener(lissajous_canvas, {
    ref: {},
    onstart: (ref, e) => {
        ref.elem = e.target;
        ref.x = gl_lissajous.rotation.x;
        ref.y = gl_lissajous.rotation.y;
    },
    ondrag: (ref, coords, start, e) => {
        const diffX = coords.x - start.x;
        const diffY = coords.y - start.y;
        const multiplier = 0.01;

        gl_lissajous.rotation.x = ref.x + diffX * multiplier;
        gl_lissajous.rotation.y = clamp(ref.y - diffY * multiplier, -Math.PI / 2, Math.PI / 2);
    },
    onend: ref => {
        document.exitPointerLock();
    },
});

lissajous_canvas.addEventListener('wheel', e => {
    last_zoom = loop.timestamp;
    zoom_velocity -= e.deltaY * 0.0008;
    zoom_velocity = clamp(zoom_velocity, -1, 1);

    e.preventDefault();
}, { passive: false });

CustomUI.knob(analyser_gain_knob, {
    min: 0,
    max: 10,
    initial: 1,
    label: 'Lissajous Gain',
    humanize: humanizePercentage,
    onChange: value => gl_lissajous.setGraphScale(value),
}).reset();

CustomUI.knob(size_knob, {
    min: 0.5,
    max: 30,
    initial: 10,
    label: 'Point Size',
    humanize: x => x.toFixed(2),
    onChange: point_size => gl_lissajous.setPointSize(point_size),
}).reset();

CustomUI.knob(buffer_size_knob, {
    min: audio_ctx.sampleRate / 1000,
    max: audio_ctx.sampleRate * 10,
    initial: 8192,
    map: value => Math.round(value),
    label: 'Buffer Size',
    humanize: x => {
        const ms = samplesToMilliseconds(audio_ctx.sampleRate, x).toFixed(2);

        return `${x} Frames\n~${ms} ms    `;
    },
    onChange: debounce(onBufferSizeChange, 200),
}).reset();

function onBufferSizeChange(value) {
    gl_lissajous.setRingSize(value);
}

if (window.matchMedia) {
    const theme_query = window.matchMedia('(prefers-color-scheme: dark)');
    const dpi_query = window.matchMedia('screen and (min-resolution: 2dppx)');

    if (typeof theme_query.addEventListener === 'function') {
        theme_query.addEventListener('change', e => {
            onThemeChange(e.matches ? 'dark' : 'light');
        });

        dpi_query.addEventListener('change', e => {
            gl_lissajous.onResize();
        });

        onThemeChange(theme_query.matches ? 'dark' : 'light');
    } else {
        let cache = {
            dpi_matched: dpi_query.matches,
            theme_matched: undefined,
        };

        const f = () => {
            const dpi_matches = dpi_query.matches;
            const theme_matches = theme_query.matches;

            console.log(dpi_matches, theme_matches, cache);

            if (dpi_matches !== cache.dpi_matched)
                gl_lissajous.onResize();

            if (theme_matches !== cache.theme_matched)
                onThemeChange(theme_matches ? 'dark' : 'light');

            cache.dpi_matched = dpi_matches;
            cache.theme_matched = theme_matches;
            setTimeout(f, 3000);
        };

        f();
    }
} else {
    onThemeChange('light');
}

loop.start();
updateTimeProgress();

let rms = 0;
let logged_size = false;

createProcessorNode(buffer => {
    if (!logged_size) {
        console.debug('Audio buffer size:', buffer.length);
        logged_size = true;
    }

    if (!audio_elem.paused) {
        gl_lissajous.updateRing(buffer);

        let buffer_sum = 0;
        buffer.forEach(value => buffer_sum += value * value);
        rms *= 0.8;
        rms += Math.sqrt(buffer_sum / buffer.length) * 0.2;
    }
}).then(processor => {
    audio_source.connect(processor.node);
    processor.node.connect(audio_ctx.destination);
    setProcessorParam = processor.setParam;
    custom_node = processor.node;
});
