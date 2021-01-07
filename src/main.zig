const std = @import("std");
const allocator = std.heap.page_allocator;

extern "debug" fn js_err(ptr: [*]const u8, len: usize) void;
extern "debug" fn js_log(ptr: [*]const u8, len: usize) void;

pub fn panic(err: []const u8, maybe_trace: ?*std.builtin.StackTrace) noreturn {
    js_err(err.ptr, err.len);
    while (true) @breakpoint();
}

pub fn log(
    comptime level: std.log.Level,
    comptime scope: @TypeOf(.EnumLiteral),
    comptime fmt: []const u8,
    args: anytype,
) void {
    // This is copied from the default log implementation in the standard library.
    const level_txt = switch (level) {
        .emerg => "emergency",
        .alert => "alert",
        .crit => "critical",
        .err => "error",
        .warn => "warning",
        .notice => "notice",
        .info => "info",
        .debug => "debug",
    };
    const prefix2 = if (scope == .default) ": " else "(" ++ @tagName(scope) ++ "): ";
    const format = level_txt ++ prefix2 ++ fmt;

    const log_buffer = std.fmt.allocPrint(allocator, format, args) catch |err| {
        const emerg_msg = "Failed to format log message";
        js_err(emerg_msg, emerg_msg.len);
        return;
    };

    defer allocator.free(log_buffer);
    js_log(log_buffer.ptr, log_buffer.len);
}

var param_buffer: ?[]f32 = null;

var input_buffer: ?[]f32 = null;
var output_buffer: ?[]f32 = null;

export fn js_getInputBuffer(num_samples: usize) [*]f32 {
    if (input_buffer == null) {
        input_buffer = allocator.alloc(f32, num_samples) catch unreachable;
        return input_buffer.?.ptr;
    }

    if (input_buffer.?.len != num_samples) {
        input_buffer = allocator.realloc(input_buffer.?, num_samples) catch unreachable;
    }

    return input_buffer.?.ptr;
}

export fn js_getParamBuffer(num_samples: usize) [*]f32 {
    if (param_buffer == null) {
        param_buffer = allocator.alloc(f32, num_samples) catch unreachable;
        return param_buffer.?.ptr;
    }

    if (param_buffer.?.len != num_samples) {
        param_buffer = allocator.realloc(param_buffer.?, num_samples) catch unreachable;
    }

    return param_buffer.?.ptr;
}

export fn js_process(num_frames: usize, num_params: usize) [*]f32 {
    var num_samples = num_frames * 2;

    if (output_buffer == null) {
        output_buffer = allocator.alloc(f32, num_samples) catch unreachable;
    } else if (output_buffer.?.len != num_samples) {
        output_buffer = allocator.realloc(output_buffer.?, num_samples) catch unreachable;
    }

    const params = param_buffer.?;

    const in = input_buffer.?;
    var out = output_buffer.?;
    var index: usize = 0;

    while (index < num_frames) : (index += 1) {
        const left_idx = index;
        const right_idx = num_frames + index;

        const left = in[left_idx];
        const right = in[right_idx];

        const ms_factor = std.math.sqrt1_2;

        var mid = (left + right) * ms_factor;
        var side = (left - right) * ms_factor;

        const balance = if (num_params == 1) params[0] else params[index];

        mid *= 1 - (balance * 0.5 + 0.5);
        side *= balance * 0.5 + 0.5;

        out[left_idx] = (mid + side) * ms_factor;
        out[right_idx] = (mid - side) * ms_factor;
    }

    return out.ptr;
}
