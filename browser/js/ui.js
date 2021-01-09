function getClientCoords(e, is_touch) {
    if (is_touch) {
        return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else {
        return { x: e.clientX, y: e.clientY };
    }
}

const CustomUI = {
    prevent_text_selection: false,
    knob: function(elem, config) {
        const indicator = document.createElement('div');
        const label_group = document.createElement('div');
        const human_text = document.createElement('span');
        const label = document.createElement('span');
        label.innerText = config.label;

        let knob_state = {
            config: config,
            value: config.initial,
            increment: function(percentage, relative_to) {
                const range = config.max - config.min;
                const offset = range * percentage;
                relative_to = typeof relative_to === 'number' ? relative_to : knob_state.value;
                knob_state.set(relative_to + offset);
            },
            set: function(new_value) {
                let clamped = Math.min(config.max, Math.max(config.min, new_value));

                if (typeof config.map === 'function') {
                    clamped = config.map(clamped);
                }

                knob_state.value = clamped;
                CustomUI.nextFrame(knob_state.render);
                config.onChange(knob_state.value);
            },
            render: function() {
                const x = (knob_state.value - config.min) / (config.max - config.min);

                const rotate_min = -135;
                const rotate_max = 135;

                const angle = rotate_min + (rotate_max - rotate_min) * x;
                indicator.style.transform = `rotate(${angle}deg)`;

                if (typeof config.humanize === 'function') {
                    human_text.innerText = config.humanize(knob_state.value);
                } else {
                    human_text.innerText = knob_state.value;
                }
            },
            reset: function() {
                knob_state.set(config.initial);
            },
        };

        CustomUI.registerHotkeys(elem, {
            '0': () => knob_state.reset(),
            'ArrowDown': e => knob_state.increment(e.shiftKey ? -0.005 : -0.05),
            'ArrowUp': e => knob_state.increment(e.shiftKey ? 0.005 : 0.05),
        });

        indicator.addEventListener('wheel', e => {
            const percentage = e.shiftKey ? 0.005 : 0.05;

            e.preventDefault();
            knob_state.increment(percentage * -e.deltaY * 0.2);
        }, { passive: false });

        indicator.addEventListener('dblclick', e => knob_state.reset());

        let last_touch = undefined;

        indicator.addEventListener('touchstart', e => {
            elem.focus();

            if (last_touch !== undefined && e.timeStamp - last_touch < 300) {
                knob_state.reset();
            }

            last_touch = e.timeStamp;
        }, { passive: true });

        CustomUI.registerDragListener(indicator, {
            ref: {},
            onstart: (ref, e) => {
                ref.last_shift = e.shiftKey;
                ref.start_value = knob_state.value;
                document.querySelector('html').classList.add('is-adjusting-knob');
            },
            ondrag: (ref, coords, internal_start, e) => {
                if (ref.last_shift !== e.shiftKey) {
                    ref.start_value = knob_state.value;
                    ref.custom_mouse_start = coords;
                    ref.last_shift = e.shiftKey;
                }

                const start = ref.custom_mouse_start || internal_start;
                const diffY = start.y - coords.y;
                const full_rotation = e.shiftKey ? 10000 : 100;

                knob_state.increment(diffY / full_rotation, ref.start_value);

                e.stopPropagation();
                e.preventDefault();
            },
            onend: ref => {
                ref.custom_mouse_start = undefined;
                document.querySelector('html').classList.remove('is-adjusting-knob');
            },
        });

        knob_state.render();

        label_group.classList.add('labels');
        elem.classList.add('knob');
        indicator.classList.add('indicator');

        label_group.appendChild(label);
        label_group.appendChild(human_text);
        elem.appendChild(indicator);
        elem.appendChild(label_group);

        return knob_state;
    },
    slider: function(elem, config) {
        const progress_bar = document.createElement('div');
        const indicator = document.createElement('div');
        const slider_handle = document.createElement('div');

        const slider_state = {
            value: config.initial,
            set: function(new_value) {
                slider_state.setNoChange(new_value);
                config.onchange(slider_state.value);
            },
            setNoChange: function(new_value) {
                slider_state.value = Math.max(0, Math.min(1, new_value));
                CustomUI.nextFrame(slider_state.render);
            },
            render: function() {
                const percentage = `${slider_state.value * 100}%`;

                indicator.style.width = percentage;
                slider_handle.style.left = percentage;
            },
        };

        progress_bar.addEventListener('pointerdown', e => {
            const bounds = progress_bar.getBoundingClientRect();
            const value = (e.x - bounds.x) / bounds.width;

            const copy = new e.constructor(e.type, e);
            slider_handle.dispatchEvent(copy);

            slider_state.set(value);
        });

        CustomUI.registerDragListener(slider_handle, {
            ref: {},
            onstart: ref => {
                ref.listener = () => ref.bounds = progress_bar.getBoundingClientRect();
                window.addEventListener('resize', ref.listener);
                ref.listener();

                if (typeof config.ondragstart === 'function')
                    config.ondragstart();
            },
            ondrag: (ref, coords, start, e) => {
                const raw_value = (e.pageX - ref.bounds.x) / ref.bounds.width;
                slider_state.set(raw_value);
            },
            onend: ref => {
                window.removeEventListener('resize', ref);

                if (typeof config.ondragend === 'function')
                    config.ondragend();
            },
        });

        elem.classList.add('slider');
        progress_bar.classList.add('progress-bar');
        indicator.classList.add('progress-indicator');
        slider_handle.classList.add('slider-handle');

        progress_bar.appendChild(indicator);
        progress_bar.appendChild(slider_handle);
        elem.appendChild(progress_bar);

        slider_state.render();

        return slider_state;
    },
    registerDragListener: function(elem, config, add_no_touch_css) {
        let start = undefined;

        if (add_no_touch_css !== false)
            elem.classList.add('no-touch-action');

        elem.addEventListener('pointerdown', e => {
            if (!e.isPrimary)
                return;

            elem.focus();
            elem.setPointerCapture(e.pointerId);
            e.stopPropagation();

            start = { x: e.clientX, y: e.clientY };
            CustomUI.prevent_text_selection = true;

            if (typeof config.onstart === 'function')
                config.onstart(config.ref, e);
        }, { passive: false });

        elem.addEventListener('pointermove', e => {
            if (elem.hasPointerCapture(e.pointerId)) {
                const coords = { x: e.clientX, y: e.clientY };
                config.ondrag(config.ref, coords, start, e);
            }
        }, { passive: false });

        const stop_dragging = e => {
            if (elem.hasPointerCapture(e.pointerId)) {
                elem.releasePointerCapture(e.pointerId);
                start = undefined;
                CustomUI.prevent_text_selection = false;

                if (typeof config.onend === 'function')
                    config.onend(config.ref, e);
            }
        };

        elem.addEventListener('pointerup', stop_dragging);
        elem.addEventListener('pointercancel', stop_dragging);
    },
    registerHotkeys: function(elem, hotkey_map) {
        const execute = (key, e) => {
            const f = hotkey_map[key];

            if (typeof f === 'function') {
                e.stopPropagation();
                f(e);
            } else if (typeof f === 'string') {
                execute(f, e);
            }
        };

        elem.addEventListener('keydown', e => {
            if (e.key === ' ' || e.key === 'Enter') {
                const node_name = e.target.nodeName.toLowerCase();

                if (node_name === 'button' && e.target !== elem)
                    return;
            }

            execute(e.key, e);
        });
    },
    requestFullscreen: function(elem) {
        const f = elem.requestFullscreen || elem.webkitRequestFullscreen;
        f.call(elem);
    },
    exitFullscreen: function() {
        const f = document.exitFullscreen || document.webkitExitFullscreen;
        f.call(document);
    },
    trackKeystate: function(elem) {
        const map = {};

        elem.addEventListener('keydown', e => map[e.key] = true);
        elem.addEventListener('keyup', e => map[e.key] = false);

        return {
            isDown: key => Boolean(map[key]),
            multiplier: key => map[key] ? 1 : 0,
        };
    },

    next_frame_raf: undefined,
    next_frame_stack: [],
    nextFrame: function(f) {
        const stack = CustomUI.next_frame_stack;

        if (stack.indexOf(f) === -1)
            stack.push(f);

        if (CustomUI.next_frame_raf === undefined) {
            CustomUI.next_frame_raf = requestAnimationFrame(t => {
                CustomUI.next_frame_raf = undefined;

                while (stack.length > 0) {
                    const next = stack.pop();
                    next(t);
                }
            });
        }
    },
};

document.addEventListener('selectstart', e => {
    if (CustomUI.prevent_text_selection)
        e.preventDefault();
});
