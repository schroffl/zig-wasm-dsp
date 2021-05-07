const wasm_source = `data:application/octet-stream;base64,${window['zig-wasm-dsp']}`;
const wasm_promise = fetch(wasm_source).then(res => res.arrayBuffer());

const audio_elem = new Audio();
const AudioCtx = window['AudioContext'] || webkitAudioContext;
const audio_ctx = new AudioCtx();
const audio_source = audio_ctx.createMediaElementSource(audio_elem);
const gain_node = audio_ctx.createGain();

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

function onThemeChange(new_theme) {
    switch (new_theme) {
        case 'dark': {
            lissajous_pane.config.dots.color = { r: 0.572, g: 0.909, b: 0.266 };
            document.body.classList.add('dark-mode');
            document.body.classList.remove('light-mode');
            break;
        }

        case 'light': {
            lissajous_pane.config.dots.color = { r: 0.5, g: 0.2, b: 0.901 };
            document.body.classList.remove('dark-mode');
            document.body.classList.add('light-mode');
            break;
        }
    }
}

function onDpiChange() {
    lissajous_pane.onResize();
    waterfall_pane.onResize();
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
    lissajous_pane.config.hide_ui = ui_layer.classList.contains('hidden');
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

function cycleLissajousMode(reverse) {
    const modes = ['3d', '2d', 'heatmap'];
    const idx = modes.indexOf(lissajous_pane.config.mode);

    let next_idx = idx >= modes.length - 1 ? 0 : idx + 1;

    if (reverse) {
        next_idx = idx < 1 ? modes.length - 1 : idx - 1;
    }

    lissajous_pane.config.mode = modes[next_idx];
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
    '?': () => console.log('TODO: Show info dialog'),
    'Escape': () => document.activeElement && document.activeElement.blur(),
    'q': () => lissajous_pane.resetRing(),
    't': () => cycleLissajousMode(),
    'T': () => cycleLissajousMode(true),
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

light_toggle_button.addEventListener('click', () => {
    const has_dark_mode = document.body.classList.contains('dark-mode');
    onThemeChange(has_dark_mode ? 'light' : 'dark');
});

const window_keystate = CustomUI.trackKeystate(window);

const analyser_node = audio_ctx.createAnalyser();
analyser_node.fftSize = 2048;
analyser_node.smoothingTimeConstant = 0.1;

const fft_data = new Float32Array(analyser_node.frequencyBinCount);
const waterfall_pane = new WaterfallPane(audio_ctx.sampleRate, analyser_node.frequencyBinCount);
const lissajous_pane = new LissajousPane();

let last_render = 0;

const loop = animationLoop(t => {
    const dt = t - last_render;
    last_render = t;

    if (!audio_elem.paused) {
        analyser_node.getFloatFrequencyData(fft_data);
        waterfall_pane.update(fft_data);
    }

    lissajous_pane.render();
    waterfall_pane.render();
});

if (window.matchMedia) {
    const theme_query = window.matchMedia('(prefers-color-scheme: dark)');
    const dpi_query = window.matchMedia('screen and (min-resolution: 2dppx)');

    if (typeof theme_query.addEventListener === 'function') {
        theme_query.addEventListener('change', e => {
            onThemeChange(e.matches ? 'dark' : 'light');
        });

        dpi_query.addEventListener('change', e => onDpiChange());

        onThemeChange(theme_query.matches ? 'dark' : 'light');
    } else {
        let cache = {
            dpi_matched: dpi_query.matches,
            theme_matched: undefined,
        };

        const f = () => {
            const dpi_matches = dpi_query.matches;
            const theme_matches = theme_query.matches;

            if (dpi_matches !== cache.dpi_matched) {
                onDpiChange();
            }

            if (theme_matches !== cache.theme_matched) {
                onThemeChange(theme_matches ? 'dark' : 'light');
            }

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

let logged_size = false;

createProcessorNode(buffer => {
    if (!logged_size) {
        console.debug('Audio buffer size:', buffer.length);
        logged_size = true;
    }

    if (!audio_elem.paused) {
        lissajous_pane.update(buffer);
    }
}).then(processor => {
    audio_source.connect(gain_node);
    gain_node.connect(processor.node);
    processor.node.connect(audio_ctx.destination);
    setProcessorParam = processor.setParam;
    custom_node = processor.node;

    custom_node.connect(analyser_node);
});

const main_elem = document.querySelector('main');
main_elem.insertBefore(waterfall_pane.element, main_elem.firstElementChild);
main_elem.insertBefore(lissajous_pane.element, main_elem.firstElementChild);

waterfall_pane.onResize();
lissajous_pane.onResize();

window.addEventListener('resize', debounce(() => {
    waterfall_pane.onResize();
    lissajous_pane.onResize();
}, 200));
