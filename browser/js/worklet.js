let instance = undefined;

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

class ZigWasmProcessor extends AudioWorkletProcessor {

    constructor() {
        super();
        this.port.onmessage = this.onMessage.bind(this);
    }

    static get parameterDescriptors() {
        return [{
            name: 'midSideBalance',
            defaultValue: 0,
            minValue: -1,
            maxValue: 1,
            automationRate: 'a-rate',
        }];
    }

    initWasm(binary) {
        const _this = this;

        WebAssembly.instantiate(binary, {
            debug: {
                js_log: function(buf, len) {
                    const str = getString(_this.wasmInstance, buf, len);
                    console.log(str);
                },
                js_err: function(buf, len) {
                    const str = getString(_this.wasmInstance, buf, len);
                    console.error(str);
                },
            },
        }).then(inst => {
            inst.instance.exports.js_getParamBuffer(1);

            this.wasmInstance = inst.instance;
        });
    }

    onMessage(event) {
        switch (event.data.type) {
            case 'wasm-binary': {
                this.initWasm(event.data.data);
                break;
            }
            case 'set-param': {
                this.setParam(event.data.name, event.data.value);
                break;
            }
        }
    }

    setParam(name, value) {
        const inst = this.wasmInstance;
        if (!inst) return;

        const param_ptr = inst.exports.js_getParamBuffer(1);
        const param_buffer = deref(Float32Array, inst, param_ptr, 1);

        switch (name) {
            case 'mid-side-balance': param_buffer[0] = value; break;
        }
    }

    process(inputs, outputs, params) {
        const inst = this.wasmInstance;
        this.frame_count = this.frame_count || 0;

        if (!inst || inputs.length == 0 || inputs[0].length == 0) {
            return true;
        }

        const num_channels = outputs[0].length;
        const num_frames = outputs[0][0].length;
        const num_samples = num_channels * num_frames;

        const input_ptr = inst.exports.js_getInputBuffer(num_samples);
        const input_buffer = deref(Float32Array, inst, input_ptr, num_samples);

        if (inputs[0].length == 1) {
            input_buffer.set(inputs[0][0], 0);
            input_buffer.set(inputs[0][0], num_frames);
        } else if (inputs[0].length == 2) {
            input_buffer.set(inputs[0][0], 0);
            input_buffer.set(inputs[0][1], num_frames);
        } else {
            console.warn("Some input channels were ignored");
        }

        // const ms_balance_values = params.midSideBalance;
        // const ms_balance_ptr = inst.exports.js_getParamBuffer(ms_balance_values.length);
        // const ms_balance_buffer = deref(Float32Array, inst, ms_balance_ptr, ms_balance_values.length);
        // ms_balance_buffer.set(ms_balance_values, 0);

        const output_ptr = inst.exports.js_process(num_frames, 1);
        const output_buffer = deref(Float32Array, inst, output_ptr, num_frames * num_channels);

        for (let i = 0; i < num_channels; i++) {
            const raw_idx = i * num_frames;
            const source = output_buffer.slice(raw_idx, raw_idx + num_frames);
            outputs[0][i].set(source, 0);
        }

        this.port.postMessage(outputs[0]);

        return true;
    }

}

registerProcessor('zig-wasm', ZigWasmProcessor);
